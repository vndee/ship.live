import assert from "node:assert/strict";
import test from "node:test";
import { getLeaderboardChanges } from "./leaderboard";
import type { LeaderboardEntry } from "./activity";

const person = (login: string, xp: number, rank: number): LeaderboardEntry => ({
  login,
  xp,
  rank,
  merges: 0,
  reviews: 0,
  contributions: 1,
});
test("live rank changes track people across reordering without awarding initial XP", () => {
  assert.equal(getLeaderboardChanges([], [person("a", 30, 1)]).size, 0);
  const changed = getLeaderboardChanges(
    [person("a", 30, 1), person("B", 15, 2)],
    [person("b", 45, 1), person("a", 30, 2)],
  );
  assert.deepEqual(changed.get("b"), { xp: 30, ranks: 1 });
  assert.deepEqual(changed.get("a"), { xp: 0, ranks: -1 });
});
test("a week reset never celebrates removed XP", () => {
  assert.equal(
    getLeaderboardChanges([person("a", 100, 1)], [person("a", 5, 1)]).size,
    0,
  );
});
