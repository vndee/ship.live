import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityEvent, FeedResponse } from "../../shared/types";
import { createDemoEvents } from "../lib/demo";

export function useFeed() {
  const [organization, setOrganization] = useState(
    () => localStorage.getItem("pulse.organization") || "",
  );
  const [suggestedOrg, setSuggestedOrg] = useState("");
  const [events, setEvents] = useState<ActivityEvent[]>(() =>
    localStorage.getItem("pulse.organization") ? [] : createDemoEvents(),
  );
  const [accessKey, setAccessKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [paused, setPaused] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(new Date().toISOString());
  const [streaming, setStreaming] = useState(false);
  const generation = useRef(0);
  const connectingRequest = useRef<AbortController | null>(null);
  const demo = !organization;

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((data) => {
        if (data.configuredOrg) setSuggestedOrg(data.configuredOrg);
      })
      .catch(() => {});
  }, []);

  const fetchFeed = useCallback(
    async (
      org: string,
      key: string,
      signal?: AbortSignal,
    ): Promise<FeedResponse> => {
      const response = await fetch(`/api/feed?org=${encodeURIComponent(org)}`, {
        headers: key ? { "x-dashboard-key": key } : {},
        signal: signal || AbortSignal.timeout(20_000),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          data.error || "Could not load GitHub activity. Try again.",
        );
      return data;
    },
    [],
  );

  const refresh = useCallback(async () => {
    if (demo) {
      setUpdatedAt(new Date().toISOString());
      return;
    }
    const current = generation.current;
    setLoading(true);
    try {
      const data = await fetchFeed(organization, accessKey);
      if (current !== generation.current) return;
      setEvents((previous) =>
        [
          ...new Map(
            [...previous, ...data.events].map((event) => [event.id, event]),
          ).values(),
        ]
          .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
          .slice(0, 2000),
      );
      setError("");
      setNotice(data.notice || "");
      setUpdatedAt(data.updatedAt);
    } catch (e) {
      if (current === generation.current)
        setError(
          e instanceof Error ? e.message : "Could not refresh activity.",
        );
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [demo, organization, accessKey, fetchFeed]);

  useEffect(() => {
    if (demo || paused) return;
    void refresh();
    const interval = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(interval);
  }, [demo, paused, refresh]);

  useEffect(() => {
    if (demo || paused) {
      setStreaming(false);
      return;
    }
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout>;
    async function stream() {
      try {
        const response = await fetch(
          `/api/events?org=${encodeURIComponent(organization)}`,
          {
            headers: accessKey ? { "x-dashboard-key": accessKey } : {},
            signal: controller.signal,
          },
        );
        if ([400, 401, 403].includes(response.status)) return;
        if (!response.ok || !response.body)
          throw new Error("Live stream unavailable");
        setStreaming(true);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done || controller.signal.aborted) break;
          buffer += decoder
            .decode(value, { stream: true })
            .replace(/\r\n/g, "\n");
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const chunk = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (!chunk.split("\n").some((line) => line === "event: activity"))
              continue;
            const json = chunk
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("\n");
            try {
              const event: ActivityEvent = JSON.parse(json);
              if (!event.id || !event.actor || !event.type) continue;
              setEvents((previous) =>
                [event, ...previous.filter((item) => item.id !== event.id)]
                  .sort(
                    (a, b) =>
                      Date.parse(b.occurredAt) - Date.parse(a.occurredAt),
                  )
                  .slice(0, 2000),
              );
              setUpdatedAt(new Date().toISOString());
            } catch {
              /* Ignore malformed messages and recover on next refresh. */
            }
          }
        }
      } catch {
        /* Polling remains available when the stream disconnects. */
      }
      if (!controller.signal.aborted) {
        setStreaming(false);
        retry = setTimeout(stream, 10_000);
      }
    }
    void stream();
    return () => {
      controller.abort();
      clearTimeout(retry);
      setStreaming(false);
    };
  }, [organization, accessKey, demo, paused]);

  async function connect(org: string, key: string) {
    const normalized = org
      .trim()
      .replace(/^https?:\/\/github\.com\/(?:orgs\/)?/i, "")
      .replace(/\/$/, "");
    if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(normalized))
      throw new Error("Enter a valid GitHub organization name.");
    connectingRequest.current?.abort();
    const controller = new AbortController();
    connectingRequest.current = controller;
    const data = await fetchFeed(
      normalized,
      key,
      AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
    );
    if (controller.signal.aborted || connectingRequest.current !== controller)
      throw new Error("Connection canceled.");
    connectingRequest.current = null;
    generation.current += 1;
    localStorage.setItem("pulse.organization", normalized);
    setOrganization(normalized);
    setAccessKey(key);
    setEvents(data.events);
    setError("");
    setNotice(data.notice || "");
    setUpdatedAt(data.updatedAt);
    setPaused(false);
  }
  function cancelConnection() {
    connectingRequest.current?.abort();
    connectingRequest.current = null;
  }
  function useDemo() {
    cancelConnection();
    generation.current += 1;
    localStorage.removeItem("pulse.organization");
    setOrganization("");
    setAccessKey("");
    setEvents(createDemoEvents());
    setError("");
    setNotice("");
    setLoading(false);
    setPaused(false);
    setUpdatedAt(new Date().toISOString());
  }
  return {
    organization,
    suggestedOrg,
    events,
    loading,
    error,
    notice,
    paused,
    setPaused,
    demo,
    updatedAt,
    streaming,
    refresh,
    connect,
    cancelConnection,
    useDemo,
  };
}
