import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { Pool } from "pg";
import { WEBHOOK_PRESETS } from "../shared/webhooks.js";
import { mondayOf, scheduleDigests, withDigest } from "./digest.js";
import { PostgresEventStore } from "./postgres-store.js";
import { SecretBox } from "./secret-box.js";
import { createTestDatabase } from "./test-database.js";
import { webhookEvent } from "./webhook-outbox.js";
import { WebhookStore } from "./webhook-store.js";

test("weeks start on Monday in UTC", () => {
  const monday = Date.parse("2026-09-07T00:00:00Z");
  assert.equal(mondayOf(Date.parse("2026-09-09T15:00:00Z")), monday);
  assert.equal(mondayOf(monday), monday);
  assert.equal(mondayOf(Date.parse("2026-09-13T23:59:59Z")), monday);
  assert.equal(
    mondayOf(Date.parse("2026-09-06T23:59:59Z")),
    Date.parse("2026-08-31T00:00:00Z"),
  );
});

async function withWorkspace(
  t: TestContext,
  run: (fixture: {
    pool: Pool;
    workspace: string;
    user: string;
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
    await run({ pool: events.pool, workspace, user });
  } finally {
    await events.close();
  }
}

const listen = (pool: Pool, workspace: string, user: string) =>
  new WebhookStore(pool, new SecretBox("11".repeat(32))).create(
    workspace,
    user,
    {
      name: "Digest",
      preset: "generic",
      url: "https://hooks.example.com/digest",
      template: WEBHOOK_PRESETS.generic.template,
      events: ["digest.weekly"],
    },
    [7],
  );

test("last week's digest is queued once, after Monday 09:00 UTC, for webhooks that were listening", async (t) => {
  await withWorkspace(t, async ({ pool, workspace, user }) => {
    await listen(pool, workspace, user);
    await pool.query("UPDATE ship_live_webhooks SET created_at = '2026-08-01'");
    // A second team whose webhook was added after this week's send time.
    const late = randomUUID();
    await pool.query(
      "INSERT INTO ship_live_workspaces(id,name,kind,installation_id) VALUES($1,'Late','team',100)",
      [late],
    );
    await listen(pool, late, user);
    await pool.query(
      "UPDATE ship_live_webhooks SET created_at = '2026-09-07T10:00:00Z' WHERE workspace_id = $1",
      [late],
    );
    assert.equal(
      await scheduleDigests(pool, Date.parse("2026-09-07T08:59:00Z")),
      0,
    );
    assert.equal(
      await scheduleDigests(pool, Date.parse("2026-09-07T09:30:00Z")),
      1,
    );
    assert.equal(
      await scheduleDigests(pool, Date.parse("2026-09-08T12:00:00Z")),
      0,
    );
    const { rows } = await pool.query(
      "SELECT workspace_id, type, dedupe_key, payload->'data' AS data FROM ship_live_webhook_events",
    );
    assert.deepEqual(rows, [
      {
        workspace_id: workspace,
        type: "digest.weekly",
        dedupe_key: "digest:2026-08-31",
        data: { weekStart: "2026-08-31", weekEnd: "2026-09-06" },
      },
    ]);
  });
});

test("a digest counts only the week's activity in the webhook's repositories, with service uptime", async (t) => {
  await withWorkspace(t, async ({ pool, workspace }) => {
    await pool.query(
      "INSERT INTO ship_live_organizations(organization) VALUES ('installation-99')",
    );
    const activity = [
      ["m1", "merge", "sarahpark", 7, "2026-09-01T10:00:00Z"],
      ["m2", "merge", "sarahpark", 7, "2026-09-02T10:00:00Z"],
      ["r1", "review", "leowang", 7, "2026-09-03T10:00:00Z"],
      ["hidden", "merge", "secretive", 8, "2026-09-03T11:00:00Z"],
      ["late", "merge", "sarahpark", 7, "2026-09-08T10:00:00Z"],
    ] as const;
    for (const [id, type, login, repositoryId, occurredAt] of activity)
      await pool.query(
        "INSERT INTO ship_live_events(organization,event_id,event,occurred_at) VALUES('installation-99',$1,$2,$3)",
        [
          id,
          {
            id,
            type,
            actor: { login },
            repo: repositoryId === 7 ? "acme/api" : "acme/private",
            title: "Work",
            occurredAt,
            number: 1,
            repositoryId,
          },
          occurredAt,
        ],
      );
    const service = randomUUID();
    const probe = randomUUID();
    await pool.query(
      "INSERT INTO ship_live_health_services(id,workspace_id,name,display_order) VALUES($1,$2,'Public API',0)",
      [service, workspace],
    );
    await pool.query(
      `INSERT INTO ship_live_health_probes(id,workspace_id,service_id,config)
       VALUES($1,$2,$3,'{"name":"Health","enabled":true}')`,
      [probe, workspace, service],
    );
    for (const [ok, at] of [
      [true, "2026-09-01T00:00:00Z"],
      [true, "2026-09-02T00:00:00Z"],
      [false, "2026-09-03T00:00:00Z"],
      [false, "2026-09-09T00:00:00Z"],
    ] as const)
      await pool.query(
        "INSERT INTO ship_live_health_checks(probe_id,checked_at,result,state) VALUES($1,$2,$3,'healthy')",
        [probe, at, { ok, latencyMs: 1, statusCode: 200, reason: "" }],
      );
    await pool.query(
      `INSERT INTO ship_live_health_incidents(id,workspace_id,service_id,probe_id,opened_at,resolved_at,reason)
       VALUES($1,$2,$3,$4,'2026-09-03T00:00:00Z','2026-09-03T00:10:00Z','Down.')`,
      [randomUUID(), workspace, service, probe],
    );
    const event = webhookEvent({
      id: randomUUID(),
      workspace_id: workspace,
      workspace_name: "Acme",
      type: "digest.weekly",
      payload: {
        occurredAt: "2026-09-07T09:30:00Z",
        summary: "Weekly digest",
        data: { weekStart: "2026-08-31", weekEnd: "2026-09-06" },
      },
    });
    const digest = await withDigest(pool, event, [7]);
    assert.equal(
      digest.summary,
      "Acme's week: 2 merges, 1 review, 0 releases from 2 people",
    );
    assert.deepEqual(digest.data.totals, {
      merges: 2,
      reviews: 1,
      releases: 0,
      contributors: 2,
      xp: 75,
    });
    assert.deepEqual(
      (digest.data.topContributors as { login: string }[]).map(
        (person) => person.login,
      ),
      ["sarahpark", "leowang"],
    );
    assert.deepEqual(digest.data.repositories, [
      { name: "acme/api", merges: 2, reviews: 1 },
    ]);
    assert.deepEqual(digest.data.services, [
      { name: "Public API", uptime: 2 / 3, incidents: 1 },
    ]);
    // Without repositories, the digest carries service health only.
    const empty = await withDigest(pool, event, []);
    assert.equal((empty.data.totals as { merges: number }).merges, 0);
    assert.ok(!JSON.stringify(empty).includes("acme/private"));
  });
});
