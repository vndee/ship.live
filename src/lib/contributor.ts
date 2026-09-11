import type { ActivityEvent, ActivityType } from "../../shared/types";
import { getCreditedEvents, getLeaderboard, getWeekStart } from "./activity";

const DAY = 86_400_000;
/** The heatmap shows whole Monday-first UTC weeks, ending with the current one. */
export const HEATMAP_WEEKS = 12;
export const XP_HISTORY_DAYS = 30;
const RECENT_LIMIT = 20;

export interface ContributorDay {
  date: string;
  count: number;
  xp: number;
}

export interface ContributorProfile {
  login: string;
  avatarUrl?: string;
  /** Position on this week's board, or null without weekly activity. */
  rank: number | null;
  weeklyXp: number;
  xp30: number;
  contributions30: number;
  activeDays30: number;
  /** Last 30 days by activity type, most frequent first. */
  byType: { type: ActivityType; count: number; xp: number }[];
  /** HEATMAP_WEEKS × 7 UTC days, week by week from Monday; future days are null. */
  heatmap: (ContributorDay | null)[];
  /** The last XP_HISTORY_DAYS UTC days, oldest first. */
  xpHistory: ContributorDay[];
  recent: { event: ActivityEvent; points: number }[];
  /** Oldest activity this workspace has received from them. */
  firstSeen: string | null;
}

const dayKey = (time: number) => new Date(time).toISOString().slice(0, 10);

/**
 * Daily counts and XP for credited activity: HEATMAP_WEEKS whole weeks ending
 * this week (future days null), and the last XP_HISTORY_DAYS days.
 */
export function activityDays(
  items: { event: ActivityEvent; points: number }[],
  now: number,
): {
  heatmap: (ContributorDay | null)[];
  history: ContributorDay[];
  since: number;
} {
  const days = new Map<string, ContributorDay>();
  for (const { event, points } of items) {
    const date = dayKey(Date.parse(event.occurredAt));
    const day = days.get(date) ?? { date, count: 0, xp: 0 };
    day.count += 1;
    day.xp += points;
    days.set(date, day);
  }
  const dayAt = (time: number): ContributorDay =>
    days.get(dayKey(time)) ?? { date: dayKey(time), count: 0, xp: 0 };
  const today = Date.parse(`${dayKey(now)}T00:00:00Z`);
  const heatmapStart =
    getWeekStart(now).getTime() - (HEATMAP_WEEKS - 1) * 7 * DAY;
  const heatmap = Array.from({ length: HEATMAP_WEEKS * 7 }, (_, index) => {
    const time = heatmapStart + index * DAY;
    return time > today ? null : dayAt(time);
  });
  const since = today - (XP_HISTORY_DAYS - 1) * DAY;
  const history = Array.from({ length: XP_HISTORY_DAYS }, (_, index) =>
    dayAt(since + index * DAY),
  );
  return { heatmap, history, since };
}

/** One person's view of received activity, credited like the weekly board. */
export function getContributorProfile(
  events: ActivityEvent[],
  login: string,
  now = Date.now(),
): ContributorProfile {
  const key = login.toLowerCase();
  const mine = getCreditedEvents(events, now).filter(
    ({ event }) => event.actor.login.toLowerCase() === key,
  );
  const { heatmap, history: xpHistory, since } = activityDays(mine, now);
  const lastMonth = mine.filter(
    ({ event }) => Date.parse(event.occurredAt) >= since,
  );
  const types = new Map<
    ActivityType,
    { type: ActivityType; count: number; xp: number }
  >();
  for (const { event, points } of lastMonth) {
    const entry = types.get(event.type) ?? {
      type: event.type,
      count: 0,
      xp: 0,
    };
    entry.count += 1;
    entry.xp += points;
    types.set(event.type, entry);
  }
  const board = getLeaderboard(events, now).find(
    (person) => person.login.toLowerCase() === key,
  );
  const newestFirst = [...mine].sort(
    (a, b) => Date.parse(b.event.occurredAt) - Date.parse(a.event.occurredAt),
  );
  return {
    login: board?.login ?? mine[0]?.event.actor.login ?? login,
    avatarUrl: mine.find(({ event }) => event.actor.avatarUrl)?.event.actor
      .avatarUrl,
    rank: board?.rank ?? null,
    weeklyXp: board?.xp ?? 0,
    xp30: lastMonth.reduce((sum, item) => sum + item.points, 0),
    contributions30: lastMonth.length,
    activeDays30: xpHistory.filter((day) => day.count > 0).length,
    byType: [...types.values()].sort(
      (a, b) =>
        b.count - a.count || b.xp - a.xp || a.type.localeCompare(b.type),
    ),
    heatmap,
    xpHistory,
    recent: newestFirst.slice(0, RECENT_LIMIT),
    firstSeen: newestFirst.at(-1)?.event.occurredAt ?? null,
  };
}
