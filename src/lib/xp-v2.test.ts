import assert from "node:assert/strict";
import test from "node:test";
import type { ActivityEvent } from "../../shared/types";
import { getCreditedEvents, getMetrics, getLeaderboard } from "./activity";
import { getContributorProfile } from "./contributor";

const now = Date.parse("2026-09-17T12:00:00Z");
const event = (
  id: string,
  type: ActivityEvent["type"],
  rest = {},
): ActivityEvent => ({
  id,
  type,
  repo: "team/api",
  actor: { login: "alice" },
  number: 1,
  title: "Change",
  occurredAt: "2026-09-17T10:00:00Z",
  ...rest,
});

test("splitting commits and opening a PR cannot inflate delivery XP or LOC weight", () => {
  const events = [
    event("m", "merge", { additions: 800, deletions: 100 }),
    event("p", "pr"),
    event("c", "push", { commits: 100 }),
  ];
  assert.equal(getMetrics(events, now).xp, 30);
  assert.equal(
    getMetrics([event("tiny", "merge", { additions: 1 })], now).xp,
    30,
  );
});

test("peer review is credited once over the PR lifetime in chronological order", () => {
  const early = event("r1", "review", {
    pullRequestAuthor: "bob",
    occurredAt: "2026-09-13T10:00:00Z",
  });
  const later = event("r2", "review", { pullRequestAuthor: "bob" });
  const items = getCreditedEvents([later, early], now);
  assert.equal(items.find((i) => i.event.id === "r1")?.points, 10);
  assert.equal(items.find((i) => i.event.id === "r2")?.points, 0);
  assert.equal(getMetrics([later, early], now).xp, 0);
  assert.equal(getLeaderboard([later, early], now)[0].xp, 0);
  assert.equal(getContributorProfile([later, early], "alice", now).weeklyXp, 0);
});

test("self reviews and unidentified PR authors cannot establish peer contribution", () => {
  const events = [
    event("self", "review", { pullRequestAuthor: "ALICE" }),
    event("unknown", "review", { number: 2 }),
    event("peer", "review", { number: 3, pullRequestAuthor: "bob" }),
  ];
  assert.equal(getMetrics(events, now).xp, 10);
  assert.equal(getMetrics(events, now).reviews, 3);
});

test("stored review eligibility survives a truncated history and cannot bypass peer checks", () => {
  assert.equal(
    getMetrics(
      [
        event("repeat", "review", {
          pullRequestAuthor: "bob",
          reviewCredit: false,
        }),
      ],
      now,
    ).xp,
    0,
  );
  assert.equal(
    getMetrics(
      [
        event("self", "review", {
          pullRequestAuthor: "alice",
          reviewCredit: true,
        }),
      ],
      now,
    ).xp,
    0,
  );
});

test("historical PR activity can establish the author even outside the selected week", () => {
  const pr = event("pr", "pr", {
    actor: { login: "bob" },
    occurredAt: "2026-09-01T00:00:00Z",
  });
  assert.equal(getMetrics([event("review", "review"), pr], now).xp, 10);
});

test("zero-point activity cannot break a leaderboard tie in the spammer's favor", () => {
  const events = [
    event("a", "merge"),
    event("b", "merge", { actor: { login: "bob" } }),
    event("b-push", "push", { actor: { login: "bob" }, commits: 20 }),
  ];
  assert.deepEqual(
    getLeaderboard(events, now).map((p) => p.login),
    ["alice", "bob"],
  );
});

test("placeholder authors never establish peer review", () => {
  for (const author of ["unknown", " UNKNOWN ", " ", "\tUNKNOWN\n\u00a0"]) {
    assert.equal(
      getMetrics([event("r", "review", { pullRequestAuthor: author })], now).xp,
      0,
    );
    assert.equal(
      getMetrics(
        [event("r", "review"), event("pr", "pr", { actor: { login: author } })],
        now,
      ).xp,
      0,
    );
  }
});

test("known author evidence from another review credits the earliest retained review", () => {
  const early = event("early", "review", {
    occurredAt: "2026-09-13T10:00:00Z",
  });
  const later = event("later", "review", { pullRequestAuthor: "bob" });
  const credits = getCreditedEvents([later, early], now);
  assert.equal(credits.find((item) => item.event.id === "early")?.points, 10);
  assert.equal(credits.find((item) => item.event.id === "later")?.points, 0);
  assert.equal(getMetrics([later, early], now).xp, 0);
});
