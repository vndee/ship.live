import { useEffect, useMemo, useState } from "react";
import {
  aggregatePulse,
  resolvePulseRange,
  type PulseSelection,
} from "../../shared/pulse";
import type { PulseDashboard } from "../../shared/pulse-dashboard";
import type { EngineeringWallSnapshot } from "../../shared/wall";
import type { HealthSnapshot } from "../../shared/health";
import { fetchPulse, type PulseSource } from "./usePulse";

/** One request and one range own every scene; old scope responses never render. */
export function usePulseDashboard(
  source: PulseSource,
  selection: PulseSelection,
  now: number,
  demoWall?: EngineeringWallSnapshot,
  demoHealth?: HealthSnapshot,
) {
  const today = new Date(now).toISOString().slice(0, 10);
  const parsed = useMemo(() => {
    try {
      return { range: resolvePulseRange(selection, now), error: "" };
    } catch (error) {
      return {
        range: null,
        error: error instanceof Error ? error.message : "Choose valid dates.",
      };
    }
  }, [selection.period, selection.from, selection.to, today]);
  const [revision, refresh] = useState(0);
  const key = JSON.stringify([
    source.scopeKey,
    source.workspaceId,
    source.shareToken,
    source.enabled,
    parsed.range?.from,
    parsed.range?.to,
  ]);
  const [state, setState] = useState<{
    key: string;
    data: PulseDashboard | null;
    error: string;
  }>({ key: "", data: null, error: "" });
  useEffect(() => {
    if (!source.enabled || source.demo) return;
    const update = () => refresh((n) => n + 1);
    window.addEventListener("ship-live-wall", update);
    const timer = setInterval(update, 30_000);
    return () => {
      window.removeEventListener("ship-live-wall", update);
      clearInterval(timer);
    };
  }, [source.enabled, source.demo]);
  useEffect(() => {
    if (!parsed.range || !source.enabled || source.demo) return;
    const controller = new AbortController();
    setState({ key, data: null, error: "" });
    const timer = setTimeout(() => {
      const query = new URLSearchParams({
        period: "custom",
        from: parsed.range!.from,
        to: parsed.range!.to,
      });
      const base = source.shareToken
        ? "/api/shared"
        : `/api/workspaces/${encodeURIComponent(source.workspaceId || "")}`;
      void fetchPulse<PulseDashboard>(
        source,
        `${base}/pulse/dashboard?${query}`,
        controller.signal,
      )
        .then((data) => {
          if (!controller.signal.aborted) setState({ key, data, error: "" });
        })
        .catch((error) => {
          if (!controller.signal.aborted)
            setState({ key, data: null, error: error.message });
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, source.demo, source.revision, revision]);
  const demo = useMemo<PulseDashboard | null>(() => {
    const range = parsed.range;
    if (!source.demo || !source.enabled || !range || !demoWall) return null;
    const inside = (date: string) =>
      Date.parse(date) >= Date.parse(range.start) &&
      Date.parse(date) < Date.parse(range.end) &&
      Date.parse(date) <= now;
    return {
      range,
      overview: aggregatePulse(source.events, range, now),
      events: source.events.filter((event) => inside(event.occurredAt)),
      wall: demoWall,
      health: demoHealth && {
        ...demoHealth,
        range,
        services: demoHealth.services.map((service) => ({
          ...service,
          incidents: service.incidents?.filter(
            (i) =>
              Date.parse(i.openedAt) < Math.min(Date.parse(range.end), now) &&
              (!i.resolvedAt ||
                Date.parse(i.resolvedAt) > Date.parse(range.start)),
          ),
          probes: service.probes.map((probe) => {
            const days = (probe.uptime90d || []).filter(
              (d) => d.date >= range.from && d.date <= range.to,
            );
            const checks = days.reduce((sum, d) => sum + d.checks, 0);
            const latency = (probe.latencyHistory || []).filter(
              (d) => d.date >= range.from && d.date <= range.to,
            );
            const timed = latency.reduce((sum, d) => sum + d.checks, 0);
            return {
              ...probe,
              history: probe.history.filter((h) => inside(h.checkedAt)),
              periodStats: {
                checks,
                successRate: checks
                  ? (100 * days.reduce((sum, d) => sum + d.passed, 0)) / checks
                  : null,
                latencyStats: timed
                  ? {
                      checks: timed,
                      mean:
                        latency.reduce(
                          (sum, d) => sum + d.avgLatencyMs * d.checks,
                          0,
                        ) / timed,
                      sd: null,
                    }
                  : null,
              },
            };
          }),
        })),
      },
    };
  }, [
    source.demo,
    source.enabled,
    source.events,
    parsed.range,
    now,
    demoWall,
    demoHealth,
  ]);
  const current = source.enabled && state.key === key ? state : null;
  const data = demo ?? current?.data ?? null;
  const error = parsed.error || current?.error || "";
  return {
    range: parsed.range,
    data,
    error,
    loading: !error && !data,
    retry: () => refresh((n) => n + 1),
  };
}
