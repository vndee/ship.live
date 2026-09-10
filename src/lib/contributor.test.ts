import assert from "node:assert/strict";
import test from "node:test";
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
  assert.deepEqual([profile.rank, profile.weeklyXp], [1, 45]);
  assert.deepEqual(
    [profile.xp30, profile.contributions30, profile.activeDays30],
    [51, 4, 2],
  );
  assert.deepEqual(
    profile.byType.map(({ type, count, xp }) => [type, count, xp]),
    [
      ["review", 2, 15],
      ["merge", 1, 30],
      ["push", 1, 6],
    ],
  );
  assert.deepEqual(
    profile.recent.map(({ event, points }) => [event.id, points]),
    [
      ["e3", 0],
      ["e2", 15],
      ["e1", 30],
      ["e4", 6],
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
    xp: 45,
  });
  assert.equal(profile.xpHistory[0].date, "2026-08-11");
  const { heatmap } = profile;
  assert.equal(heatmap.length, HEATMAP_WEEKS * 7);
  // Monday twelve weeks back starts the grid; Thursday–Sunday are still ahead.
  assert.equal(heatmap[0]?.date, "2026-06-22");
  assert.deepEqual(heatmap.slice(-4), [null, null, null, null]);
  assert.deepEqual(heatmap.at(-5), { date: "2026-09-09", count: 3, xp: 45 });
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
