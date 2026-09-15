import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  aggregatePulse,
  resolvePulseRange,
  type PulseOverview,
  type PulseSelection,
} from "../../shared/pulse";
import type { ActivityEvent } from "../../shared/types";

export interface PulseSource {
  workspaceId?: string;
  scopeKey?: string;
  shareToken?: string;
  demo: boolean;
  events: ActivityEvent[];
  /** Changes when authorized snapshots refresh, including access changes. */
  revision?: string;
  enabled: boolean;
}
const NAVIGATED = "ship-live:navigate";
function subscribe(callback: () => void) {
  window.addEventListener("popstate", callback);
  window.addEventListener(NAVIGATED, callback);
  return () => {
    window.removeEventListener("popstate", callback);
    window.removeEventListener(NAVIGATED, callback);
  };
}
export function usePulseLocation() {
  const search = useSyncExternalStore(subscribe, () => window.location.search);
  return useMemo(() => {
    const params = new URLSearchParams(search);
    return {
      selection: {
        period: (params.get("period") || "7d") as PulseSelection["period"],
        from: params.get("from") ?? undefined,
        to: params.get("to") ?? undefined,
      },
      history: params.get("view") === "activity",
      repo: params.get("repo") || "",
    };
  }, [search]);
}
export function setPulseLocation(
  selection: PulseSelection,
  history = false,
  repo?: string,
) {
  const url = new URL(window.location.href);
  for (const key of ["period", "from", "to", "view", "repo"])
    url.searchParams.delete(key);
  if (selection.period && selection.period !== "7d")
    url.searchParams.set("period", selection.period);
  if (selection.period === "custom") {
    url.searchParams.set("from", selection.from || "");
    url.searchParams.set("to", selection.to || "");
  }
  if (history) url.searchParams.set("view", "activity");
  if (repo) url.searchParams.set("repo", repo);
  if (url.href === window.location.href) return;
  window.history.pushState(null, "", url.pathname + url.search + url.hash);
  window.dispatchEvent(new Event(NAVIGATED));
}
export function pulseEndpoint(
  source: PulseSource,
  part: "overview" | "activity",
) {
  return source.shareToken
    ? `/api/shared/pulse/${part}`
    : `/api/workspaces/${encodeURIComponent(source.workspaceId || "")}/pulse/${part}`;
}
export async function fetchPulse<T>(
  source: PulseSource,
  path: string,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: source.shareToken
      ? { "x-dashboard-share": source.shareToken }
      : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || "Could not load this period. Try again.");
  return data as T;
}
export function usePulseOverview(
  source: PulseSource,
  selection: PulseSelection,
  now: number,
) {
  const day = new Date(now).toISOString().slice(0, 10);
  const parsed = useMemo(() => {
    try {
      return { range: resolvePulseRange(selection, now), error: "" };
    } catch (error) {
      return {
        range: null,
        error: error instanceof Error ? error.message : "Choose valid dates.",
      };
    }
  }, [selection.period, selection.from, selection.to, day]);
  const [retry, setRetry] = useState(0);
  const scope = `${source.scopeKey || ""}:${source.workspaceId || ""}:${source.shareToken || ""}:${source.enabled}`;
  const key = `${scope}:${parsed.range?.from}:${parsed.range?.to}`;
  const [state, setState] = useState<{
    key: string;
    data: PulseOverview | null;
    error: string;
    loading: boolean;
  }>({ key: "", data: null, error: "", loading: true });
  useEffect(() => {
    if (!parsed.range || source.demo || !source.enabled) return;
    const controller = new AbortController();
    setState({ key, data: null, error: "", loading: true });
    // Coalesce successive live snapshots without opening a second stream.
    const timer = setTimeout(() => {
      const params = new URLSearchParams({
        period: "custom",
        from: parsed.range!.from,
        to: parsed.range!.to,
      });
      void fetchPulse<PulseOverview>(
        source,
        `${pulseEndpoint(source, "overview")}?${params}`,
        controller.signal,
      )
        .then((data) => {
          if (!controller.signal.aborted)
            setState({ key, data, error: "", loading: false });
        })
        .catch((error) => {
          if (!controller.signal.aborted)
            setState({ key, data: null, error: error.message, loading: false });
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, source.demo, source.revision, retry]);
  const demo = useMemo(
    () =>
      source.demo && parsed.range
        ? aggregatePulse(source.events, parsed.range, now)
        : null,
    [source.demo, source.events, parsed.range, now],
  );
  const current = state.key === key && source.enabled ? state : null;
  return {
    range: parsed.range,
    data: demo ?? current?.data ?? null,
    error: parsed.error || current?.error || "",
    loading: !parsed.error && !demo && (!current || current.loading),
    retry: () => setRetry((n) => n + 1),
  };
}
