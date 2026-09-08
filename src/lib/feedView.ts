import type { ActivityEvent } from "../../shared/types";

export type FeedFilters = {
  repo: string;
  kind: ActivityEvent["type"] | "";
  query: string;
};

/** Keep bot activity visible here; weekly contribution scoring is handled separately. */
export function getWindowEvents(
  events: ActivityEvent[],
  start: number,
  end: number,
): ActivityEvent[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end)
    return [];
  const seen = new Set<string>();
  return events
    .filter((event) => {
      const timestamp = Date.parse(event.occurredAt);
      return (
        typeof event.actor?.login === "string" &&
        event.actor.login.trim().length > 0 &&
        Number.isFinite(timestamp) &&
        timestamp >= start &&
        timestamp <= end
      );
    })
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
    .filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    });
}

export function filterEvents(
  events: ActivityEvent[],
  filters: FeedFilters,
): ActivityEvent[] {
  const query = filters.query.trim().toLowerCase();
  return events.filter((event) => {
    if (filters.repo && event.repo !== filters.repo) return false;
    if (filters.kind && event.type !== filters.kind) return false;
    if (!query) return true;
    const fields = [
      event.title,
      event.actor.login,
      event.repo,
      event.body || "",
    ];
    if (event.number !== undefined) fields.push(`#${event.number}`);
    return fields.some((field) => field.toLowerCase().includes(query));
  });
}

export function getViewCounts(events: ActivityEvent[]): {
  merges: number;
  reviews: number;
  releases: number;
  contributors: number;
  total: number;
} {
  return {
    merges: events.filter((event) => event.type === "merge").length,
    reviews: events.filter((event) => event.type === "review").length,
    releases: events.filter((event) => event.type === "release").length,
    contributors: new Set(
      events
        .map((event) => event.actor.login.trim().toLowerCase())
        .filter(Boolean),
    ).size,
    total: events.length,
  };
}

export function getTimelineRange(
  period: "24h" | "7d" | "30d",
  end: number,
): { start: number; end: number } {
  const days = { "24h": 1, "7d": 7, "30d": 30 }[period];
  return { start: end - days * 24 * 60 * 60 * 1_000, end };
}

export function getTimelineCutoff(
  start: number,
  end: number,
  percent: number,
): number {
  const clamped = Math.max(0, Math.min(100, percent));
  return start + ((end - start) * clamped) / 100;
}
