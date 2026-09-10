import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { Pool } from "pg";
import type { ProbeResult } from "../shared/health.js";
import { AuthError } from "./auth.js";
import { validateProbe } from "./health-probe.js";
import { HealthStore } from "./health-store.js";
import { PostgresEventStore } from "./postgres-store.js";
import { createTestDatabase } from "./test-database.js";

async function withProbe(
  t: TestContext,
  run: (fixture: {
    pool: Pool;
    health: HealthStore;
    workspace: string;
    service: string;
    user: string;
    check: (ok: boolean) => Promise<void>;
  }) => Promise<void>,
) {
  const database = await createTestDatabase(t);
  if (!database) return;
  const events = await PostgresEventStore.open(database);
  try {
    const pool = events.pool;
    const workspace = randomUUID();
    const service = randomUUID();
    const user = randomUUID();
    await pool.query(
      "INSERT INTO ship_live_workspaces(id,name,kind) VALUES($1,'Acme','team')",
      [workspace],
    );
    await pool.query(
      "INSERT INTO ship_live_auth_users(id,name) VALUES($1,'Builder')",
      [user],
    );
    await pool.query(
      "INSERT INTO ship_live_health_services(id,workspace_id,name,display_order) VALUES($1,$2,'Public API',0)",
      [service, workspace],
    );
    await pool.query(
      "INSERT INTO ship_live_health_probes(id,workspace_id,service_id,config) VALUES($1,$2,$3,$4)",
      [
        randomUUID(),
        workspace,
        service,
        validateProbe({
          name: "Health",
          url: "https://example.com/health",
          failureThreshold: 1,
          recoveryThreshold: 1,
        }),
      ],
    );
    const health = new HealthStore(pool, "11".repeat(32));
    const check = async (ok: boolean) => {
      await pool.query(
        "UPDATE ship_live_health_probes SET next_check_at = now()",
      );
      const [claim] = await health.claim(1);
      const result: ProbeResult = ok
        ? { ok, latencyMs: 100, statusCode: 200, reason: "Probe passed." }
        : { ok, latencyMs: 900, statusCode: 503, reason: "Down." };
      assert.equal(await health.complete(claim, result), true);
    };
    await run({ pool, health, workspace, service, user, check });
  } finally {
    await events.close();
  }
}

const hour = 3_600_000;
const window = (
  serviceId: string | null,
  offset = -hour,
  length = 2 * hour,
) => ({
  serviceId,
  startsAt: new Date(Date.now() + offset).toISOString(),
  endsAt: new Date(Date.now() + offset + length).toISOString(),
  note: "Database upgrade",
});

test("each day counts passed checks, and the snapshot carries 90 days", async (t) => {
  await withProbe(t, async ({ pool, health, workspace, check }) => {
    await check(true);
    await check(true);
    await check(false);
    const [service] = (await health.snapshot(workspace)).services;
    const [probe] = service.probes;
    assert.equal(probe.uptime90d?.length, 1);
    assert.deepEqual(
      {
        checks: probe.uptime90d![0].checks,
        passed: probe.uptime90d![0].passed,
      },
      { checks: 3, passed: 2 },
    );
    // Days whose passes are unknown (before migration 016) are left out.
    await pool.query("UPDATE ship_live_health_latency_daily SET passed = NULL");
    const [unknown] = (await health.snapshot(workspace)).services;
    assert.deepEqual(unknown.probes[0].uptime90d, []);
  });
});

test("checks inside maintenance change no state, open no incident, and cost no uptime", async (t) => {
  await withProbe(
    t,
    async ({ pool, health, workspace, service, user, check }) => {
      await check(true);
      const scheduled = await health.scheduleMaintenance(
        workspace,
        user,
        window(service),
      );
      assert.equal(scheduled.note, "Database upgrade");
      await check(false);
      await check(false);
      const during = await pool.query<{ state: string; failures: number }>(
        "SELECT state, failures FROM ship_live_health_probes",
      );
      assert.deepEqual(during.rows, [{ state: "healthy", failures: 0 }]);
      assert.equal(
        (await pool.query("SELECT 1 FROM ship_live_health_incidents")).rowCount,
        0,
      );
      const flagged = await pool.query<{ maintenance: boolean }>(
        "SELECT (result->>'maintenance')::boolean AS maintenance FROM ship_live_health_checks ORDER BY id",
      );
      assert.deepEqual(
        flagged.rows.map((row) => row.maintenance),
        [null, true, true],
      );
      let [snapshot] = (await health.snapshot(workspace)).services;
      assert.deepEqual(
        [
          snapshot.probes[0].uptime90d![0].checks,
          snapshot.probes[0].uptime90d![0].passed,
        ],
        [1, 1],
      );
      assert.deepEqual(
        snapshot.maintenance?.map((item) => item.id),
        [scheduled.id],
      );

      // After cancelling, the next failure counts and opens an incident.
      await health.cancelMaintenance(workspace, scheduled.id);
      await check(false);
      [snapshot] = (await health.snapshot(workspace)).services;
      assert.equal(snapshot.probes[0].status, "down");
      assert.equal(snapshot.incidents?.length, 1);
      assert.deepEqual(snapshot.maintenance, []);
    },
  );
});

test("workspace-wide maintenance covers every service; scheduling is validated", async (t) => {
  await withProbe(t, async ({ pool, health, workspace, user, check }) => {
    await health.scheduleMaintenance(workspace, user, window(null));
    await check(false);
    assert.equal(
      (await pool.query("SELECT 1 FROM ship_live_health_incidents")).rowCount,
      0,
    );
    const rejects = async (input: unknown, pattern: RegExp) =>
      assert.rejects(
        health.scheduleMaintenance(workspace, user, input),
        (error: unknown) =>
          error instanceof AuthError && pattern.test(error.message),
      );
    await rejects(window(null, hour, -hour), /after it starts/);
    await rejects(window(null, -3 * hour, hour), /in the future/);
    await rejects(window(null, 0, 8 * 86_400_000), /at most 7 days/);
    await rejects({ ...window(null), note: "x".repeat(201) }, /200 characters/);
    await rejects(window(randomUUID()), /not found/);
    const other = randomUUID();
    await pool.query(
      "INSERT INTO ship_live_workspaces(id,name,kind) VALUES($1,'Other','team')",
      [other],
    );
    const [mine] = (await health.snapshot(workspace)).services[0].maintenance!;
    await assert.rejects(health.cancelMaintenance(other, mine.id), /not found/);
  });
});

test("concurrent scheduling cannot exceed 50 windows", async (t) => {
  await withProbe(t, async ({ pool, health, workspace, user }) => {
    for (let index = 0; index < 49; index += 1)
      await pool.query(
        "INSERT INTO ship_live_health_maintenance(id,workspace_id,starts_at,ends_at) VALUES($1,$2,now(),now()+interval '1 hour')",
        [randomUUID(), workspace],
      );
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        health.scheduleMaintenance(workspace, user, window(null, hour)),
      ),
    );
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const { rows } = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM ship_live_health_maintenance",
    );
    assert.equal(rows[0].count, 50);
  });
});
