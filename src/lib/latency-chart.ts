import type { HealthCheck } from "../../shared/health";
export interface DailyLatency {
  date: string;
  avgLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  checks: number;
}
export interface LatencyPoint {
  ok?: boolean;
  statusCode?: number | null;
  time: number;
  latencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  checks: number;
}
export const UTC_DAY_MS = 86400000;
export function buildLatencySeries(
  history: HealthCheck[],
  daily: DailyLatency[],
  mode: "recent" | "daily",
  now: number,
): (LatencyPoint | null)[] {
  if (mode === "recent")
    return history
      .filter(
        (check) =>
          Number.isFinite(Date.parse(check.checkedAt)) &&
          Number.isFinite(check.latencyMs) &&
          check.latencyMs >= 0,
      )
      .map((check) => ({
        time: Date.parse(check.checkedAt),
        latencyMs: check.latencyMs,
        minLatencyMs: check.latencyMs,
        maxLatencyMs: check.latencyMs,
        checks: 1,
        ok: check.ok,
        statusCode: check.statusCode,
      }))
      .sort((a, b) => a.time - b.time)
      .slice(-120);
  const today = Math.floor(now / UTC_DAY_MS) * UTC_DAY_MS;
  const byDay = new Map(daily.map((day) => [day.date, day]));
  return Array.from({ length: 30 }, (_, index) => {
    const time = today - (29 - index) * UTC_DAY_MS;
    const day = byDay.get(new Date(time).toISOString().slice(0, 10));
    if (
      !day ||
      day.checks <= 0 ||
      !Number.isFinite(day.avgLatencyMs) ||
      day.avgLatencyMs < 0
    )
      return null;
    return {
      time,
      latencyMs: day.avgLatencyMs,
      minLatencyMs: day.minLatencyMs,
      maxLatencyMs: day.maxLatencyMs,
      checks: day.checks,
    };
  });
}
/** Missing days break the line; they are neither zero-latency nor interpolated checks. */
export function latencySegments(
  points: (LatencyPoint | null)[],
): LatencyPoint[][] {
  const segments: LatencyPoint[][] = [];
  let current: LatencyPoint[] | null = null;
  for (const point of points) {
    if (!point) {
      current = null;
      continue;
    }
    if (!current) {
      current = [];
      segments.push(current);
    }
    current.push(point);
  }
  return segments;
}

/** Select by time, retaining the earlier index when two observations are equidistant. */
export function nearestLatencyPoint(
  points: (LatencyPoint | null)[],
  targetTime: number,
): number | null {
  let selected: number | null = null;
  let distance = Infinity;
  points.forEach((point, index) => {
    if (!point) return;
    const nextDistance = Math.abs(point.time - targetTime);
    if (nextDistance < distance) {
      selected = index;
      distance = nextDistance;
    }
  });
  return selected;
}

export function moveLatencyPoint(
  points: (LatencyPoint | null)[],
  active: number | null,
  key: "previous" | "next" | "first" | "last",
): number | null {
  const indexes = points.flatMap((point, index) => (point ? [index] : []));
  if (!indexes.length) return null;
  if (key === "first") return indexes[0];
  if (key === "last") return indexes[indexes.length - 1];
  const position = active === null ? -1 : indexes.indexOf(active);
  if (position === -1) return indexes[0];
  return indexes[
    Math.max(
      0,
      Math.min(indexes.length - 1, position + (key === "next" ? 1 : -1)),
    )
  ];
}

export function clampTooltipLeft(
  anchor: number,
  width: number,
  container: number,
  padding = 8,
): number {
  return Math.min(
    Math.max(padding, anchor - width / 2),
    Math.max(padding, container - width - padding),
  );
}
