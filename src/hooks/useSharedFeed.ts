import { useEffect, useState } from "react";
import type { SharedFeedResponse } from "../../shared/shares";

export function useSharedFeed(token: string) {
  const [data, setData] = useState<SharedFeedResponse | null>(null);
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
    let fetching = false;
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
    setData(null);
    setLoading(true);
    setError("");
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      fail("This share link is invalid. Ask its creator for a new link.", true);
      return () => {
        closed = true;
      };
    }
    const headers = { "x-dashboard-share": token };
    async function refresh() {
      if (closed || revoked || fetching) return;
      fetching = true;
      const serial = ++sequence;
      try {
        const response = await fetch("/api/shared/feed", {
          headers,
          credentials: "omit",
          cache: "no-store",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(20000),
          ]),
        });
        if (closed || revoked || serial !== sequence) return;
        if (!response.ok) {
          fail(
            response.status === 410
              ? "This share link has expired or been revoked. Ask its creator for a new link."
              : "The dashboard could not be verified. Reconnecting…",
            response.status === 410,
          );
          return;
        }
        const result: SharedFeedResponse = await response.json();
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
          fail("The dashboard could not be verified. Reconnecting…");
      } finally {
        fetching = false;
      }
    }
    async function stream() {
      try {
        const response = await fetch("/api/shared/events", {
          headers,
          credentials: "omit",
          cache: "no-store",
          signal: controller.signal,
        });
        if (closed || revoked) return;
        if (response.status === 410) {
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
            if (frame.includes("event: refresh")) void refresh();
          }
        }
      } catch {
        /* Polling continues to revalidate access while SSE reconnects. */
      }
      if (!closed && !revoked) {
        setConnected(false);
        void refresh();
        retry = setTimeout(() => void stream(), 5000);
      }
    }
    void refresh();
    void stream();
    const polling = setInterval(() => void refresh(), 15000);
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
    const show = () => void refresh();
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
    data,
    error,
    loading,
    connected,
    retry: () => setAttempt((value) => value + 1),
  };
}
