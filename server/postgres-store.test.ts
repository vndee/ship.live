import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import type { ActivityEvent } from "../shared/types.js";
import { PostgresEventStore } from "./postgres-store.js";
import { createTestDatabase } from "./test-database.js";

const event: ActivityEvent = {
  id: "team/service:pr:1:merged",
  type: "merge",
  actor: { login: "engineer" },
  repo: "team/service",
  title: "Improve developer setup",
  occurredAt: "2026-09-07T08:00:00.000Z",
};

async function withDatabase(
  t: TestContext,
  run: (context: {
    url: string;
    database: Pool;
    open: (url?: string) => Promise<PostgresEventStore>;
  }) => Promise<void>,
) {
  const url = await createTestDatabase(t);
  if (!url) return;
  const database = new Pool({ connectionString: url });
  const stores: PostgresEventStore[] = [];
  try {
    await run({
      url,
      database,
      open: async (connectionUrl = url) => {
        const store = await PostgresEventStore.open(connectionUrl);
        stores.push(store);
        return store;
      },
    });
  } finally {
    await Promise.all(stores.map((store) => store.close()));
    await database.end();
  }
}

async function eventually(check: () => Promise<boolean>, message: string) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail(message);
}

test("PostgreSQL migrations serialize concurrent startup and preserve connection URL options", async (t) => {
  await withDatabase(t, async ({ url, database, open }) => {
    await database.query("CREATE SCHEMA isolated_store");
    const configured = new URL(url);
    configured.searchParams.set("options", "-c search_path=isolated_store");
    const stores = await Promise.all([
      open(configured.href),
      open(configured.href),
    ]);
    await Promise.all(stores.map((store) => store.ping()));
    const migrations = await database.query(
      "SELECT version FROM isolated_store.ship_live_schema_migrations",
    );
    assert.deepEqual(migrations.rows, [
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
    ]);
    await stores[0].merge("team", [event]);
    assert.deepEqual(await stores[1].list("team"), [event]);
  });
});

test("PostgreSQL events, global delivery deduplication and sticky private protection survive reopening", async (t) => {
  await withDatabase(t, async ({ open, database }) => {
    const first = await open();
    await first.merge("Team", [event], {
      restricted: true,
      deliveryId: "durable-delivery",
    });
    await first.protectOrganization("Empty-Private-Org");
    await first.close();
    const reopened = await open();
    assert.deepEqual(await reopened.list("TEAM"), [event]);
    assert.deepEqual(await reopened.get("team", event.id), event);
    assert.equal(await reopened.requiresProtection("team"), true);
    assert.equal(await reopened.requiresProtection("empty-private-org"), true);
    await reopened.merge("team", [{ ...event, title: "Public payload" }], {
      preferExisting: true,
    });
    assert.deepEqual(await reopened.get("team", event.id), event);
    assert.equal(await reopened.requiresProtection("TEAM"), true);
    assert.deepEqual(
      await reopened.merge("another-org", [event], {
        deliveryId: "durable-delivery",
      }),
      { duplicate: true, added: [] },
    );
    assert.deepEqual(await reopened.list("another-org"), []);
    assert.equal(await reopened.requiresProtection("another-org"), false);
    assert.equal(
      Number(
        (
          await database.query(
            "SELECT count(*) FROM ship_live_organizations WHERE organization = 'another-org'",
          )
        ).rows[0].count,
      ),
      0,
    );
  });
});

test("independent PostgreSQL pools do not lose concurrent writes or accept one delivery twice", async (t) => {
  await withDatabase(t, async ({ open, database }) => {
    const [one, two] = await Promise.all([open(), open()]);
    const deliveries = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 ? one : two).merge(
          "team",
          [{ ...event, id: `event-${index}` }],
          { deliveryId: `delivery-${index}` },
        ),
      ),
    );
    assert.ok(deliveries.every((result) => !result.duplicate));
    assert.equal((await one.list("team")).length, 20);
    const sameDelivery = await Promise.all([
      one.merge("team", [{ ...event, id: "winner-one" }], {
        deliveryId: "shared-delivery",
      }),
      two.merge("other", [{ ...event, id: "winner-two" }], {
        deliveryId: "shared-delivery",
      }),
    ]);
    assert.equal(sameDelivery.filter((result) => result.duplicate).length, 1);
    assert.equal(sameDelivery.flatMap((result) => result.added).length, 1);
    assert.equal(
      Number(
        (await database.query("SELECT count(*) FROM ship_live_deliveries"))
          .rows[0].count,
      ),
      21,
    );
  });
});

test("PostgreSQL transactions roll back events, delivery IDs and protection together", async (t) => {
  await withDatabase(t, async ({ open, database }) => {
    const store = await open();
    await assert.rejects(
      store.merge(
        "team",
        [event, { ...event, id: "invalid", occurredAt: "invalid-date" }],
        { deliveryId: "retry-after-rollback", restricted: true },
      ),
    );
    assert.deepEqual(await store.list("team"), []);
    assert.equal(await store.requiresProtection("team"), false);
    assert.equal(
      Number(
        (await database.query("SELECT count(*) FROM ship_live_deliveries"))
          .rows[0].count,
      ),
      0,
    );
    assert.equal(
      (
        await store.merge("team", [event], {
          deliveryId: "retry-after-rollback",
          restricted: true,
        })
      ).duplicate,
      false,
    );
    assert.equal(await store.requiresProtection("team"), true);
  });
});

test("PostgreSQL keeps the earliest issue closure across pools and public refreshes", async (t) => {
  await withDatabase(t, async ({ open }) => {
    const [one, two] = await Promise.all([open(), open()]);
    const issue: ActivityEvent = {
      ...event,
      id: "team/service:issue:7:closed",
      type: "issue",
    };
    const earlier = {
      ...issue,
      occurredAt: "2026-08-31T08:00:00.000Z",
      actor: { login: "first-closer" },
    };
    await one.merge("team", [issue], { deliveryId: "first-seen" });
    await Promise.all([
      one.merge(
        "team",
        [{ ...issue, occurredAt: "2026-09-14T08:00:00.000Z" }],
        { deliveryId: "reclosed" },
      ),
      two.merge("team", [earlier], { preferExisting: true }),
    ]);
    assert.deepEqual(await one.get("TEAM", issue.id), earlier);
    assert.deepEqual(await two.list("team"), [earlier]);
  });
});

test("PostgreSQL retains all history and delivery IDs while limiting each organization's feed to 2000", async (t) => {
  await withDatabase(t, async ({ open, database }) => {
    const store = await open();
    const history = Array.from({ length: 2_105 }, (_, index) => ({
      ...event,
      id: `history-${index}`,
      occurredAt: new Date(
        Date.parse(event.occurredAt) + index * 1_000,
      ).toISOString(),
    }));
    await store.merge("team", history);
    await store.merge(
      "other",
      history.map((item) => ({ ...item, repo: "other/service" })),
    );
    await database.query(
      "INSERT INTO ship_live_deliveries (delivery_id) SELECT 'historic-' || value FROM generate_series(1, 3001) AS value",
    );
    await store.merge("team", [], { deliveryId: "latest-delivery" });
    assert.equal((await store.list("team")).length, 2_000);
    assert.equal((await store.list("OTHER")).length, 2_000);
    assert.equal((await store.list("team"))[0].id, "history-2104");
    assert.deepEqual(await store.get("team", "history-0"), history[0]);
    assert.equal(
      (await store.get("other", "history-0"))?.repo,
      "other/service",
    );
    assert.equal(await store.get("unknown", "history-0"), undefined);
    assert.equal(
      Number(
        (await database.query("SELECT count(*) FROM ship_live_events")).rows[0]
          .count,
      ),
      4_210,
    );
    assert.equal(
      Number(
        (await database.query("SELECT count(*) FROM ship_live_deliveries"))
          .rows[0].count,
      ),
      3_002,
    );
    assert.equal(
      (await store.merge("team", [], { deliveryId: "historic-1" })).duplicate,
      true,
    );
  });
});

test("committed webhook notifications reach both instances once and carry canonical references", async (t) => {
  await withDatabase(t, async ({ open }) => {
    const [writer, reader] = await Promise.all([open(), open()]);
    const writerEvents: string[] = [];
    const readerEvents: Array<{ org: string; id: string }> = [];
    writer.subscribe((org, id) => writerEvents.push(`${org}:${id}`));
    const unsubscribe = reader.subscribe((org, id) =>
      readerEvents.push({ org, id }),
    );
    await writer.merge("TEAM", [event], {
      restricted: true,
      deliveryId: "notify-once",
    });
    await reader.merge("team", [event], { deliveryId: "notify-once" });
    await writer.merge("team", [{ ...event, id: "poll-only" }]);
    await writer.merge("team", [{ ...event, id: "barrier" }], {
      deliveryId: "notification-barrier",
    });
    await eventually(
      async () =>
        readerEvents.some((item) => item.id === "barrier") &&
        writerEvents.some((item) => item.endsWith(":barrier")),
      "Committed notifications did not reach both instances",
    );
    assert.deepEqual(readerEvents, [
      { org: "team", id: event.id },
      { org: "team", id: "barrier" },
    ]);
    assert.equal(writerEvents.length, 2);
    assert.deepEqual(
      await reader.get(readerEvents[0].org, readerEvents[0].id),
      event,
    );
    assert.equal(await reader.requiresProtection("team"), true);
    const issue: ActivityEvent = {
      ...event,
      id: "closed-issue",
      type: "issue",
    };
    await writer.merge("team", [issue], { deliveryId: "closed-later" });
    await eventually(
      async () =>
        readerEvents.filter((item) => item.id === issue.id).length === 1,
      "Initial issue notification missing",
    );
    const earlier = { ...issue, occurredAt: "2026-08-31T08:00:00.000Z" };
    await writer.merge("team", [earlier], { deliveryId: "closed-earlier" });
    await eventually(
      async () =>
        readerEvents.filter((item) => item.id === issue.id).length === 2,
      "Canonical update notification missing",
    );
    assert.deepEqual(await reader.get("team", issue.id), earlier);
    unsubscribe();
    await writer.merge("team", [{ ...event, id: "after-unsubscribe" }], {
      deliveryId: "after-unsubscribe",
    });
    await eventually(
      async () => writerEvents.some((id) => id.endsWith(":after-unsubscribe")),
      "Writer notification barrier missing",
    );
    assert.equal(
      readerEvents.some((item) => item.id === "after-unsubscribe"),
      false,
    );
  });
});

test("PostgreSQL notification listeners reconnect after a terminated connection and close cleanly", async (t) => {
  await withDatabase(t, async ({ open, database }) => {
    const [writer, reader] = await Promise.all([open(), open()]);
    const received: string[] = [];
    reader.subscribe((_org, id) => received.push(id));
    const terminated = await database.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND query = 'LISTEN ship_live_event_changes'",
    );
    assert.equal(terminated.rowCount, 2);
    await eventually(
      async () =>
        Number(
          (
            await database.query(
              "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND query = 'LISTEN ship_live_event_changes' AND state = 'idle'",
            )
          ).rows[0].count,
        ) === 2,
      "LISTEN connections did not recover",
    );
    await writer.merge("team", [event], { deliveryId: "after-reconnect" });
    await eventually(
      async () => received.includes(event.id),
      "Notification missing after listener reconnect",
    );
    await Promise.all([writer.close(), reader.close()]);
    assert.equal(
      Number(
        (
          await database.query(
            "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND query = 'LISTEN ship_live_event_changes'",
          )
        ).rows[0].count,
      ),
      0,
    );
  });
});

test("legacy import is atomic, repeatable and preserves protected empty organizations and canonical events", async (t) => {
  await withDatabase(t, async ({ open, database }) => {
    const store = await open();
    await store.merge("team", [event], { restricted: true });
    const issue: ActivityEvent = {
      ...event,
      id: "legacy-issue",
      type: "issue",
    };
    const data = {
      version: 1 as const,
      records: [
        {
          organization: "team",
          event: { ...event, title: "Old public title" },
          restricted: false,
        },
        { organization: "team", event: issue, restricted: true },
      ],
      deliveries: ["old-delivery"],
      protectedOrganizations: ["team", "empty-private"],
    };
    assert.deepEqual(await store.importLegacy(data), {
      events: 1,
      deliveries: 1,
      protectedOrganizations: 1,
    });
    assert.deepEqual(await store.importLegacy(data), {
      events: 0,
      deliveries: 0,
      protectedOrganizations: 0,
    });
    assert.deepEqual(await store.get("team", event.id), event);
    assert.equal(await store.requiresProtection("empty-private"), true);
    assert.equal(
      (await store.merge("team", [], { deliveryId: "old-delivery" })).duplicate,
      true,
    );
    await assert.rejects(
      store.importLegacy({
        ...data,
        records: [
          {
            organization: "broken",
            event: { ...event, occurredAt: "invalid" },
            restricted: true,
          },
        ],
        deliveries: ["must-roll-back"],
        protectedOrganizations: ["broken"],
      }),
    );
    assert.equal(await store.requiresProtection("broken"), false);
    assert.equal(
      Number(
        (
          await database.query(
            "SELECT count(*) FROM ship_live_deliveries WHERE delivery_id = 'must-roll-back'",
          )
        ).rows[0].count,
      ),
      0,
    );
  });
});
