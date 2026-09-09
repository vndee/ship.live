import { createHealthRefresh } from "../lib/health-refresh";
import { useEffect, useState } from "react";
import type { SharedHealthSnapshot } from "../../shared/health";

export function useSharedHealth(token: string) {
  const [scopeToken, setScopeToken] = useState(token);
  const [data, setData] = useState<SharedHealthSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let closed = false;
    let revoked = false;
    let sequence = 0;
    let expiresAt = Infinity;
    const scheduler = createHealthRefresh(refresh, {
      signal: controller.signal,
    });
    let retry: ReturnType<typeof setTimeout>;
    const fail = (message: string, permanent = false) => {
      if (closed) return;
      sequence++;
      setData(null);
      setConnected(false);
      setLoading(false);
      setError(message);
      if (permanent) {
        revoked = true;
        controller.abort();
        clearTimeout(retry);
      }
    };
    setScopeToken(token);
    setData(null);
    setLoading(true);
    setError("");
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      fail("This share link is invalid. Ask its creator for a new link.", true);
      return () => {
        closed = true;
      };
    }
    const headers = { "x-health-share": token };
    async function refresh(refreshSignal: AbortSignal) {
      if (closed || revoked) return;
      const serial = ++sequence;
      try {
        const response = await fetch("/api/shared/health", {
          headers,
          credentials: "omit",
          cache: "no-store",
          signal: AbortSignal.any([
            controller.signal,
            refreshSignal,
            AbortSignal.timeout(20000),
          ]),
        });
        if (closed || revoked || serial !== sequence) return;
        if (!response.ok) {
          fail(
            [401, 403, 404, 410].includes(response.status)
              ? "This share link has expired or been revoked. Ask its creator for a new link."
              : "Service health could not be verified. Reconnecting…",
            [401, 403, 404, 410].includes(response.status),
          );
          return;
        }
        const result: SharedHealthSnapshot = await response.json();
        if (closed || revoked || serial !== sequence) return;
        expiresAt = Date.parse(result.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
          fail(
            "This share link has expired. Ask its creator for a new link.",
            true,
          );
          return;
        }
        setData(result);
        setError("");
        setLoading(false);
      } catch {
        if (!closed && !revoked && serial === sequence)
          fail("Service health could not be verified. Reconnecting…");
      }
    }
    async function stream() {
      try {
        const response = await fetch("/api/shared/health/events", {
          headers,
          credentials: "omit",
          cache: "no-store",
          signal: controller.signal,
        });
        if (closed || revoked) return;
        if ([401, 403, 404, 410].includes(response.status)) {
          fail(
            "This share link has expired or been revoked. Ask its creator for a new link.",
            true,
          );
          return;
        }
        if (!response.ok || !response.body) throw new Error();
        setConnected(true);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!closed && !revoked) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 65536) throw new Error();
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (frame.includes("event: access-revoked")) {
              fail(
                "This share link has expired or been revoked. Ask its creator for a new link.",
                true,
              );
              return;
            }
            if (
              frame.includes("event: health") ||
              frame.includes("event: refresh")
            )
              scheduler.request();
          }
        }
      } catch {
        /* Polling continues to revalidate access while SSE reconnects. */
      }
      if (!closed && !revoked) {
        setConnected(false);
        scheduler.request();
        retry = setTimeout(() => void stream(), 5000);
      }
    }
    scheduler.request();
    void stream();
    const polling = setInterval(() => scheduler.request(), 15000);
    const expiry = setInterval(() => {
      if (!revoked && Date.now() >= expiresAt)
        fail(
          "This share link has expired. Ask its creator for a new link.",
          true,
        );
    }, 500);
    const hide = () => {
      sequence++;
      setData(null);
    };
    const show = () => scheduler.request();
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      closed = true;
      sequence++;
      controller.abort();
      clearInterval(polling);
      clearInterval(expiry);
      clearTimeout(retry);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
    };
  }, [token, attempt]);
  return {
    data: scopeToken === token ? data : null,
    error: scopeToken === token ? error : "",
    loading,
    connected,
    retry: () => setAttempt((value) => value + 1),
  };
}
