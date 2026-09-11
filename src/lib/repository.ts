import type { ActivityEvent, ActivityType } from "../../shared/types";
import type { EngineeringWallSnapshot } from "../../shared/wall";
import { getCreditedEvents } from "./activity";
import { activityDays, type ContributorDay } from "./contributor";
import {
  getReleasePulse,
  getRepositoryActivity,
  getReviewRadar,
} from "./engineering-wall";

const RECENT_LIMIT = 20;
const short = (repository: string) => repository.split("/").pop() || repository;
/** Wall signals may name a repository without its owner, as the demo does. */
const sameRepository = (a: string, b: string) =>
  a === b || ((!a.includes("/") || !b.includes("/")) && short(a) === short(b));

export interface RepositoryProfile {
  repository: string;
  /** Position among repositories by this week's activity, or null without any. */
  rank: number | null;
  weekly: number;
  merges: number;
  reviews: number;
  contributions30: number;
  activeDays30: number;
  /** Last 30 days, most contributions first. */
  contributors: {
    login: string;
    avatarUrl?: string;
    count: number;
    xp: number;
  }[];
  byType: { type: ActivityType; count: number; xp: number }[];
  heatmap: (ContributorDay | null)[];
  /** The last 30 UTC days, oldest first. */
  history: ContributorDay[];
  recent: { event: ActivityEvent; points: number }[];
  firstSeen: string | null;
  latestAt: string | null;
}

/** One repository's view of received activity, credited like the weekly board. */
export function getRepositoryProfile(
  events: ActivityEvent[],
  repository: string,
  now = Date.now(),
): RepositoryProfile {
  const mine = getCreditedEvents(events, now).filter(
    ({ event }) => event.repo === repository,
  );
  const { heatmap, history, since } = activityDays(mine, now);
  const lastMonth = mine.filter(
    ({ event }) => Date.parse(event.occurredAt) >= since,
  );
  const people = new Map<string, RepositoryProfile["contributors"][number]>();
  const types = new Map<ActivityType, RepositoryProfile["byType"][number]>();
  for (const { event, points } of lastMonth) {
    const key = event.actor.login.toLowerCase();
    const person = people.get(key) ?? {
      login: event.actor.login,
      avatarUrl: event.actor.avatarUrl,
      count: 0,
      xp: 0,
    };
    person.count += 1;
    person.xp += points;
    person.avatarUrl ??= event.actor.avatarUrl;
    people.set(key, person);
    const type = types.get(event.type) ?? { type: event.type, count: 0, xp: 0 };
    type.count += 1;
    type.xp += points;
    types.set(event.type, type);
  }
  const ranked = getRepositoryActivity(events, now);
  const index = ranked.findIndex((item) => item.repository === repository);
  const week = ranked[index];
  const newestFirst = [...mine].sort(
    (a, b) => Date.parse(b.event.occurredAt) - Date.parse(a.event.occurredAt),
  );
  return {
    repository,
    rank: week?.weekly ? index + 1 : null,
    weekly: week?.weekly ?? 0,
    merges: week?.merges ?? 0,
    reviews: week?.reviews ?? 0,
    contributions30: lastMonth.length,
    activeDays30: history.filter((day) => day.count > 0).length,
    contributors: [...people.values()].sort(
      (a, b) =>
        b.count - a.count || b.xp - a.xp || a.login.localeCompare(b.login),
    ),
    byType: [...types.values()].sort(
      (a, b) =>
        b.count - a.count || b.xp - a.xp || a.type.localeCompare(b.type),
    ),
    heatmap,
    history,
    recent: newestFirst.slice(0, RECENT_LIMIT),
    firstSeen: newestFirst.at(-1)?.event.occurredAt ?? null,
    latestAt: newestFirst[0]?.event.occurredAt ?? null,
  };
}

/** Open pull requests and the latest deployment per environment, from the wall. */
export function getRepositorySignals(
  snapshot: EngineeringWallSnapshot | undefined | null,
  repository: string,
  now = Date.now(),
) {
  const only: EngineeringWallSnapshot = {
    updatedAt: snapshot?.updatedAt ?? "",
    repositories: (snapshot?.repositories ?? []).filter((item) =>
      sameRepository(item.repository, repository),
    ),
  };
  return {
    pullRequests: getReviewRadar(only, now),
    deployments: getReleasePulse(only),
  };
}
