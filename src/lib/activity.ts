import type { ActivityEvent, ActivityType } from "../../shared/types";

const DAY = 24 * 60 * 60 * 1000;
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** XP for each commit a push adds to the repository. */
export const COMMIT_POINTS = 2;
/** Merges into other branches count, but below merges into the default branch. */
export const BRANCH_MERGE_POINTS = 15;

/** Push points are per new commit; see basePoints. */
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
    points: 15,
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
    points: 5,
    color: "sky",
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

function weeklyEvents(events: ActivityEvent[], now: number): ActivityEvent[] {
  return eligibleEvents(events, now, getWeekStart(now).getTime());
}

/** Base XP before weekly limits: pushes earn per new commit, merges by target branch. */
export function basePoints(event: ActivityEvent): number {
  if (event.type === "push") return (event.commits ?? 0) * COMMIT_POINTS;
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

/** Keep distinct review activity visible, but only credit one review per PR/day/person. */
function withCredit(
  events: ActivityEvent[],
): Array<{ event: ActivityEvent; points: number }> {
  const reviews = new Set<string>();
  return events.map((event) => {
    let points = basePoints(event);
    if (event.type === "review" && event.number !== undefined) {
      const day = new Date(event.occurredAt).toISOString().slice(0, 10);
      const key = `${event.actor.login.toLowerCase()}|${event.repo.toLowerCase()}|${event.number}|${day}`;
      if (reviews.has(key)) points = 0;
      reviews.add(key);
    }
    return { event, points };
  });
}

export function getMetrics(
  events: ActivityEvent[],
  now = Date.now(),
): ActivityMetrics {
  const weekly = weeklyEvents(events, now);
  return {
    merges: weekly.filter((event) => event.type === "merge").length,
    reviews: weekly.filter((event) => event.type === "review").length,
    releases: weekly.filter((event) => event.type === "release").length,
    contributors: new Set(
      weekly.map((event) => event.actor.login.toLowerCase()),
    ).size,
    xp: withCredit(weekly).reduce((sum, item) => sum + item.points, 0),
    total: weekly.length,
  };
}

export function getLeaderboard(
  events: ActivityEvent[],
  now = Date.now(),
): LeaderboardEntry[] {
  const people = new Map<string, LeaderboardEntry>();
  for (const { event, points } of withCredit(weeklyEvents(events, now))) {
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
    .sort(
      (a, b) =>
        b.xp - a.xp ||
        b.contributions - a.contributions ||
        a.login.localeCompare(b.login),
    )
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
