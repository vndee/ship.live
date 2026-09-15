import type { ActivityEvent } from "./types.js";
export interface PulseSelection {
  period?: "today" | "7d" | "30d" | "month" | "custom";
  from?: string;
  to?: string;
}
export interface PulseRange {
  from: string;
  to: string;
  start: string;
  end: string;
  granularity: "day" | "week";
}
export interface PulseCounts {
  count: number;
  merges: number;
  reviews: number;
  releases: number;
}
export interface PulseOverview {
  range: PulseRange;
  totals: PulseCounts;
  buckets: (PulseCounts & { from: string; to: string })[];
  repositories: (PulseCounts & { repo: string })[];
  coverage: {
    earliestStoredAt: string | null;
    retentionDays: number | null;
    /** Successful repository imports; timestamp is the import's start, not completion. */
    sourceSync?: {
      lastSyncedAt: string | null;
      syncedRepositories: number;
      totalRepositories: number;
    };
  };
  comparison?: {
    previous: {
      range: PulseRange;
      totals: PulseCounts;
      participants: number;
      coverage: PulseOverview["coverage"];
    };
    currentParticipants: number;
    currentIncomplete: boolean;
  };
  generatedAt: string;
}
export type PulseActivityKind = "merge" | "review" | "release" | "contribution";
export interface PulseActivityPage {
  events: ActivityEvent[];
  nextCursor: string | null;
}
const DAY = 86400000;
const date = (time: number) => new Date(time).toISOString().slice(0, 10);
export function resolvePulseRange(
  selection: PulseSelection,
  now: number,
): PulseRange {
  const today = Date.parse(date(now));
  const period = selection.period ?? "7d";
  let start = today;
  let last = today;
  if (period === "custom") {
    const parse = (value: unknown) => {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        throw new Error("Choose dates in YYYY-MM-DD format.");
      const time = Date.parse(value);
      if (
        value.startsWith("0000-") ||
        !Number.isFinite(time) ||
        date(time) !== value
      )
        throw new Error("Choose valid calendar dates.");
      return time;
    };
    start = parse(selection.from);
    last = parse(selection.to);
  } else if (period === "7d") start -= 6 * DAY;
  else if (period === "30d") start -= 29 * DAY;
  else if (period === "month")
    start = Date.parse(`${date(today).slice(0, 7)}-01`);
  else if (period !== "today") throw new Error("Choose a valid period.");
  if (last > today) throw new Error("End date cannot be in the future.");
  if (start > last)
    throw new Error("Start date must be on or before end date.");
  if ((last - start) / DAY + 1 > 366)
    throw new Error("Choose a range of at most 366 days.");
  return {
    from: date(start),
    to: date(last),
    start: new Date(start).toISOString(),
    end: new Date(last + DAY).toISOString(),
    granularity: (last - start) / DAY + 1 <= 31 ? "day" : "week",
  };
}
/** Immediately preceding calendar range, with the same inclusive day count. */
export function previousPulseRange(range: PulseRange): PulseRange {
  const end = Date.parse(range.start);
  const start = end - (Date.parse(range.end) - end);
  return {
    from: date(start),
    to: date(end - DAY),
    start: new Date(start).toISOString(),
    end: range.start,
    granularity: range.granularity,
  };
}
export const emptyPulseCounts = (): PulseCounts => ({
  count: 0,
  merges: 0,
  reviews: 0,
  releases: 0,
});
export function pulseBuckets(range: PulseRange): PulseOverview["buckets"] {
  const result: PulseOverview["buckets"] = [];
  const end = Date.parse(range.end);
  for (let start = Date.parse(range.start); start < end;) {
    const next =
      range.granularity === "day"
        ? start + DAY
        : start + (7 - ((new Date(start).getUTCDay() + 6) % 7)) * DAY;
    result.push({
      from: date(start),
      to: date(Math.min(next, end) - DAY),
      ...emptyPulseCounts(),
    });
    start = next;
  }
  return result;
}
export function aggregatePulse(
  events: ActivityEvent[],
  range: PulseRange,
  now: number,
): PulseOverview {
  const previousRange = previousPulseRange(range);
  const previousTotals = emptyPulseCounts();
  const currentParticipants = new Set<string>();
  const previousParticipants = new Set<string>();
  const previousSeen = new Set<string>();
  const buckets = pulseBuckets(range);
  const totals = emptyPulseCounts();
  const repositories = new Map<string, PulseCounts & { repo: string }>();
  const seen = new Set<string>();
  let earliestStoredAt: string | null = null;
  for (const event of events) {
    const login = event.actor.login.trim().toLowerCase();
    const time = Date.parse(event.occurredAt);
    if (
      event.type === "note" ||
      event.type === "alert" ||
      !login ||
      /\[bot\]$|-bot$/.test(login) ||
      ["dependabot", "renovate", "github-actions"].includes(login) ||
      !Number.isFinite(time) ||
      time > now ||
      seen.has(event.id)
    )
      continue;
    if (earliestStoredAt === null || time < Date.parse(earliestStoredAt))
      earliestStoredAt = new Date(time).toISOString();
    if (
      time >= Date.parse(previousRange.start) &&
      time < Date.parse(previousRange.end) &&
      !previousSeen.has(event.id)
    ) {
      previousSeen.add(event.id);
      previousParticipants.add(login);
      previousTotals.count++;
      previousTotals.merges += Number(event.type === "merge");
      previousTotals.reviews += Number(event.type === "review");
      previousTotals.releases += Number(event.type === "release");
    }
    if (time < Date.parse(range.start) || time >= Date.parse(range.end))
      continue;
    seen.add(event.id);
    currentParticipants.add(login);
    const repo = repositories.get(event.repo) ?? {
      repo: event.repo,
      ...emptyPulseCounts(),
    };
    repositories.set(event.repo, repo);
    const bucket = buckets.find(
      (b) => date(time) >= b.from && date(time) <= b.to,
    )!;
    for (const target of [totals, repo, bucket]) {
      target.count++;
      target.merges += Number(event.type === "merge");
      target.reviews += Number(event.type === "review");
      target.releases += Number(event.type === "release");
    }
  }
  return {
    range,
    totals,
    buckets,
    repositories: [...repositories.values()].sort(
      (a, b) => b.count - a.count || a.repo.localeCompare(b.repo),
    ),
    coverage: { earliestStoredAt, retentionDays: null },
    comparison: {
      previous: {
        range: previousRange,
        totals: previousTotals,
        participants: previousParticipants.size,
        coverage: { earliestStoredAt, retentionDays: null },
      },
      currentParticipants: currentParticipants.size,
      currentIncomplete: Date.parse(range.end) > now,
    },
    generatedAt: new Date(now).toISOString(),
  };
}
