import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActivityEvent } from "../../shared/types";
import {
  getAchievements,
  getDailyActivity,
  getLeaderboard,
  getMetrics,
  getWeekStart,
} from "./activity.ts";
import { createDemoEvents } from "./demo.ts";

const NOW = Date.parse("2026-09-09T12:00:00Z");

function event(
  id: string,
  type: ActivityEvent["type"],
  overrides: Partial<ActivityEvent> = {},
): ActivityEvent {
  return {
    id,
    type,
    actor: { login: "alexchen" },
    repo: "platform",
    title: "Improve developer setup",
    occurredAt: "2026-09-08T10:00:00Z",
    ...overrides,
  };
}

test("the UTC week changes at Monday midnight, including Sunday in the prior week", () => {
  assert.equal(
    getWeekStart(Date.parse("2026-09-06T23:59:59Z")).toISOString(),
    "2026-08-31T00:00:00.000Z",
  );
  assert.equal(
    getWeekStart(Date.parse("2026-09-07T00:00:00Z")).toISOString(),
    "2026-09-07T00:00:00.000Z",
  );
});

test("weekly metrics exclude duplicates, bots, invalid dates, previous weeks and future events", () => {
  const merge = event("merge-1", "merge", {
    occurredAt: "2026-09-07T00:00:00Z",
  });
  const events = [
    merge,
    merge,
    event("review-1", "review", { actor: { login: "minhnguyen" } }),
    event("release-1", "release"),
    event("issue-1", "issue"),
    event("pr-1", "pr"),
    event("push-1", "push"),
    event("old", "merge", { occurredAt: "2026-09-06T23:59:59Z" }),
    event("future", "merge", { occurredAt: "2026-09-09T12:00:01Z" }),
    event("bot", "merge", { actor: { login: "dependabot[bot]" } }),
    event("bot-legacy", "merge", { actor: { login: "renovate" } }),
    event("invalid", "merge", { occurredAt: "not-a-date" }),
  ];
  assert.deepEqual(getMetrics(events, NOW), {
    merges: 1,
    reviews: 1,
    releases: 1,
    contributors: 2,
    xp: 110,
    total: 6,
  });
});

test("review credit is capped per person, repository, pull request and UTC day", () => {
  const events = [
    event("review-1", "review", { number: 42 }),
    event("review-2", "review", { number: 42, actor: { login: "AlexChen" } }),
    event("review-next-day", "review", {
      number: 42,
      occurredAt: "2026-09-09T10:00:00Z",
    }),
    event("review-other-repo", "review", { number: 42, repo: "web-app" }),
    event("review-other-pr", "review", { number: 43 }),
    event("review-other-person", "review", {
      number: 42,
      actor: { login: "sarahpark" },
    }),
    event("review-unidentified-1", "review"),
    event("review-unidentified-2", "review"),
  ];
  assert.equal(getMetrics(events, NOW).xp, 105);
  assert.equal(getMetrics(events, NOW).reviews, 8);
  const leaders = getLeaderboard(events, NOW);
  assert.equal(leaders.length, 2);
  assert.equal(leaders[0].xp, 90);
  assert.equal(leaders[0].reviews, 7);
});

test("leaderboard gives shared work credit, stable ranks and no credit for push volume", () => {
  const events = [
    event("merge-1", "merge"),
    event("review-1", "review", {
      actor: {
        login: "sarahpark",
        avatarUrl: "https://example.test/sarah.png",
      },
    }),
    event("review-2", "review", { actor: { login: "sarahpark" } }),
    event("push-1", "push", { actor: { login: "minhnguyen" } }),
    event("old-release", "release", {
      actor: { login: "minhnguyen" },
      occurredAt: "2026-09-06T12:00:00Z",
    }),
  ];
  assert.deepEqual(getLeaderboard(events, NOW), [
    {
      login: "sarahpark",
      avatarUrl: "https://example.test/sarah.png",
      xp: 30,
      merges: 0,
      reviews: 2,
      contributions: 2,
      rank: 1,
    },
    {
      login: "alexchen",
      xp: 30,
      merges: 1,
      reviews: 0,
      contributions: 1,
      rank: 2,
    },
    {
      login: "minhnguyen",
      xp: 0,
      merges: 0,
      reviews: 0,
      contributions: 1,
      rank: 3,
    },
  ]);
});

test("daily activity fills quiet UTC days and keeps events on the correct side of midnight", () => {
  const events = [
    event("sunday", "merge", { occurredAt: "2026-09-06T23:59:59Z" }),
    event("monday", "review", { occurredAt: "2026-09-07T00:00:00Z" }),
    event("today", "release", { occurredAt: "2026-09-09T11:00:00Z" }),
    event("future", "release", { occurredAt: "2026-09-09T13:00:00Z" }),
  ];
  assert.deepEqual(getDailyActivity(events, 4, NOW), [
    { date: "2026-09-06", label: "Sun", count: 1, merges: 1, reviews: 0 },
    { date: "2026-09-07", label: "Mon", count: 1, merges: 0, reviews: 1 },
    { date: "2026-09-08", label: "Tue", count: 0, merges: 0, reviews: 0 },
    { date: "2026-09-09", label: "Wed", count: 1, merges: 0, reviews: 0 },
  ]);
  assert.deepEqual(getDailyActivity(events, 0, NOW), []);
});

test("team achievements unlock at their target and reset with the week", () => {
  const events = Array.from({ length: 31 }, (_, index) =>
    event(`merge-${index}`, "merge"),
  );
  const achievements = getAchievements(events, NOW);
  const merge = achievements.find(
    (achievement) => achievement.kind === "merge",
  );
  assert.equal(merge?.unlocked, true);
  assert.equal(merge?.progress, merge?.target);
  assert.equal(
    achievements.find((achievement) => achievement.kind === "review")?.unlocked,
    false,
  );
  assert.ok(
    getAchievements(events, Date.parse("2026-09-14T10:00:00Z")).every(
      (achievement) => achievement.progress === 0 && !achievement.unlocked,
    ),
  );
});

test("demo data is deterministic, distinct, human and safe to display as a fresh Monday sample", () => {
  const monday = Date.parse("2026-09-07T09:00:00Z");
  const events = createDemoEvents(monday);
  assert.deepEqual(events, createDemoEvents(monday));
  assert.equal(events.length, 120);
  assert.equal(new Set(events.map((item) => item.id)).size, events.length);
  assert.equal(new Set(events.map((item) => item.actor.login)).size, 6);
  assert.equal(new Set(events.map((item) => item.repo)).size, 5);
  assert.ok(
    events.every(
      (item) => !item.actor.avatarUrl && Date.parse(item.occurredAt) <= monday,
    ),
  );
  assert.ok(
    events.every(
      (item, index) =>
        index === 0 ||
        Date.parse(item.occurredAt) <= Date.parse(events[index - 1].occurredAt),
    ),
  );
  assert.ok(getMetrics(events, monday).merges >= 20);
  assert.ok(getMetrics(events, monday).reviews >= 30);
});

test("manual ship notes are visible activity without manufactured XP or milestones", () => {
  const notes = Array.from({ length: 50 }, (_, index) =>
    event(`note-${index}`, "note", {
      repo: "journal/notes",
      body: "A useful lesson from today's experiment.",
    }),
  );
  assert.equal(getMetrics(notes, NOW).total, 50);
  assert.equal(getMetrics(notes, NOW).xp, 0);
  assert.equal(getLeaderboard(notes, NOW)[0].xp, 0);
  assert.ok(
    getAchievements(notes, NOW).every((milestone) => milestone.progress === 0),
  );
});
