import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client, type Pool } from "pg";
import { runRetention } from "./maintenance.js";
import { PostgresEventStore } from "./postgres-store.js";
import { createTestDatabase } from "./test-database.js";

async function withStore(
  t: TestContext,
  run: (store: PostgresEventStore, database: string) => Promise<void>,
) {
  const database = await createTestDatabase(t);
  if (!database) return;
  const store = await PostgresEventStore.open(database);
  try {
    await seed(store.pool);
    await run(store, database);
  } finally {
    await store.close();
  }
}

async function seed(pool: Pool) {
  await pool.query(
    "INSERT INTO ship_live_organizations(organization) VALUES ('installation-1')",
  );
  await pool.query(`INSERT INTO ship_live_events(organization,event_id,event,occurred_at) VALUES
    ('installation-1','old','{}',now()-interval '40 days'),
    ('installation-1','recent','{}',now()-interval '2 days')`);
  for (const table of ["ship_live_deliveries", "ship_live_wall_deliveries"])
    await pool.query(
      `INSERT INTO ${table}(delivery_id,received_at) VALUES ('old',now()-interval '31 days'),('recent',now())`,
    );
  await pool.query(`INSERT INTO ship_live_wall_signals(installation_id,repository_id,repository,kind,signal_key,observed_at,value) VALUES
    (1,1,'acme/api','pull_request','idle-open',now()-interval '40 days','{"state":"open"}'),
    (1,1,'acme/api','pull_request','old-merged',now()-interval '40 days','{"state":"merged"}'),
    (1,1,'acme/api','pipeline','old-ci',now()-interval '40 days','{}'),
    (1,1,'acme/api','deployment','production',now()-interval '1 day','{}')`);
  await pool.query(`INSERT INTO ship_live_rate_limits(bucket,window_start,hits) VALUES
    ('expired',now()-interval '2 hours',5),('current',now(),1)`);
}

const keys = async (pool: Pool, table: string, column: string) =>
  (
    await pool.query<{ key: string }>(
      `SELECT ${column} AS key FROM ${table} ORDER BY 1`,
    )
  ).rows.map((row) => row.key);

test("retention expires delivery IDs and request counters but keeps activity unless configured", async (t) => {
  await withStore(t, async ({ pool }) => {
    assert.deepEqual(
      await runRetention(pool, { eventDays: 0, deliveryDays: 30 }),
      {
        ship_live_rate_limits: 1,
        ship_live_deliveries: 1,
        ship_live_wall_deliveries: 1,
      },
    );
    assert.deepEqual(await keys(pool, "ship_live_deliveries", "delivery_id"), [
      "recent",
    ]);
    assert.deepEqual(await keys(pool, "ship_live_rate_limits", "bucket"), [
      "current",
    ]);
    assert.equal((await keys(pool, "ship_live_events", "event_id")).length, 2);
    assert.equal(
      (await keys(pool, "ship_live_wall_signals", "signal_key")).length,
      4,
    );
  });
});

test("activity retention removes old events and signals but never an open pull request", async (t) => {
  await withStore(t, async ({ pool }) => {
    await runRetention(pool, { eventDays: 0, deliveryDays: 0 });
    assert.deepEqual(
      await runRetention(pool, { eventDays: 31, deliveryDays: 0 }),
      { ship_live_events: 1, ship_live_wall_signals: 2 },
    );
    assert.deepEqual(await keys(pool, "ship_live_events", "event_id"), [
      "recent",
    ]);
    assert.deepEqual(await keys(pool, "ship_live_wall_signals", "signal_key"), [
      "idle-open",
      "production",
    ]);
    assert.equal(
      (await keys(pool, "ship_live_deliveries", "delivery_id")).length,
      2,
    );
    assert.deepEqual(
      await runRetention(pool, { eventDays: 31, deliveryDays: 0 }),
      {},
    );
  });
});

test("only one replica runs retention at a time", async (t) => {
  await withStore(t, async ({ pool }, database) => {
    const other = new Client({ connectionString: database });
    await other.connect();
    try {
      await other.query("SELECT pg_advisory_lock(1936222576, 2)");
      assert.deepEqual(
        await runRetention(pool, { eventDays: 31, deliveryDays: 30 }),
        {},
      );
      assert.equal(
        (await keys(pool, "ship_live_events", "event_id")).length,
        2,
      );
      await other.query("SELECT pg_advisory_unlock(1936222576, 2)");
      assert.equal(
        (await runRetention(pool, { eventDays: 31, deliveryDays: 30 }))
          .ship_live_events,
        1,
      );
    } finally {
      await other.end();
    }
  });
});
