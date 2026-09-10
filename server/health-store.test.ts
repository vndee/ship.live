import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { AuthError } from "./auth.js";
import { ACTIVITY_CHANNEL } from "./postgres-notifications.js";
import { PostgresEventStore } from "./postgres-store.js";
import { createTestDatabase } from "./test-database.js";
import { HealthStore } from "./health-store.js";
import type { ProbeInput, ProbeResult } from "../shared/health.js";
const config: ProbeInput = {
  name: "Readiness",
  url: "https://example.com/health",
  method: "GET",
  intervalSeconds: 60,
  timeoutMs: 10000,
  statusMin: 200,
  statusMax: 299,
  maxLatencyMs: null,
  jsonPath: "",
  jsonExpected: null,
  failureThreshold: 2,
  recoveryThreshold: 2,
  enabled: true,
};
const success: ProbeResult = {
  ok: true,
  latencyMs: 42,
  statusCode: 200,
  reason: "Checks passed",
};
const failure: ProbeResult = {
  ok: false,
  latencyMs: 50,
  statusCode: 503,
  reason: "Unexpected HTTP status",
};
async function fixture(t: Parameters<typeof createTestDatabase>[0]) {
  let opened: PostgresEventStore | undefined;
  t.after(() => opened?.close());
  const database = await createTestDatabase(t);
  if (!database) return;
  const events = await PostgresEventStore.open(database);
  opened = events;
  const ids = [randomUUID(), randomUUID()];
  for (const id of ids)
    await events.pool.query(
      "INSERT INTO ship_live_workspaces(id,name,kind) VALUES($1,'Test team','team')",
      [id],
    );
  return {
    events,
    health: new HealthStore(events.pool, "11".repeat(32)),
    workspace: ids[0],
    other: ids[1],
  };
}
test("service order persists across store instances and new services append after deletion", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const first = await f.health.createService(f.workspace, "First");
  const second = await f.health.createService(f.workspace, "Second");
  await f.health.reorderServices(f.workspace, [second.id, first.id]);
  const reopened = new HealthStore(f.events.pool);
  assert.deepEqual(
    (await reopened.snapshot(f.workspace)).services.map((s) => s.id),
    [second.id, first.id],
  );
  const third = await reopened.createService(f.workspace, "Third");
  assert.deepEqual(
    (await reopened.snapshot(f.workspace)).services.map((s) => s.id),
    [second.id, first.id, third.id],
  );
  await reopened.deleteService(f.workspace, first.id);
  const fourth = await reopened.createService(f.workspace, "Fourth");
  assert.deepEqual(
    (await reopened.snapshot(f.workspace)).services.map((s) => s.id),
    [second.id, third.id, fourth.id],
  );
});

test("service reorder requires every current service exactly once and isolates workspaces", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const first = await f.health.createService(f.workspace, "First");
  const second = await f.health.createService(f.workspace, "Second");
  const foreign = await f.health.createService(f.other, "Foreign");
  const invalidOrders = [
    [],
    [first.id],
    [first.id, first.id],
    [first.id, randomUUID()],
    [first.id, foreign.id],
    [first.id, "invalid-id"],
    [first.id, second.id, foreign.id],
    Array.from({ length: 21 }, () => randomUUID()),
  ];
  for (const ids of invalidOrders) {
    await assert.rejects(
      () => f.health.reorderServices(f.workspace, ids),
      (error: unknown) => error instanceof AuthError && error.status === 400,
    );
    assert.deepEqual(
      (await f.health.snapshot(f.workspace)).services.map((s) => s.id),
      [first.id, second.id],
    );
    assert.deepEqual(
      (await f.health.snapshot(f.other)).services.map((s) => s.id),
      [foreign.id],
    );
  }
  await assert.rejects(
    () => f.health.reorderServices(randomUUID(), []),
    /not found/i,
  );
  await f.health.deleteService(f.other, foreign.id);
  await f.health.reorderServices(f.other, []);
});

test("concurrent service reorders remain atomic and creation respects the 20-service limit", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const services = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      f.health.createService(f.workspace, `Service ${i}`),
    ),
  );
  const forward = services.map((s) => s.id);
  const reverse = [...forward].reverse();
  await Promise.all([
    f.health.reorderServices(f.workspace, forward),
    f.health.reorderServices(f.workspace, reverse),
  ]);
  const actual = (await f.health.snapshot(f.workspace)).services.map(
    (s) => s.id,
  );
  assert.ok(
    JSON.stringify(actual) === JSON.stringify(forward) ||
      JSON.stringify(actual) === JSON.stringify(reverse),
  );
  await assert.rejects(
    () => f.health.createService(f.workspace, "Overflow"),
    /up to 20 services/i,
  );
});

test("failed service reorder rolls back positions and only committed reorders notify", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const first = await f.health.createService(f.workspace, "First");
  const second = await f.health.createService(f.workspace, "Second");
  const listener = await f.events.pool.connect();
  const notifications: string[] = [];
  const onNotification = (message: { payload?: string }) => {
    if (message.payload) notifications.push(message.payload);
  };
  listener.on("notification", onNotification);
  try {
    await listener.query(`LISTEN ${ACTIVITY_CHANNEL}`);
    await assert.rejects(() =>
      f.health.reorderServices(f.workspace, [first.id, first.id]),
    );
    await f.events.pool.query(`
      CREATE FUNCTION reject_service_order() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.display_order = 1 THEN RAISE EXCEPTION 'test reorder failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_service_order BEFORE UPDATE OF display_order
      ON ship_live_health_services FOR EACH ROW EXECUTE FUNCTION reject_service_order();
    `);
    await assert.rejects(
      () => f.health.reorderServices(f.workspace, [second.id, first.id]),
      /test reorder failure/,
    );
    assert.deepEqual(
      (await f.health.snapshot(f.workspace)).services.map((s) => s.id),
      [first.id, second.id],
    );
    await f.events.pool.query(
      "DROP TRIGGER reject_service_order ON ship_live_health_services",
    );
    await f.health.reorderServices(f.workspace, [second.id, first.id]);
    await f.events.pool.query("SELECT pg_notify($1,'reorder-barrier')", [
      ACTIVITY_CHANNEL,
    ]);
    for (let attempt = 0; attempt < 150; attempt++) {
      if (notifications.includes("reorder-barrier")) break;
      await delay(20);
    }
    assert.deepEqual(notifications, [
      JSON.stringify({
        organization: `health-${f.workspace}`,
        eventId: "health",
      }),
      "reorder-barrier",
    ]);
  } finally {
    await listener.query(`UNLISTEN ${ACTIVITY_CHANNEL}`);
    listener.off("notification", onNotification);
    listener.release();
  }
});

test("health probes preserve encrypted headers and isolate team configuration", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const { health, workspace, other, events } = f;
  const service = await health.createService(workspace, "API");
  const probe = await health.saveProbe(workspace, service.id, null, config, {
    Authorization: "Bearer very-secret",
  });
  const snapshot = await health.snapshot(workspace);
  assert.equal(snapshot.services[0].probes[0].hasHeaders, true);
  assert.ok(!JSON.stringify(snapshot).includes("very-secret"));
  const persisted = await events.pool.query(
    "SELECT headers_encrypted FROM ship_live_health_probes WHERE id=$1",
    [probe.id],
  );
  assert.ok(!persisted.rows[0].headers_encrypted.includes("very-secret"));
  assert.equal((await health.snapshot(other)).services.length, 0);
  await assert.rejects(
    health.saveProbe(other, service.id, probe.id, config),
    /not found/i,
  );
  await assert.rejects(health.deleteService(other, service.id), /not found/i);
  await health.saveProbe(workspace, service.id, probe.id, {
    ...config,
    name: "Updated",
  });
  const [claim] = await health.claim(1);
  assert.equal(claim.headers.Authorization, "Bearer very-secret");
  await health.saveProbe(workspace, service.id, probe.id, config, {});
  assert.equal(
    (await health.snapshot(workspace)).services[0].probes[0].hasHeaders,
    false,
  );
});
test("leases prevent duplicate work, recover after expiry and fence edits or pause", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const { health, workspace, events } = f;
  const service = await health.createService(workspace, "API");
  const probe = await health.saveProbe(workspace, service.id, null, config);
  const claims = await Promise.all([health.claim(1), health.claim(1)]);
  assert.equal(claims.flat().length, 1);
  const old = claims.flat()[0];
  await events.pool.query(
    "UPDATE ship_live_health_probes SET lease_until=now()-interval '1 second' WHERE id=$1",
    [probe.id],
  );
  const [newClaim] = await health.claim(1);
  assert.ok(newClaim);
  assert.notEqual(newClaim.lease, old.lease);
  assert.equal(await health.complete(old, success), false);
  await health.saveProbe(workspace, service.id, probe.id, {
    ...config,
    enabled: false,
  });
  assert.equal(await health.complete(newClaim, success), false);
  assert.equal((await health.snapshot(workspace)).services[0].status, "paused");
  assert.equal((await health.claim(1)).length, 0);
});
test("health states debounce failures and recovery, retain history and expose overdue checks as unknown", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const { health, workspace, events } = f;
  const service = await health.createService(workspace, "API");
  const probe = await health.saveProbe(workspace, service.id, null, config);
  async function record(result: ProbeResult) {
    await events.pool.query(
      "UPDATE ship_live_health_probes SET next_check_at=now() WHERE id=$1",
      [probe.id],
    );
    const [claim] = await health.claim(1);
    assert.ok(claim);
    assert.equal(await health.complete(claim, result), true);
    return (await health.snapshot(workspace)).services[0].probes[0];
  }
  assert.equal((await record(success)).status, "healthy");
  assert.equal((await record(failure)).status, "degraded");
  assert.equal((await record(failure)).status, "down");
  assert.equal((await record(success)).status, "down");
  const recovered = await record(success);
  assert.equal(recovered.status, "healthy");
  assert.equal(recovered.checks24h, 5);
  assert.equal(recovered.successRate24h, 60);
  assert.equal(recovered.history.length, 5);
  await events.pool.query(
    "UPDATE ship_live_health_probes SET last_checked_at=now()-interval '5 minutes' WHERE id=$1",
    [probe.id],
  );
  assert.equal(
    (await health.snapshot(workspace)).services[0].status,
    "unknown",
  );
  await health.deleteService(workspace, service.id);
  assert.equal((await health.claim(1)).length, 0);
});

test("pause and rename preserve history and recovery thresholds while invalidating running checks", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const { health, workspace, events } = f;
  const service = await health.createService(workspace, "API");
  const probe = await health.saveProbe(workspace, service.id, null, {
    ...config,
    failureThreshold: 1,
  });
  const [first] = await health.claim(1);
  await health.complete(first, failure);
  await health.saveProbe(workspace, service.id, probe.id, {
    ...config,
    failureThreshold: 1,
    enabled: false,
  });
  assert.equal(
    (await health.snapshot(workspace)).services[0].probes[0].history.length,
    1,
  );
  await health.saveProbe(workspace, service.id, probe.id, {
    ...config,
    failureThreshold: 1,
    name: "Renamed",
  });
  const [next] = await health.claim(1);
  await health.complete(next, success);
  const state = (await health.snapshot(workspace)).services[0].probes[0];
  assert.equal(state.status, "down");
  assert.equal(state.history.length, 2);
  await events.pool.query(
    "UPDATE ship_live_health_checks SET checked_at=now()-interval '31 days' WHERE probe_id=$1",
    [probe.id],
  );
  await health.prune();
  assert.equal(
    (await health.snapshot(workspace)).services[0].probes[0].history.length,
    0,
  );
});

test("explicit header replacement repairs probes after encryption key rotation", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const { health, workspace, events } = f;
  const service = await health.createService(workspace, "API");
  const probe = await health.saveProbe(workspace, service.id, null, config, {
    authorization: "Bearer old",
  });
  const rotated = new HealthStore(events.pool, "22".repeat(32));
  await rotated.saveProbe(workspace, service.id, probe.id, config, {});
  assert.equal(
    (await rotated.snapshot(workspace)).services[0].probes[0].hasHeaders,
    false,
  );
  await rotated.saveProbe(workspace, service.id, probe.id, config, {
    authorization: "Bearer new",
  });
  const [claim] = await rotated.claim(1);
  assert.equal(claim.headers.authorization, "Bearer new");
});

test("latency buckets include failures, survive rule edits and retain 30 days", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const { health, workspace, events } = f;
  const service = await health.createService(workspace, "Weather");
  const probe = await health.saveProbe(workspace, service.id, null, config);
  const [first] = await health.claim(1);
  await health.complete(first, success);
  await health.saveProbe(workspace, service.id, probe.id, {
    ...config,
    statusMax: 201,
  });
  const [second] = await health.claim(1);
  await health.complete(second, failure);
  const state = (await health.snapshot(workspace)).services[0].probes[0];
  assert.equal(state.history.length, 2);
  assert.deepEqual(state.latencyHistory, [
    {
      date: new Date().toISOString().slice(0, 10),
      avgLatencyMs: 46,
      minLatencyMs: 42,
      maxLatencyMs: 50,
      checks: 2,
    },
  ]);
  await events.pool.query(
    "UPDATE ship_live_health_checks SET checked_at=now()-interval '29 days' WHERE probe_id=$1",
    [probe.id],
  );
  await events.pool.query(
    "INSERT INTO ship_live_health_checks(probe_id,checked_at,result,state) VALUES($1,now()-interval '31 days',$2,'healthy')",
    [probe.id, success],
  );
  await health.prune();
  const remaining = await events.pool.query(
    "SELECT count(*)::int AS n FROM ship_live_health_checks WHERE probe_id=$1",
    [probe.id],
  );
  assert.equal(remaining.rows[0].n, 2);
  assert.equal(
    (await health.snapshot(workspace)).services[0].probes[0].history.length,
    2,
  );
});
