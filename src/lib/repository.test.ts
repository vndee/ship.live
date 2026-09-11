import assert from "node:assert/strict";
import test from "node:test";
import type { ActivityEvent } from "../../shared/types";
import { createDemoWall } from "./demo-wall";
import { getRepositoryProfile, getRepositorySignals } from "./repository";

const now = Date.parse("2026-09-10T12:00:00Z");
const event = (
  id: string,
  type: ActivityEvent["type"],
  login: string,
  daysAgo: number,
  repo = "acme/api",
): ActivityEvent => ({
  id,
  type,
  actor: { login },
  repo,
  title: `Change ${id}`,
  occurredAt: new Date(now - daysAgo * 86_400_000).toISOString(),
});

test("a repository profile counts its own activity, contributors first by count", () => {
  const profile = getRepositoryProfile(
    [
      event("1", "merge", "sarahpark", 0),
      event("2", "review", "leowang", 1),
      event("3", "merge", "sarahpark", 2),
      event("4", "merge", "alexchen", 40),
      event("5", "merge", "leowang", 0, "acme/web"),
      event("6", "merge", "leowang", 0.5, "acme/web"),
      event("7", "merge", "leowang", 0.6, "acme/web"),
      event("8", "review", "sarahpark", 0.7, "acme/web"),
    ],
    "acme/api",
    now,
  );
  assert.equal(profile.repository, "acme/api");
  // acme/web had four contributions this week, acme/api three.
  assert.equal(profile.rank, 2);
  assert.equal(profile.contributions30, 3);
  assert.deepEqual(
    profile.contributors.map((person) => [person.login, person.count]),
    [
      ["sarahpark", 2],
      ["leowang", 1],
    ],
  );
  assert.deepEqual(
    profile.byType.map((entry) => entry.type),
    ["merge", "review"],
  );
  assert.equal(profile.history.length, 30);
  assert.equal(profile.recent[0].event.id, "1");
  assert.equal(profile.firstSeen, event("4", "merge", "x", 40).occurredAt);
  assert.equal(profile.latestAt, event("1", "merge", "x", 0).occurredAt);
});

test("a repository without activity has no rank and empty lists", () => {
  const profile = getRepositoryProfile([], "acme/api", now);
  assert.equal(profile.rank, null);
  assert.deepEqual(profile.contributors, []);
  assert.equal(profile.firstSeen, null);
});

test("wall signals match a repository with or without its owner", () => {
  const wall = createDemoWall(now);
  const signals = getRepositorySignals(wall, "acme/platform", now);
  assert.ok(signals.pullRequests.length > 0);
  assert.ok(
    signals.pullRequests.every((item) => item.repository === "platform"),
  );
  assert.deepEqual(
    signals.deployments.map((item) => item.environment),
    ["production"],
  );
  assert.deepEqual(getRepositorySignals(undefined, "acme/platform", now), {
    pullRequests: [],
    deployments: [],
  });
  // Another owner's repository of the same name does not match.
  assert.equal(
    getRepositorySignals(
      {
        ...wall,
        repositories: [
          { ...wall.repositories[0], repository: "other/platform" },
        ],
      },
      "acme/platform",
      now,
    ).pullRequests.length,
    0,
  );
});
