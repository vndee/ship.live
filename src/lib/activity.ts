import type { PulseRange } from "../../shared/pulse";
import { inPeriod } from "./period";
import type { ActivityEvent, ActivityType } from "../../shared/types";

const DAY = 24 * 60 * 60 * 1000;
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Commits remain visible activity without stacking delivery XP. */
export const COMMIT_POINTS = 0;
/** Merges into other branches count, but below merges into the default branch. */
export const BRANCH_MERGE_POINTS = 15;

/** Base recognition for each activity kind. */
export const EVENT_META: Record<
  ActivityType,
  {
    label: string;
    verb: string;
    points: number;
    color: "emerald" | "violet" | "sky" | "amber" | "rose" | "slate";
  }
> = {
  merge: {
    label: "Merge",
    verb: "merged a pull request",
    points: 30,
    color: "emerald",
  },
  review: {
    label: "Review",
    verb: "reviewed a pull request",
    points: 10,
    color: "violet",
  },
  note: {
    label: "Ship note",
    verb: "added a ship note",
    points: 0,
    color: "slate",
  },
  push: {
    label: "Push",
    verb: "pushed commits",
    points: COMMIT_POINTS,
    color: "slate",
  },
  issue: {
    label: "Issue",
    verb: "closed an issue",
    points: 10,
    color: "amber",
  },
  release: {
    label: "Release",
    verb: "published a release",
    points: 50,
    color: "rose",
  },
  pr: {
    label: "Pull request",
    verb: "opened a pull request",
    points: 0,
    color: "sky",
  },
  alert: {
    label: "Alert",
    verb: "raised an alert",
    points: 0,
    color: "rose",
  },
};

export interface ActivityMetrics {
  merges: number;
  reviews: number;
  releases: number;
  contributors: number;
  xp: number;
  total: number;
}

export interface LeaderboardEntry {
  login: string;
  avatarUrl?: string;
  xp: number;
  merges: number;
  reviews: number;
  contributions: number;
  rank: number;
}

export interface DailyActivity {
  date: string;
  label: string;
  count: number;
  merges: number;
  reviews: number;
}

export interface Achievement {
  id: string;
  title: string;
  description: string;
  progress: number;
  target: number;
  unlocked: boolean;
  kind: "merge" | "review" | "release";
}

/** All weekly views use Monday 00:00 UTC, independent of the viewer's timezone. */
export function getWeekStart(now = Date.now()): Date {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  return start;
}

export function isHumanActor(login: string): boolean {
  const value = login.trim().toLowerCase();
  return (
    Boolean(value) &&
    !/\[bot\]$|-bot$/i.test(value) &&
    !["dependabot", "renovate", "github-actions"].includes(value)
  );
}

function eligibleEvents(
  events: ActivityEvent[],
  now: number,
  since = -Infinity,
): ActivityEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const timestamp = Date.parse(event.occurredAt);
    if (
      // Inbound alerts come from services: they are never anyone's work.
      event.type === "alert" ||
      !isHumanActor(event.actor.login) ||
      !Number.isFinite(timestamp) ||
      timestamp < since ||
      timestamp > now ||
      seen.has(event.id)
    )
      return false;
    seen.add(event.id);
    return true;
  });
}

function weeklyEvents(
  events: ActivityEvent[],
  now: number,
  range?: PulseRange,
): ActivityEvent[] {
  return range
    ? eligibleEvents(events, now).filter((event) =>
        inPeriod(event.occurredAt, range, now),
      )
    : eligibleEvents(events, now, getWeekStart(now).getTime());
}

/** Base XP before review deduplication. Verification bonuses remain unranked. */
export function basePoints(event: ActivityEvent): number {
  if (
    event.type === "review" &&
    (!event.number ||
      !event.pullRequestAuthor?.trim() ||
      event.reviewCredit === false ||
      event.pullRequestAuthor.trim().toLowerCase() ===
        event.actor.login.trim().toLowerCase())
  )
    return 0;
  // Unknown targets keep full credit, like events stored before branches were recorded.
  if (event.type === "merge" && event.defaultBranch === false)
    return BRANCH_MERGE_POINTS;
  return EVENT_META[event.type].points;
}

export const SCORING_RULES: Array<{
  type: ActivityType;
  verb: string;
  points: number;
  each?: boolean;
}> = [
  {
    type: "release",
    verb: EVENT_META.release.verb,
    points: EVENT_META.release.points,
  },
  {
    type: "merge",
    verb: "merged into the default branch",
    points: EVENT_META.merge.points,
  },
  {
    type: "merge",
    verb: "merged into another branch",
    points: BRANCH_MERGE_POINTS,
  },
  {
    type: "review",
    verb: EVENT_META.review.verb,
    points: EVENT_META.review.points,
  },
  {
    type: "issue",
    verb: EVENT_META.issue.verb,
    points: EVENT_META.issue.points,
  },
  { type: "pr", verb: EVENT_META.pr.verb, points: EVENT_META.pr.points },
  {
    type: "push",
    verb: "pushed a new commit",
    points: COMMIT_POINTS,
    each: true,
  },
];

/** Resolve earliest peer review before selecting a week or display period. */
function withCredit(
  events: ActivityEvent[],
): Array<{ event: ActivityEvent; points: number }> {
  const authors = new Map<string, string>();
  const keyFor = (e: ActivityEvent) =>
    `${e.repositoryId ?? e.repo.toLowerCase()}|${e.number}`;
  for (const e of events) {
    if ((e.type === "pr" || e.type === "merge") && e.number)
      authors.set(keyFor(e), e.actor.login);
  }
  const reviews = new Set<string>();
  const credits = new Map<string, number>();
  for (const e of [...events].sort(
    (a, b) =>
      Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )) {
    let points = basePoints(e);
    if (e.type === "review") {
      const author = e.pullRequestAuthor || authors.get(keyFor(e));
      const key = `${e.actor.login.trim().toLowerCase()}|${keyFor(e)}`;
      points = reviews.has(key)
        ? 0
        : basePoints({ ...e, pullRequestAuthor: author });
      reviews.add(key);
    }
    credits.set(e.id, points);
  }
  return events.map((event) => ({ event, points: credits.get(event.id) ?? 0 }));
}

/** Human, de-duplicated events up to now, with the board's review credit limit. */
export function getCreditedEvents(
  events: ActivityEvent[],
  now = Date.now(),
  since = -Infinity,
): Array<{ event: ActivityEvent; points: number }> {
  return withCredit(eligibleEvents(events, now)).filter(
    ({ event }) => Date.parse(event.occurredAt) >= since,
  );
}

function periodCredit(
  events: ActivityEvent[],
  now: number,
  range?: PulseRange,
) {
  return getCreditedEvents(events, now).filter(({ event }) =>
    range
      ? inPeriod(event.occurredAt, range, now)
      : Date.parse(event.occurredAt) >= getWeekStart(now).getTime(),
  );
}

export function getMetrics(
  events: ActivityEvent[],
  now = Date.now(),
  range?: PulseRange,
): ActivityMetrics {
  const weekly = weeklyEvents(events, now, range);
  return {
    merges: weekly.filter((event) => event.type === "merge").length,
    reviews: weekly.filter((event) => event.type === "review").length,
    releases: weekly.filter((event) => event.type === "release").length,
    contributors: new Set(
      weekly.map((event) => event.actor.login.toLowerCase()),
    ).size,
    xp: periodCredit(events, now, range).reduce(
      (sum, item) => sum + item.points,
      0,
    ),
    total: weekly.length,
  };
}

export function getLeaderboard(
  events: ActivityEvent[],
  now = Date.now(),
  range?: PulseRange,
): LeaderboardEntry[] {
  const people = new Map<string, LeaderboardEntry>();
  for (const { event, points } of periodCredit(events, now, range)) {
    const key = event.actor.login.toLowerCase();
    const entry = people.get(key) ?? {
      login: event.actor.login,
      xp: 0,
      merges: 0,
      reviews: 0,
      contributions: 0,
      rank: 0,
    };
    if (event.actor.avatarUrl && !entry.avatarUrl)
      entry.avatarUrl = event.actor.avatarUrl;
    entry.xp += points;
    entry.contributions += 1;
    entry.merges += Number(event.type === "merge");
    entry.reviews += Number(event.type === "review");
    people.set(key, entry);
  }
  return [...people.values()]
    .sort((a, b) => b.xp - a.xp || a.login.localeCompare(b.login))
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

export function getDailyActivity(
  events: ActivityEvent[],
  days = 7,
  now = Date.now(),
): DailyActivity[] {
  if (!Number.isFinite(days) || days <= 0) return [];
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const start = today.getTime() - (Math.floor(days) - 1) * DAY;
  const buckets = Array.from(
    { length: Math.floor(days) },
    (_, index): DailyActivity => {
      const date = new Date(start + index * DAY);
      return {
        date: date.toISOString().slice(0, 10),
        label: DAY_LABELS[date.getUTCDay()],
        count: 0,
        merges: 0,
        reviews: 0,
      };
    },
  );
  for (const event of eligibleEvents(events, now, start)) {
    const bucket =
      buckets[Math.floor((Date.parse(event.occurredAt) - start) / DAY)];
    if (!bucket) continue;
    bucket.count += 1;
    bucket.merges += Number(event.type === "merge");
    bucket.reviews += Number(event.type === "review");
  }
  return buckets;
}

export function getAchievements(
  events: ActivityEvent[],
  now = Date.now(),
): Achievement[] {
  const metrics = getMetrics(events, now);
  const definitions: Array<
    Omit<Achievement, "progress" | "unlocked"> & { count: number }
  > = [
    {
      id: "team-ship",
      title: "Ship it, together",
      description: "Merge 30 pull requests as a team this week.",
      kind: "merge",
      target: 30,
      count: metrics.merges,
    },
    {
      id: "team-review",
      title: "Better, together",
      description: "Give 40 code reviews as a team this week.",
      kind: "review",
      target: 40,
      count: metrics.reviews,
    },
    {
      id: "team-release",
      title: "Ready for the world",
      description: "Publish 5 releases as a team this week.",
      kind: "release",
      target: 5,
      count: metrics.releases,
    },
  ];
  return definitions.map(({ count, ...achievement }) => ({
    ...achievement,
    progress: Math.min(count, achievement.target),
    unlocked: count >= achievement.target,
  }));
}
