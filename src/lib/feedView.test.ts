import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActivityEvent } from "../../shared/types";
import {
  filterEvents,
  getTimelineCutoff,
  getTimelineRange,
  getViewCounts,
  getWindowEvents,
} from "./feedView.ts";

function event(
  id: string,
  overrides: Partial<ActivityEvent> = {},
): ActivityEvent {
  return {
    id,
    type: "merge",
    actor: { login: "alexchen" },
    repo: "platform",
    title: "Improve deployment recovery",
    occurredAt: "2026-09-09T12:00:00Z",
    ...overrides,
  };
}

test("timeline window includes both boundaries, sorts newest first and keeps bots as activity", () => {
  const start = Date.parse("2026-09-09T10:00:00Z");
  const end = Date.parse("2026-09-09T12:00:00Z");
  const events = [
    event("start", { occurredAt: "2026-09-09T10:00:00Z" }),
    event("before", { occurredAt: "2026-09-09T09:59:59.999Z" }),
    event("end"),
    event("bot", {
      occurredAt: "2026-09-09T11:00:00Z",
      actor: { login: "dependabot[bot]" },
    }),
    event("after", { occurredAt: "2026-09-09T12:00:00.001Z" }),
  ];
  assert.deepEqual(
    getWindowEvents(events, start, end).map((item) => item.id),
    ["end", "bot", "start"],
  );
  assert.deepEqual(
    events.map((item) => item.id),
    ["start", "before", "end", "bot", "after"],
  );
});

test("timeline window discards invalid timestamps and blank logins before deduplicating IDs", () => {
  const start = Date.parse("2026-09-09T10:00:00Z");
  const end = Date.parse("2026-09-09T12:00:00Z");
  const events = [
    event("duplicate", {
      occurredAt: "2026-09-09T10:00:00Z",
      title: "Old copy",
    }),
    event("invalid-time", { occurredAt: "not-a-date" }),
    event("missing-login", { actor: { login: "  " } }),
    event("invalid-then-valid", { actor: { login: "" } }),
    event("duplicate", {
      occurredAt: "2026-09-09T11:00:00Z",
      title: "New copy",
    }),
    event("invalid-then-valid"),
  ];
  const result = getWindowEvents(events, start, end);
  assert.deepEqual(
    result.map((item) => item.id),
    ["invalid-then-valid", "duplicate"],
  );
  assert.equal(result[1].title, "New copy");
  assert.deepEqual(getWindowEvents(events, end, start), []);
});

test("feed filters combine exact repository and event type with trimmed, case-insensitive search", () => {
  const events = [
    event("match", { type: "review", number: 42 }),
    event("other-type", { number: 42 }),
    event("other-repo", { type: "review", number: 42, repo: "platform-tools" }),
    event("other-title", {
      type: "review",
      title: "Refresh getting started documentation",
    }),
  ];
  assert.deepEqual(
    filterEvents(events, {
      repo: "platform",
      kind: "review",
      query: "  RECOVERY  ",
    }).map((item) => item.id),
    ["match"],
  );
  assert.deepEqual(
    filterEvents(events, {
      repo: "platform",
      kind: "review",
      query: "#42",
    }).map((item) => item.id),
    ["match"],
  );
  assert.equal(
    filterEvents(events, { repo: "", kind: "", query: "ALEXCHEN" }).length,
    4,
  );
  assert.equal(
    filterEvents(events, { repo: "", kind: "", query: "platform-tools" })
      .length,
    1,
  );
  assert.equal(
    filterEvents(events, { repo: "", kind: "", query: "42" }).length,
    3,
  );
  assert.equal(
    filterEvents(events, { repo: "", kind: "", query: "   " }).length,
    4,
  );
  assert.equal(
    filterEvents(events, { repo: "Platform", kind: "", query: "" }).length,
    0,
  );
  assert.equal(
    filterEvents(events, { repo: "", kind: "", query: "undefined" }).length,
    0,
  );
});

test("visible counts include bot contributions and merge human login casing", () => {
  const events = [
    event("merge"),
    event("review", { type: "review", actor: { login: "AlexChen" } }),
    event("release", { type: "release", actor: { login: "release-bot" } }),
    event("push", { type: "push", actor: { login: "minhnguyen" } }),
    event("issue", { type: "issue", actor: { login: "minhnguyen" } }),
    event("pr", { type: "pr", actor: { login: "alexchen" } }),
  ];
  assert.deepEqual(getViewCounts(events), {
    merges: 1,
    reviews: 1,
    releases: 1,
    contributors: 3,
    total: 6,
  });
  assert.deepEqual(getViewCounts([]), {
    merges: 0,
    reviews: 0,
    releases: 0,
    contributors: 0,
    total: 0,
  });
});

test("timeline ranges use trailing elapsed time, including across UTC week boundaries", () => {
  const end = Date.parse("2026-09-07T12:34:56Z");
  assert.deepEqual(getTimelineRange("24h", end), {
    start: Date.parse("2026-09-06T12:34:56Z"),
    end,
  });
  assert.deepEqual(getTimelineRange("7d", end), {
    start: Date.parse("2026-08-31T12:34:56Z"),
    end,
  });
  assert.deepEqual(getTimelineRange("30d", end), {
    start: Date.parse("2026-08-08T12:34:56Z"),
    end,
  });
});

test("timeline scrubbing interpolates the range and clamps both ends", () => {
  assert.equal(getTimelineCutoff(1_000, 5_000, 0), 1_000);
  assert.equal(getTimelineCutoff(1_000, 5_000, 25), 2_000);
  assert.equal(getTimelineCutoff(1_000, 5_000, 100), 5_000);
  assert.equal(getTimelineCutoff(1_000, 5_000, -20), 1_000);
  assert.equal(getTimelineCutoff(1_000, 5_000, 130), 5_000);
  assert.equal(getTimelineCutoff(1_000, 1_000, 50), 1_000);
});
