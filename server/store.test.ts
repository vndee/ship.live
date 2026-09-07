import assert from "node:assert/strict";
import test from "node:test";
import type { ActivityEvent } from "../shared/types.js";
import { MemoryEventStore } from "./store.js";

const event: ActivityEvent = {
  id: "team:pr:1:merged",
  type: "merge",
  actor: { login: "dev" },
  repo: "team/service",
  title: "A useful improvement",
  occurredAt: "2026-09-07T08:00:00Z",
};

test("the feed view is bounded without removing older stored events", async () => {
  const store = new MemoryEventStore();
  await store.merge(
    "team",
    Array.from({ length: 2100 }, (_, index) => ({
      ...event,
      id: `event-${index}`,
    })),
  );
  assert.equal((await store.list("team")).length, 2000);
  assert.equal((await store.get("team", "event-2099"))?.id, "event-2099");
});

test("reclosing an issue keeps credit on its original closure even across weeks or out-of-order deliveries", async () => {
  const store = new MemoryEventStore();
  const original: ActivityEvent = {
    ...event,
    id: "team/service:issue:10:closed",
    type: "issue",
    occurredAt: "2026-09-07T08:00:00.000Z",
  };
  await store.merge("team", [original], { deliveryId: "closed-first" });
  await store.merge(
    "team",
    [
      {
        ...original,
        occurredAt: "2026-09-14T08:00:00.000Z",
        actor: { login: "another-engineer" },
      },
    ],
    { deliveryId: "closed-again" },
  );
  assert.deepEqual(await store.list("team"), [original]);
  const earlier = { ...original, occurredAt: "2026-08-31T08:00:00.000Z" };
  await store.merge("team", [earlier], {
    deliveryId: "delayed-earlier-closure",
  });
  assert.deepEqual(await store.list("team"), [earlier]);
});
