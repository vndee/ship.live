import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { PostgresEventStore } from "./postgres-store.js";
import { createTestDatabase } from "./test-database.js";

test("recap tables block non-server readers even when the database grants general table read access", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const bootstrap = new Client({ connectionString: url });
  await bootstrap.connect();
  try {
    // Simulate a hosted database granting newly created tables to API readers.
    await bootstrap.query(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO PUBLIC",
    );
  } finally {
    await bootstrap.end();
  }
  const store = await PostgresEventStore.open(url);
  const client = await store.pool.connect();
  try {
    const user = randomUUID(),
      workspace = randomUUID();
    await client.query(
      "INSERT INTO ship_live_auth_users(id,name) VALUES($1,'Alice')",
      [user],
    );
    await client.query(
      "INSERT INTO ship_live_workspaces(id,name,kind,owner_user_id) VALUES($1,'Private journal','personal',$2)",
      [workspace, user],
    );
    await client.query(
      "INSERT INTO ship_live_recap_notes(workspace_id,user_id,week_start,reflection) VALUES($1,$2,'2026-09-07','Private reflection')",
      [workspace, user],
    );
    await client.query(
      "INSERT INTO ship_live_digest_schedules(workspace_id,weekday,local_time,timezone) VALUES($1,2,'16:30','Asia/Ho_Chi_Minh')",
      [workspace],
    );
    // Built-in general reader has table privileges but does not bypass RLS.
    // This exercises the same boundary as hosted database default Data API grants.
    const tablePrivileges = await client.query(
      `SELECT table_name FROM unnest(ARRAY['ship_live_review_claims','ship_live_review_snoozes','ship_live_recap_notes','ship_live_digest_schedules','ship_live_saved_views']) AS names(table_name) WHERE has_table_privilege('pg_read_all_data',table_name,'INSERT')`,
    );
    assert.deepEqual(
      tablePrivileges.rows,
      [],
      "default PUBLIC mutation grants must be revoked on all new private tables",
    );
    await client.query("SET ROLE pg_read_all_data");
    const notes = await client.query(
      "SELECT reflection FROM ship_live_recap_notes",
    );
    const schedules = await client.query(
      "SELECT workspace_id FROM ship_live_digest_schedules",
    );
    assert.deepEqual(
      notes.rows,
      [],
      "private reflections must not be exposed through database table grants",
    );
    assert.deepEqual(
      schedules.rows,
      [],
      "workspace schedules must not be exposed through database table grants",
    );
  } finally {
    await client.query("RESET ROLE");
    client.release();
    await store.close();
  }
});
