import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { Pool } from "pg";
import type { ActivityEvent } from "../shared/types.js";
import type { DeploymentState, PipelineState } from "../shared/wall.js";
import { WEBHOOK_PRESETS } from "../shared/webhooks.js";
import { validateProbe } from "./health-probe.js";
import { HealthStore } from "./health-store.js";
import { PostgresEventStore } from "./postgres-store.js";
import { SecretBox } from "./secret-box.js";
import { createTestDatabase } from "./test-database.js";
import { WallStore } from "./wall-store.js";
import { activityOutboxEvent } from "./webhook-events.js";
import { recordInstallationEvent } from "./webhook-outbox.js";
import { WebhookStore } from "./webhook-store.js";

/** A team workspace on installation 99 with a webhook listening to everything. */
async function withListener(
  t: TestContext,
  run: (fixture: {
    events: PostgresEventStore;
    pool: Pool;
    workspace: string;
  }) => Promise<void>,
) {
  const database = await createTestDatabase(t);
  if (!database) return;
  const events = await PostgresEventStore.open(database);
  try {
    const workspace = randomUUID();
    const user = randomUUID();
    await events.pool.query(
      "INSERT INTO ship_live_workspaces(id,name,kind,installation_id) VALUES($1,'Acme','team',99)",
      [workspace],
    );
    await events.pool.query(
      "INSERT INTO ship_live_auth_users(id,name) VALUES($1,'Builder')",
      [user],
    );
    await new WebhookStore(events.pool, new SecretBox("11".repeat(32))).create(
      workspace,
      user,
      {
        name: "Everything",
        preset: "generic",
        url: "https://hooks.example.com/everything",
        template: WEBHOOK_PRESETS.generic.template,
        events: [
          "activity.merge",
          "pipeline.failed",
          "pipeline.recovered",
          "deployment.succeeded",
          "deployment.failed",
          "health.degraded",
          "health.down",
          "health.recovered",
          "incident.opened",
          "incident.resolved",
        ],
      },
      [7],
    );
    await run({ events, pool: events.pool, workspace });
  } finally {
    await events.close();
  }
}

const stored = async (pool: Pool) =>
  (
    await pool.query<{ type: string }>(
      "SELECT type FROM ship_live_webhook_events ORDER BY created_at, type",
    )
  ).rows.map((row) => row.type);

test("a probe that goes down opens an incident, and recovering resolves it, even after new rules", async (t) => {
  await withListener(t, async ({ pool, workspace }) => {
    const health = new HealthStore(pool, "11".repeat(32));
    const service = randomUUID();
    const probe = randomUUID();
    await pool.query(
      "INSERT INTO ship_live_health_services(id,workspace_id,name,display_order) VALUES($1,$2,'Public API',0)",
      [service, workspace],
    );
    await pool.query(
      "INSERT INTO ship_live_health_probes(id,workspace_id,service_id,config) VALUES($1,$2,$3,$4)",
      [
        probe,
        workspace,
        service,
        validateProbe({ name: "Health", url: "https://example.com/health" }),
      ],
    );
    const check = async (ok: boolean) => {
      await pool.query(
        "UPDATE ship_live_health_probes SET next_check_at = now()",
      );
      const [claim] = await health.claim(1);
      assert.ok(claim);
      await health.complete(
        claim,
        ok
          ? { ok, latencyMs: 120, statusCode: 200, reason: "Probe passed." }
          : {
              ok,
              latencyMs: 900,
              statusCode: 503,
              reason: "HTTP status is outside the accepted range.",
            },
      );
    };
    for (const ok of [false, false, false]) await check(ok);
    const open = await pool.query(
      "SELECT resolved_at, reason FROM ship_live_health_incidents",
    );
    assert.deepEqual(open.rows, [
      {
        resolved_at: null,
        reason: "HTTP status is outside the accepted range.",
      },
    ]);
    // New rules keep a down probe down: one pass must not resolve the incident.
    await health.saveProbe(
      workspace,
      service,
      probe,
      validateProbe({ name: "Health", url: "https://example.com/v2/health" }),
    );
    await check(true);
    const still = await pool.query(
      "SELECT 1 FROM ship_live_health_incidents WHERE resolved_at IS NULL",
    );
    assert.equal(still.rowCount, 1);
    await check(true);
    const resolved = await pool.query<{ open: boolean }>(
      "SELECT resolved_at IS NULL AS open FROM ship_live_health_incidents",
    );
    assert.deepEqual(resolved.rows, [{ open: false }]);
    const [service_] = (await health.snapshot(workspace)).services;
    assert.deepEqual(
      service_.incidents?.map((item) => [
        item.probeName,
        item.reason,
        Boolean(item.resolvedAt),
      ]),
      [["Health", "HTTP status is outside the accepted range.", true]],
    );
    assert.deepEqual(await stored(pool), [
      "health.degraded",
      "health.down",
      "incident.opened",
      "health.recovered",
      "incident.resolved",
    ]);
    const { rows } = await pool.query<{ summary: string }>(
      "SELECT payload->>'summary' AS summary FROM ship_live_webhook_events WHERE type='incident.opened'",
    );
    assert.equal(rows[0].summary, "Incident: Public API / Health is down");
    // Probe URLs are private configuration and never reach a webhook.
    const payloads = JSON.stringify(
      (await pool.query("SELECT payload FROM ship_live_webhook_events")).rows,
    );
    assert.ok(!payloads.includes("example.com"));
  });
});

const pipeline = (
  status: PipelineState["status"],
  updatedAt: string,
): PipelineState => ({
  id: "ci",
  name: "test",
  provider: "GitHub Actions",
  headSha: `sha-${updatedAt}`,
  status,
  updatedAt,
});
const deployment = (
  status: DeploymentState["status"],
  updatedAt: string,
): DeploymentState => ({
  id: "42",
  environment: "production",
  headSha: "abc1234",
  status,
  updatedAt,
});

test("CI and deployment changes announce transitions once, ignoring stale and repeated deliveries", async (t) => {
  await withListener(t, async ({ pool }) => {
    const wall = new WallStore(pool);
    const apply = (
      delivery: string,
      kind: "pipeline" | "deployment",
      value: PipelineState | DeploymentState,
    ) =>
      wall.apply(99, 7, "acme/api", delivery, [
        { kind, observedAt: value.updatedAt, value } as never,
      ]);
    await apply("d1", "pipeline", pipeline("passing", "2026-09-10T08:01:00Z"));
    await apply("d2", "pipeline", pipeline("failing", "2026-09-10T08:02:00Z"));
    assert.equal(
      await apply(
        "d2",
        "pipeline",
        pipeline("failing", "2026-09-10T08:02:00Z"),
      ),
      false,
    );
    // An older delivery arriving late changes nothing.
    await apply("d3", "pipeline", pipeline("passing", "2026-09-10T08:00:00Z"));
    await apply("d4", "pipeline", pipeline("passing", "2026-09-10T08:03:00Z"));
    await apply(
      "d5",
      "deployment",
      deployment("queued", "2026-09-10T08:04:00Z"),
    );
    await apply(
      "d6",
      "deployment",
      deployment("successful", "2026-09-10T08:05:00Z"),
    );
    assert.deepEqual(await stored(pool), [
      "pipeline.failed",
      "pipeline.recovered",
      "deployment.succeeded",
    ]);
  });
});

test("CI recovers across reruns and later commits of one check on a branch", async (t) => {
  await withListener(t, async ({ pool }) => {
    const wall = new WallStore(pool);
    const run = (
      delivery: string,
      id: string,
      status: PipelineState["status"],
      updatedAt: string,
      branch = "main",
    ) =>
      wall.apply(99, 7, "acme/api", delivery, [
        {
          kind: "pipeline",
          observedAt: updatedAt,
          value: { ...pipeline(status, updatedAt), id, branch },
        },
      ]);
    await run("r1", "check:1", "failing", "2026-09-10T08:00:00Z");
    // A rerun gets a new ID; failing again is not a new failure.
    await run("r2", "check:2", "running", "2026-09-10T08:05:00Z");
    await run("r3", "check:2", "failing", "2026-09-10T08:10:00Z");
    // Another branch is another pipeline.
    await run("r4", "check:3", "passing", "2026-09-10T08:12:00Z", "feature");
    // The next commit's run passes: CI has recovered.
    await run("r5", "check:4", "queued", "2026-09-10T08:15:00Z");
    await run("r6", "check:4", "passing", "2026-09-10T08:20:00Z");
    // A late result from the first run announces nothing.
    await run("r7", "check:1", "passing", "2026-09-10T08:01:00Z");
    assert.deepEqual(await stored(pool), [
      "pipeline.failed",
      "pipeline.recovered",
    ]);
  });
});

test("concurrent first deliveries of a signal announce one transition", async (t) => {
  await withListener(t, async ({ pool }) => {
    const wall = new WallStore(pool);
    await Promise.all(
      ["08:00", "08:01", "08:02"].map((time, index) => {
        const value = pipeline("failing", `2026-09-10T${time}:00Z`);
        return wall.apply(99, 7, "acme/api", `race-${index}`, [
          { kind: "pipeline", observedAt: value.updatedAt, value },
        ]);
      }),
    );
    assert.deepEqual(await stored(pool), ["pipeline.failed"]);
  });
});

test("live GitHub activity is announced once, in the merge's transaction", async (t) => {
  await withListener(t, async ({ events, pool }) => {
    const merge: ActivityEvent = {
      id: "acme/api:pr:12:merged",
      type: "merge",
      actor: { login: "sarahpark" },
      repo: "acme/api",
      title: "Faster builds",
      occurredAt: "2026-09-10T08:00:00.000Z",
      number: 12,
      repositoryId: 7,
    };
    const afterWrite = async (
      client: Parameters<typeof recordInstallationEvent>[0],
      added: ActivityEvent[],
    ) => {
      for (const event of added)
        await recordInstallationEvent(client, 99, activityOutboxEvent(event)!);
    };
    for (const deliveryId of ["gh-1", "gh-1", "gh-2"])
      await events.merge("installation-99", [merge], {
        restricted: true,
        deliveryId,
        afterWrite,
      });
    assert.deepEqual(await stored(pool), ["activity.merge"]);
    // A failed merge leaves no event behind.
    await assert.rejects(
      events.merge(
        "installation-99",
        [{ ...merge, id: "bad", occurredAt: "not a date" }],
        { restricted: true, deliveryId: "gh-3", afterWrite },
      ),
    );
    assert.deepEqual(await stored(pool), ["activity.merge"]);
  });
});
