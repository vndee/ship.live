import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ActivityEvent } from "../shared/types.js";
import { EventStore } from "./store.js";

const event: ActivityEvent = {
  id: "team:pr:1:merged",
  type: "merge",
  actor: { login: "dev" },
  repo: "team/service",
  title: "A useful improvement",
  occurredAt: "2026-09-07T08:00:00Z",
};

test("persistent webhook delivery deduplication and protection survive a restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eng-feed-store-"));
  try {
    const file = join(directory, "events.json");
    const store = await EventStore.open(file);
    await Promise.all([
      store.merge("Team", [event], {
        restricted: true,
        deliveryId: "delivery-1",
      }),
      store.merge("Team", [event], {
        restricted: true,
        deliveryId: "delivery-1",
      }),
    ]);
    const reopened = await EventStore.open(file);
    assert.equal(reopened.list("TEAM").length, 1);
    assert.equal(reopened.requiresProtection("team"), true);
    assert.equal(
      (await reopened.merge("team", [event], { deliveryId: "delivery-1" }))
        .duplicate,
      true,
    );
    await reopened.merge(
      "team",
      [{ ...event, title: "Less informative public payload" }],
      { preferExisting: true },
    );
    assert.equal(reopened.list("team")[0].title, event.title);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("event history remains bounded", async () => {
  const store = await EventStore.open(null);
  await store.merge(
    "team",
    Array.from({ length: 2100 }, (_, index) => ({
      ...event,
      id: `event-${index}`,
    })),
  );
  assert.equal(store.list("team").length, 2000);
});

test("reclosing an issue keeps credit on its original closure even across weeks or out-of-order deliveries", async () => {
  const store = await EventStore.open(null);
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
  assert.deepEqual(store.list("team"), [original]);
  const earlier = { ...original, occurredAt: "2026-08-31T08:00:00.000Z" };
  await store.merge("team", [earlier], {
    deliveryId: "delayed-earlier-closure",
  });
  assert.deepEqual(store.list("team"), [earlier]);
});
