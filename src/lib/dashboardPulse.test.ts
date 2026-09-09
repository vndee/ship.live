import assert from "node:assert/strict";
import test from "node:test";
import type { ActivityEvent } from "../../shared/types";
import { getDashboardPulse, observeActivity } from "./dashboardPulse";

const now = Date.parse("2026-09-09T12:00:00Z");
const event = (
  id: string,
  type: ActivityEvent["type"] = "merge",
  time = now,
  login = "alex",
): ActivityEvent => ({
  id,
  type,
  actor: { login },
  repo: "team/app",
  title: id,
  occurredAt: new Date(time).toISOString(),
});

test("today and rhythm use UTC, deduplicate and exclude notes, bots and future events", () => {
  const recent = event("merge");
  const pulse = getDashboardPulse(
    [
      recent,
      recent,
      event("review", "review"),
      event("yesterday", "release", Date.parse("2026-09-08T23:59:59Z")),
      event("note", "note"),
      event("bot", "merge", now, "dependabot[bot]"),
      event("future", "merge", now + 1000),
    ],
    now,
  );
  assert.equal(pulse.today.count, 2);
  assert.equal(pulse.today.merges, 1);
  assert.equal(pulse.today.reviews, 1);
  assert.equal(pulse.days.length, 7);
  assert.equal(pulse.days[6].count, 2);
  assert.equal(pulse.days[5].count, 1);
  assert.equal(pulse.total, 3);
  assert.equal(pulse.nextMilestone?.id, "team-release");
  assert.equal(pulse.remaining, 4);
});

test("the first snapshot, repeated snapshots and historical backfills never celebrate", () => {
  const first = observeActivity(undefined, [event("first")], now);
  assert.equal(first.celebration, null);
  const repeated = observeActivity(
    first.state,
    [event("first"), event("imported", "release", now - 3600000)],
    now + 1000,
  );
  assert.equal(repeated.celebration, null);
  assert.deepEqual(repeated.highlightedIds, []);
  const fresh = observeActivity(
    repeated.state,
    [event("new", "merge", now + 1000), event("first")],
    now + 1000,
  );
  assert.equal(fresh.celebration?.xp, 30);
  assert.equal(fresh.celebration?.confetti, "ship");
  const removed = observeActivity(fresh.state, [], now + 2000);
  assert.equal(
    observeActivity(
      removed.state,
      [event("new", "merge", now + 1000)],
      now + 3000,
    ).celebration,
    null,
  );
});

test("a first contribution after a verified empty workspace can celebrate", () => {
  const baseline = observeActivity(undefined, [], now);
  const fresh = observeActivity(
    baseline.state,
    [event("new", "release", now + 100)],
    now + 100,
  );
  assert.deepEqual(fresh.highlightedIds, ["new"]);
  assert.equal(fresh.celebration?.xp, 50);
});

test("review credit respects previous awards and activity bursts respect the confetti cooldown", () => {
  const review = { ...event("review", "review"), number: 9 };
  const baseline = observeActivity(undefined, [review], now);
  const fresh = observeActivity(
    baseline.state,
    [review, { ...review, id: "review-again" }],
    now + 100,
  );
  assert.equal(fresh.celebration?.xp, 0);
  assert.equal(fresh.celebration?.confetti, null);
  const merged = observeActivity(
    fresh.state,
    [review, event("merged", "merge", now + 200)],
    now + 200,
  );
  assert.equal(merged.celebration?.confetti, "ship");
  const burst = observeActivity(
    merged.state,
    [
      review,
      event("merged", "merge", now + 200),
      event("released", "release", now + 300),
    ],
    now + 300,
  );
  assert.equal(burst.celebration?.confetti, null);
  assert.deepEqual(burst.highlightedIds, ["released"]);
});

test("milestones celebrate once when live work crosses the target, not on replay or permission restoration", () => {
  const history = Array.from({ length: 29 }, (_, i) =>
    event(`merge-${i}`, "merge", now - 3600000),
  );
  const baseline = observeActivity(undefined, history, now);
  const all = [event("last"), ...history];
  const reached = observeActivity(baseline.state, all, now + 1000);
  assert.equal(reached.celebration?.milestone, "Ship it, together");
  assert.equal(reached.celebration?.confetti, "milestone");
  const hidden = observeActivity(reached.state, [], now + 10000);
  const restored = observeActivity(
    hidden.state,
    [event("one-more", "merge", now + 12000), ...all],
    now + 12000,
  );
  assert.equal(restored.celebration?.milestone, undefined);
});

test("paused or hidden views consume new events without replaying effects on resume", () => {
  const baseline = observeActivity(undefined, [], now);
  const events = [event("hidden")];
  const quiet = observeActivity(baseline.state, events, now + 100, false);
  assert.equal(quiet.celebration, null);
  assert.deepEqual(quiet.highlightedIds, []);
  assert.equal(
    observeActivity(quiet.state, events, now + 200).celebration,
    null,
  );
});

test("automated and invalid activity does not trigger celebrations", () => {
  const baseline = observeActivity(undefined, [], now);
  const fresh = observeActivity(
    baseline.state,
    [
      event("bot", "release", now, "renovate"),
      event("future", "merge", now + 60000),
      { ...event("invalid"), occurredAt: "invalid" },
    ],
    now,
  );
  assert.equal(fresh.celebration, null);
});

test("resuming ignores activity from the pause even when its snapshot arrives late", () => {
  const baseline = observeActivity(undefined, [], now);
  const paused = observeActivity(baseline.state, [], now + 100, false);
  const resumed = observeActivity(paused.state, [], now + 1000);
  const caughtUp = observeActivity(
    resumed.state,
    [event("during-pause", "release", now + 500)],
    now + 1100,
  );
  assert.equal(caughtUp.celebration, null);
  const live = observeActivity(
    caughtUp.state,
    [event("after-resume", "merge", now + 1200), ...caughtUp.state.events],
    now + 1300,
  );
  assert.deepEqual(live.highlightedIds, ["after-resume"]);
  assert.equal(live.celebration?.xp, 30);
});
