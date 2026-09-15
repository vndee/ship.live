import assert from "node:assert/strict";
import test from "node:test";
import { resolvePulseRange, aggregatePulse } from "./pulse.js";
const now = Date.parse("2026-09-15T12:00:00Z");
test("UTC presets and strict inclusive custom dates", () => {
  assert.equal(resolvePulseRange({}, now).from, "2026-09-09");
  assert.equal(
    resolvePulseRange({ period: "today" }, now).end,
    "2026-09-16T00:00:00.000Z",
  );
  assert.equal(
    resolvePulseRange(
      { period: "custom", from: "2024-02-29", to: "2024-02-29" },
      now,
    ).from,
    "2024-02-29",
  );
  for (const [from, to] of [
    ["2026-02-30", "2026-03-01"],
    ["2026-09-16", "2026-09-16"],
    ["2026-09-15", "2026-09-14"],
    ["2024-01-01", "2026-01-01"],
  ])
    assert.throws(() => resolvePulseRange({ period: "custom", from, to }, now));
});
test("weekly buckets clip at both selected edges and exclude bots and notes", () => {
  const range = resolvePulseRange(
    { period: "custom", from: "2026-08-01", to: "2026-09-15" },
    now,
  );
  const result = aggregatePulse(
    ["alice", "DEPENDABOT", "robot[bot]", "custom-bot", " github-actions "].map(
      (login, i) => ({
        id: String(i),
        type: "merge" as const,
        repo: "a/b",
        actor: { login },
        title: "Merged",
        occurredAt: "2026-09-15T10:00:00Z",
      }),
    ),
    range,
    now,
  );
  assert.equal(result.totals.count, 1);
  assert.equal(result.buckets[0].from, "2026-08-01");
  assert.equal(result.buckets[0].to, "2026-08-02");
  assert.equal(result.buckets.at(-1)?.to, "2026-09-15");
});
test("latest duplicate supplies the contribution and preserves contribution counting", () => {
  const range = resolvePulseRange({ period: "today" }, now);
  const event = {
    id: "one",
    type: "push" as const,
    repo: "a/b",
    actor: { login: "alice" },
    title: "Push",
    commits: 100,
    occurredAt: range.start,
  };
  const result = aggregatePulse(
    [
      { ...event, occurredAt: "2026-09-14T12:00:00Z" },
      event,
      event,
      { ...event, id: "note", type: "note" },
      { ...event, id: "alert", type: "alert" },
      { ...event, id: "future", occurredAt: "2026-09-15T13:00:00Z" },
      { ...event, id: "end", occurredAt: range.end },
    ],
    range,
    now,
  );
  assert.equal(result.totals.count, 1);
  assert.equal(result.buckets.length, 1);
  assert.deepEqual(result.totals, {
    count: 1,
    merges: 0,
    reviews: 0,
    releases: 0,
  });
});

test("rejects year zero consistently with PostgreSQL calendar dates", () => {
  assert.throws(
    () =>
      resolvePulseRange(
        { period: "custom", from: "0000-01-01", to: "0000-01-02" },
        now,
      ),
    /valid calendar dates/,
  );
});

test("comparison uses preceding equal UTC calendar range and counts unique human participants", () => {
  const range = resolvePulseRange(
    { period: "custom", from: "2026-09-01", to: "2026-09-03" },
    now,
  );
  const event = {
    id: "current",
    type: "merge" as const,
    actor: { login: " Alice " },
    repo: "team/a",
    title: "Merge",
    occurredAt: "2026-09-01T00:00:00Z",
  };
  const result = aggregatePulse(
    [
      event,
      { ...event, id: "review", type: "review", actor: { login: "alice" } },
      {
        ...event,
        id: "previous",
        type: "release",
        actor: { login: "bob" },
        occurredAt: "2026-08-29T00:00:00Z",
      },
      {
        ...event,
        id: "last-previous",
        actor: { login: "carol" },
        occurredAt: "2026-08-31T23:59:59Z",
      },
      { ...event, id: "too-early", occurredAt: "2026-08-28T23:59:59Z" },
      { ...event, id: "bot", actor: { login: "renovate" } },
    ],
    range,
    now,
  );
  assert.ok(result.comparison, "both periods must be returned");
  assert.equal(result.comparison.previous.range.from, "2026-08-29");
  assert.equal(result.comparison.previous.range.to, "2026-08-31");
  assert.deepEqual(result.comparison.previous.totals, {
    count: 2,
    merges: 1,
    releases: 1,
    reviews: 0,
  });
  assert.equal(result.comparison.previous.participants, 2);
  assert.equal(result.comparison.currentParticipants, 1);
  assert.equal(result.comparison.currentIncomplete, false);
  assert.deepEqual(result.comparison.previous.coverage, result.coverage);
});

test("today comparison marks the current period incomplete and preserves empty previous totals", () => {
  const result = aggregatePulse(
    [],
    resolvePulseRange({ period: "today" }, now),
    now,
  );
  assert.ok(result.comparison);
  assert.equal(result.comparison.previous.range.from, "2026-09-14");
  assert.equal(result.comparison.previous.range.to, "2026-09-14");
  assert.equal(result.comparison.previous.totals.count, 0);
  assert.equal(result.comparison.previous.participants, 0);
  assert.equal(result.comparison.currentIncomplete, true);
});

test("duplicates use the latest timestamp once across both comparison periods regardless of input order", () => {
  const range = resolvePulseRange({ period: "today" }, now);
  const earlier = {
    id: "replayed",
    type: "release" as const,
    repo: "team/api",
    actor: { login: "bob" },
    title: "Release",
    occurredAt: "2026-09-14T10:00:00Z",
  };
  const latest = {
    ...earlier,
    type: "merge" as const,
    actor: { login: "alice" },
    occurredAt: "2026-09-15T10:00:00Z",
  };
  for (const events of [
    [earlier, latest],
    [latest, earlier],
  ]) {
    const result = aggregatePulse(events, range, now);
    assert.deepEqual(result.totals, {
      count: 1,
      merges: 1,
      reviews: 0,
      releases: 0,
    });
    assert.deepEqual(result.comparison?.previous.totals, {
      count: 0,
      merges: 0,
      reviews: 0,
      releases: 0,
    });
    assert.equal(result.comparison?.previous.participants, 0);
    assert.equal(result.comparison?.currentParticipants, 1);
    assert.equal(result.coverage.earliestStoredAt, "2026-09-15T10:00:00.000Z");
  }
});

test("latest duplicate is chosen before the future-time boundary, like stored Pulse queries", () => {
  const event = {
    id: "replayed",
    type: "merge" as const,
    repo: "team/api",
    actor: { login: "alice" },
    title: "Merge",
    occurredAt: "2026-09-15T10:00:00Z",
  };
  const result = aggregatePulse(
    [event, { ...event, occurredAt: "2026-09-15T13:00:00Z" }],
    resolvePulseRange({ period: "today" }, now),
    now,
  );
  assert.equal(result.totals.count, 0);
  assert.equal(result.coverage.earliestStoredAt, null);
});

test("equal-time duplicates keep aggregates deterministic when contribution metadata differs", () => {
  const event = {
    id: "replayed",
    type: "release" as const,
    repo: "team/api",
    actor: { login: "bob" },
    title: "Release",
    occurredAt: "2026-09-15T10:00:00Z",
  };
  const duplicate = {
    ...event,
    type: "merge" as const,
    actor: { login: "alice" },
  };
  const range = resolvePulseRange({ period: "today" }, now);
  const left = aggregatePulse([event, duplicate], range, now);
  const right = aggregatePulse([duplicate, event], range, now);
  assert.deepEqual(left, right);
  assert.equal(left.totals.count, 1);
});
