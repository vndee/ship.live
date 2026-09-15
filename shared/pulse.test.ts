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
test("range filtering precedes duplicate suppression and preserves contribution counting", () => {
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
