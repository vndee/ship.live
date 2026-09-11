import type { ActivityEvent } from "../../shared/types";
import {
  getAchievements,
  getDailyActivity,
  getMetrics,
  getWeekStart,
  isHumanActor,
} from "./activity";

export function getDashboardPulse(events: ActivityEvent[], now = Date.now()) {
  const days = getDailyActivity(
    events.filter((event) => event.type !== "note"),
    7,
    now,
  );
  const milestones = getAchievements(events, now);
  const nextMilestone =
    milestones
      .filter((item) => !item.unlocked)
      .sort((a, b) => b.progress / b.target - a.progress / a.target)[0] || null;
  return {
    today: days[6],
    days,
    total: days.reduce((total, day) => total + day.count, 0),
    nextMilestone,
    remaining: nextMilestone
      ? nextMilestone.target - nextMilestone.progress
      : 0,
    completed: milestones.filter((item) => item.unlocked).length,
  };
}

export interface ActivityCelebration {
  id: string;
  event: ActivityEvent;
  count: number;
  xp: number;
  milestone?: string;
  confetti: "ship" | "milestone" | null;
}
export interface ActivityObservation {
  seen: Set<string>;
  events: ActivityEvent[];
  week: number;
  unlocked: Set<string>;
  lastConfettiAt: number;
  enabled: boolean;
  acceptAfter: number;
}

/** Observe verified snapshots, not filtered/replayed views. First snapshots are silent. */
export function observeActivity(
  previous: ActivityObservation | undefined,
  events: ActivityEvent[],
  now: number,
  enabled = true,
): {
  state: ActivityObservation;
  celebration: ActivityCelebration | null;
  highlightedIds: string[];
} {
  const week = getWeekStart(now).getTime();
  const achievements = getAchievements(events, now);
  const unlocked = new Set(previous?.week === week ? previous.unlocked : []);
  const newlyUnlocked = achievements.filter(
    (item) => item.unlocked && !unlocked.has(item.id),
  );
  achievements
    .filter((item) => item.unlocked)
    .forEach((item) => unlocked.add(item.id));
  const currentIds = new Set(events.map((event) => event.id));
  const seen = new Set(
    [...(previous?.seen || [])]
      .filter((id) => !currentIds.has(id))
      .concat([...currentIds])
      .slice(-6000),
  );
  const state: ActivityObservation = {
    seen,
    events,
    week,
    unlocked,
    lastConfettiAt: previous?.lastConfettiAt ?? -Infinity,
    enabled,
    // A delayed refresh must not celebrate work that happened while effects were paused.
    acceptAfter:
      previous && !previous.enabled && enabled
        ? now
        : (previous?.acceptAfter ?? -Infinity),
  };
  const silent = { state, celebration: null, highlightedIds: [] };
  if (!previous || !enabled) return silent;
  const fresh = events
    .filter((event) => {
      const timestamp = Date.parse(event.occurredAt);
      return (
        !previous.seen.has(event.id) &&
        isHumanActor(event.actor.login) &&
        timestamp <= now &&
        timestamp >= Math.max(now - 120000, state.acceptAfter)
      );
    })
    .filter(
      (event, index, all) =>
        all.findIndex((item) => item.id === event.id) === index,
    );
  if (!fresh.length) return silent;
  // Alerts are highlighted in the feed, but they are not work to celebrate.
  const work = fresh.filter((event) => event.type !== "alert");
  if (!work.length)
    return { ...silent, highlightedIds: fresh.map((event) => event.id) };
  const notable = work.filter(
    (event) => event.type === "merge" || event.type === "release",
  );
  const event = [...(notable.length ? notable : work)].sort(
    (a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt),
  )[0];
  const xp = Math.max(
    0,
    getMetrics([...previous.events, ...fresh], now).xp -
      getMetrics(previous.events, now).xp,
  );
  const milestone = newlyUnlocked[0]?.title;
  const confetti =
    now - state.lastConfettiAt >= 8000 && (milestone || notable.length)
      ? milestone
        ? "milestone"
        : "ship"
      : null;
  if (confetti) state.lastConfettiAt = now;
  return {
    state,
    highlightedIds: fresh.map((event) => event.id),
    celebration: {
      id: `${now}:${event.id}`,
      event,
      count: work.length,
      xp,
      milestone,
      confetti,
    },
  };
}
