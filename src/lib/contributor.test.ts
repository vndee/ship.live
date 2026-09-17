import assert from "node:assert/strict";
import test from "node:test";
import { resolvePulseRange } from "../../shared/pulse";
import type { ActivityEvent } from "../../shared/types";
import { getContributorProfile, HEATMAP_WEEKS } from "./contributor.js";

// Wednesday; the UTC week started Monday 2026-09-07.
const now = Date.parse("2026-09-09T12:00:00Z");
const event = (
  id: string,
  login: string,
  type: ActivityEvent["type"],
  occurredAt: string,
  extra: Partial<ActivityEvent> = {},
): ActivityEvent => ({
  id,
  type,
  ...(type === "review" ? { number: 99, pullRequestAuthor: "teammate" } : {}),
  actor: { login },
  repo: "acme/api",
  title: `${type} ${id}`,
  occurredAt,
  ...extra,
});
const events = [
  event("e1", "alex", "merge", "2026-09-09T09:00:00Z", { number: 4 }),
  event("e2", "Alex", "review", "2026-09-09T10:00:00Z", { number: 5 }),
  // A second review of the same pull request that day earns nothing.
  event("e3", "alex", "review", "2026-09-09T11:00:00Z", { number: 5 }),
  event("e4", "alex", "push", "2026-09-01T08:00:00Z", { commits: 3 }),
  event("e5", "sam", "merge", "2026-09-09T08:00:00Z", { number: 6 }),
  event("e6", "alex", "release", "2026-07-01T00:00:00Z"),
  // Future activity is ignored, like on the board.
  event("e7", "alex", "merge", "2026-09-10T00:00:00Z", { number: 7 }),
];

test("a contributor profile credits activity like the weekly board", () => {
  const profile = getContributorProfile(events, "ALEX", now);
  assert.equal(profile.login, "alex");
  assert.deepEqual([profile.rank, profile.weeklyXp], [1, 40]);
  assert.deepEqual(
    [profile.xp30, profile.contributions30, profile.activeDays30],
    [40, 4, 2],
  );
  assert.deepEqual(
    profile.byType.map(({ type, count, xp }) => [type, count, xp]),
    [
      ["review", 2, 10],
      ["merge", 1, 30],
      ["push", 1, 0],
    ],
  );
  assert.deepEqual(
    profile.recent.map(({ event, points }) => [event.id, points]),
    [
      ["e3", 0],
      ["e2", 10],
      ["e1", 30],
      ["e4", 0],
      ["e6", 50],
    ],
  );
  assert.equal(profile.firstSeen, "2026-07-01T00:00:00Z");
});

test("daily history and the heatmap use whole UTC days and weeks", () => {
  const profile = getContributorProfile(events, "alex", now);
  assert.equal(profile.xpHistory.length, 30);
  assert.deepEqual(profile.xpHistory.at(-1), {
    date: "2026-09-09",
    count: 3,
    xp: 40,
  });
  assert.equal(profile.xpHistory[0].date, "2026-08-11");
  const { heatmap } = profile;
  assert.equal(heatmap.length, HEATMAP_WEEKS * 7);
  // Monday twelve weeks back starts the grid; Thursday–Sunday are still ahead.
  assert.equal(heatmap[0]?.date, "2026-06-22");
  assert.deepEqual(heatmap.slice(-4), [null, null, null, null]);
  assert.deepEqual(heatmap.at(-5), { date: "2026-09-09", count: 3, xp: 40 });
  assert.deepEqual(heatmap[9], { date: "2026-07-01", count: 1, xp: 50 });
});

test("someone without received activity gets an empty profile", () => {
  const profile = getContributorProfile(events, "nobody", now);
  assert.deepEqual(
    [profile.rank, profile.weeklyXp, profile.xp30, profile.recent.length],
    [null, 0, 0, 0],
  );
  assert.ok(profile.heatmap.every((day) => !day || day.count === 0));
  assert.equal(profile.firstSeen, null);
});

test("historical contributor profiles use the same selected range for rank, XP, breakdown, and daily history", () => {
  const range = resolvePulseRange(
    { period: "custom", from: "2026-07-01", to: "2026-07-07" },
    now,
  );
  const historical = [
    ...events,
    event("last", "alex", "review", "2026-07-07T23:59:59.999Z"),
    event("end", "alex", "release", range.end),
    event("rival", "sam", "release", range.start),
  ];
  const profile = getContributorProfile(historical, "alex", now, range);
  assert.equal(profile.rank, 1);
  assert.equal(profile.weeklyXp, 60);
  assert.equal(profile.xp30, 60);
  assert.equal(profile.contributions30, 2);
  assert.equal(profile.activeDays30, 2);
  assert.deepEqual(
    profile.byType.map((item) => item.type),
    ["release", "review"],
  );
  assert.equal(profile.xpHistory.length, 7);
  assert.deepEqual(profile.xpHistory[0], {
    date: range.from,
    count: 1,
    xp: 50,
  });
  assert.deepEqual(profile.xpHistory.at(-1), {
    date: range.to,
    count: 1,
    xp: 10,
  });
  assert.equal(profile.heatmap.length, 7);
  assert.deepEqual(
    profile.recent.map((item) => item.event.id),
    ["last", "e6"],
  );
});

test("selected contributor periods include quiet days and exclude future activity", () => {
  const range = resolvePulseRange({ period: "today" }, now);
  const profile = getContributorProfile(
    [...events, event("future-today", "alex", "merge", "2026-09-09T13:00:00Z")],
    "alex",
    now,
    range,
  );
  assert.equal(profile.contributions30, 3);
  assert.equal(profile.xpHistory.length, 1);
  assert.equal(profile.xpHistory[0].xp, 40);
  const empty = getContributorProfile(events, "nobody", now, range);
  assert.equal(empty.rank, null);
  assert.deepEqual(empty.xpHistory, [{ date: range.from, count: 0, xp: 0 }]);
});
