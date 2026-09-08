import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActivityEvent } from "../../shared/types";
import {
  emptyPrivateFeed,
  isAccessFailure,
  privateFeedReducer,
} from "./privateFeed.ts";
const event: ActivityEvent = {
  id: "private-1",
  actor: { login: "builder" },
  type: "merge",
  repo: "private/repo",
  title: "Private work",
  occurredAt: "2026-09-07T10:00:00Z",
};

test("a fresh snapshot removes revoked repository activity and deleted notes", () => {
  const before = privateFeedReducer(emptyPrivateFeed, {
    type: "snapshot",
    generation: 0,
    events: [event],
    updatedAt: event.occurredAt,
  });
  const after = privateFeedReducer(before, {
    type: "snapshot",
    generation: 0,
    events: [],
    updatedAt: event.occurredAt,
  });
  assert.deepEqual(after.events, []);
});

test("logout clears data and rejects late responses from the previous identity", () => {
  const before = {
    ...emptyPrivateFeed,
    events: [event],
    notice: "Private repository notice",
    streaming: true,
  };
  const after = privateFeedReducer(before, { type: "reset", generation: 1 });
  assert.deepEqual(after.events, []);
  assert.equal(after.notice, "");
  assert.equal(after.streaming, false);
  assert.equal(after.revision, 1);
  for (const action of [
    {
      type: "snapshot" as const,
      generation: 0,
      events: [event],
      updatedAt: event.occurredAt,
    },
    { type: "streaming" as const, generation: 0, value: true },
    { type: "error" as const, generation: 0, message: "Private error" },
  ])
    assert.equal(privateFeedReducer(after, action), after);
});

test("access and permission-verification failures require clearing the private view", () => {
  for (const status of [401, 403, 503])
    assert.equal(isAccessFailure(status), true);
  for (const status of [400, 404, 429, 500])
    assert.equal(isAccessFailure(status), false);
});

test("a failed private feed revalidation clears cached content and rejects its older responses", () => {
  const before = {
    ...emptyPrivateFeed,
    events: [event],
    notice: "Private repository notice",
    streaming: true,
    loading: true,
  };
  for (const failure of [
    "Network request failed",
    "Request timed out",
    "Server returned 500",
  ]) {
    const after = privateFeedReducer(before, {
      type: "error",
      generation: 1,
      message: failure,
    });
    assert.deepEqual(after.events, []);
    assert.equal(after.notice, "");
    assert.equal(after.streaming, false);
    assert.equal(after.loading, false);
    assert.equal(after.error, failure);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(
      privateFeedReducer(after, {
        type: "snapshot",
        generation: 0,
        events: [event],
        updatedAt: event.occurredAt,
      }),
      after,
    );
  }
});
