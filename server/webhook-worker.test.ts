import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { Pool } from "pg";
import type { ActivityEvent } from "../shared/types.js";
import { WEBHOOK_PRESETS } from "../shared/webhooks.js";
import type { OutboundRequest, OutboundResponse } from "./outbound.js";
import { PostgresEventStore } from "./postgres-store.js";
import { SecretBox } from "./secret-box.js";
import { createTestDatabase } from "./test-database.js";
import { activityOutboxEvent, healthOutboxEvents } from "./webhook-events.js";
import {
  claimDeliveries,
  completeDelivery,
  recordInstallationEvent,
  recordWorkspaceEvent,
  routeEvents,
  type AccessCheck,
} from "./webhook-outbox.js";
import { larkSignature, verifyShipSignature } from "./webhook-signing.js";
import { WebhookStore, type WebhookTarget } from "./webhook-store.js";
import {
  MAX_ATTEMPTS,
  outcomeOf,
  performDelivery,
  prepareRequest,
} from "./webhook-worker.js";

interface Fixture {
  pool: Pool;
  store: WebhookStore;
  workspace: string;
  user: string;
  webhook: string;
  secret: string;
}

async function withWebhook(
  t: TestContext,
  settings: Record<string, unknown>,
  run: (fixture: Fixture) => Promise<void>,
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
    const store = new WebhookStore(events.pool, new SecretBox("11".repeat(32)));
    const saved = await store.create(
      workspace,
      user,
      {
        name: "Receiver",
        preset: "generic",
        url: "https://hooks.example.com/services/T/B/token",
        method: "POST",
        contentType: "application/json",
        template: WEBHOOK_PRESETS.generic.template,
        signing: "ship",
        secret: "generate",
        successPath: "",
        successValue: null,
        events: ["activity.merge", "incident.opened", "incident.resolved"],
        filters: {},
        cooldownSeconds: 0,
        enabled: true,
        ...settings,
      },
      [7],
    );
    await run({
      pool: events.pool,
      store,
      workspace,
      user,
      webhook: saved.webhook.id,
      secret: saved.secret ?? "",
    });
  } finally {
    await events.close();
  }
}

const merge = (id: string, repositoryId = 7): ActivityEvent => ({
  id,
  type: "merge",
  actor: { login: "sarahpark" },
  repo: repositoryId === 7 ? "acme/api" : "acme/secret",
  title: "Faster builds",
  url: "https://github.com/acme/api/pull/12",
  occurredAt: "2026-09-10T08:00:00.000Z",
  number: 12,
  branch: "main",
  repositoryId,
});
const count = async (pool: Pool, sql: string, params: unknown[] = []) =>
  (await pool.query<{ count: number }>(sql, params)).rows[0].count;
const reply =
  (status: number | null, body = "", retryAfter?: number) =>
  async (): Promise<OutboundResponse> => ({
    status,
    body,
    latencyMs: 1,
    ...(retryAfter ? { retryAfter } : {}),
    ...(status === null ? { error: "The connection failed." } : {}),
  });

test("events are stored once, only for listening team workspaces, and routed by repository access", async (t) => {
  await withWebhook(t, {}, async ({ pool, user, workspace }) => {
    let visible = new Set([7, 8]);
    const access: AccessCheck = async (id, space) =>
      id === user && space === workspace ? visible : undefined;
    const record = (event: ActivityEvent, installation = 99) =>
      recordInstallationEvent(pool, installation, activityOutboxEvent(event)!);
    await record(merge("pinned"));
    await record(merge("pinned"));
    await record(merge("unpinned", 8));
    await record(merge("other-installation"), 100);
    await record({ ...merge("review"), type: "review" });
    assert.equal(
      await count(
        pool,
        "SELECT count(*)::int AS count FROM ship_live_webhook_events",
      ),
      2,
    );
    assert.equal(await routeEvents(pool, access), 2);
    assert.equal(await routeEvents(pool, access), 0);
    // Only the pinned repository the owner can still see is delivered.
    const { rows } = await pool.query<{ summary: string; status: string }>(
      `SELECT e.payload->>'summary' AS summary, d.status FROM ship_live_webhook_deliveries d
       JOIN ship_live_webhook_events e ON e.id = d.event_id`,
    );
    assert.deepEqual(rows, [
      {
        summary: "sarahpark merged #12 in acme/api into main: Faster builds",
        status: "pending",
      },
    ]);
    // Once the owner loses access, activity from that repository stops.
    visible = new Set([8]);
    await record(merge("after-revocation"));
    await routeEvents(pool, access);
    assert.equal(
      await count(
        pool,
        "SELECT count(*)::int AS count FROM ship_live_webhook_deliveries",
      ),
      1,
    );
  });
});

test("deliveries are signed, retried with backoff, and final on success", async (t) => {
  await withWebhook(t, {}, async ({ pool, store, user, secret }) => {
    await recordInstallationEvent(pool, 99, activityOutboxEvent(merge("a"))!);
    await routeEvents(pool, async (id) =>
      id === user ? new Set([7]) : undefined,
    );
    const [claim] = await claimDeliveries(pool, 4);
    assert.ok(claim);
    assert.deepEqual(await claimDeliveries(pool, 4), []);
    const failed = await performDelivery(store, claim, reply(503));
    assert.equal(failed.status, "pending");
    assert.equal(failed.retryInSeconds, 60);
    assert.equal(await completeDelivery(pool, claim, failed), true);
    assert.deepEqual(await claimDeliveries(pool, 4), []);
    await pool.query(
      "UPDATE ship_live_webhook_deliveries SET next_attempt_at = now()",
    );
    const [retry] = await claimDeliveries(pool, 4);
    assert.equal(retry.attempts, 1);
    const sent: OutboundRequest[] = [];
    const outcome = await performDelivery(store, retry, async (request) => {
      sent.push(request);
      return reply(202, "ok")();
    });
    assert.equal(outcome.status, "succeeded");
    await completeDelivery(pool, retry, outcome);
    const [request] = sent;
    assert.equal(request.url, "https://hooks.example.com/services/T/B/token");
    assert.equal(request.headers["x-ship-event"], "activity.merge");
    assert.equal(request.headers["x-ship-delivery"], retry.id);
    assert.equal(
      verifyShipSignature(
        secret,
        Number(request.headers["x-ship-timestamp"]),
        request.body,
        request.headers["x-ship-signature"],
      ),
      true,
    );
    const body = JSON.parse(request.body);
    assert.equal(body.version, 1);
    assert.equal(body.type, "activity.merge");
    assert.equal(body.workspace.name, "Acme");
    const { rows } = await pool.query(
      "SELECT status, attempts, response_status, finished_at IS NOT NULL AS finished FROM ship_live_webhook_deliveries",
    );
    assert.deepEqual(rows, [
      {
        status: "succeeded",
        attempts: 2,
        response_status: 202,
        finished: true,
      },
    ]);
  });
});

test("an expired lease is claimed again and a stale completion is ignored", async (t) => {
  await withWebhook(t, {}, async ({ pool, store, user }) => {
    await recordInstallationEvent(pool, 99, activityOutboxEvent(merge("a"))!);
    await routeEvents(pool, async (id) =>
      id === user ? new Set([7]) : undefined,
    );
    const [first] = await claimDeliveries(pool, 4);
    await pool.query(
      "UPDATE ship_live_webhook_deliveries SET lease_until = now() - interval '1 second'",
    );
    const [second] = await claimDeliveries(pool, 4);
    assert.equal(second.id, first.id);
    assert.notEqual(second.lease, first.lease);
    const outcome = await performDelivery(store, first, reply(200));
    assert.equal(await completeDelivery(pool, first, outcome), false);
    assert.equal(await completeDelivery(pool, second, outcome), true);
  });
});

test("410 Gone pauses the webhook, and paused webhooks are not delivered", async (t) => {
  await withWebhook(
    t,
    {},
    async ({ pool, store, user, webhook, workspace }) => {
      for (const id of ["a", "b"])
        await recordInstallationEvent(
          pool,
          99,
          activityOutboxEvent(merge(id))!,
        );
      await routeEvents(pool, async (id) =>
        id === user ? new Set([7]) : undefined,
      );
      const [claim] = await claimDeliveries(pool, 1);
      await completeDelivery(
        pool,
        claim,
        await performDelivery(store, claim, reply(410)),
      );
      const [view] = (await store.settings(workspace)).webhooks;
      assert.equal(view.id, webhook);
      assert.equal(view.enabled, false);
      assert.match(view.pausedReason!, /410 Gone/);
      assert.equal(view.lastDelivery?.status, "failed");
      assert.deepEqual(await claimDeliveries(pool, 4), []);
    },
  );
});

test("cooldowns hold repeated alerts about one probe until it recovers", async (t) => {
  await withWebhook(
    t,
    { cooldownSeconds: 600 },
    async ({ pool, workspace, user }) => {
      const identity = {
        service: { id: "s1", name: "Public API" },
        probe: { id: "p1", name: "Health" },
      };
      const down = {
        ok: false,
        latencyMs: 1,
        statusCode: 503,
        reason: "Down.",
      };
      const up = {
        ok: true,
        latencyMs: 1,
        statusCode: 200,
        reason: "Probe passed.",
      };
      const incident = async (id: string, resolved: boolean) => {
        for (const event of healthOutboxEvents(
          identity,
          resolved ? "down" : "healthy",
          resolved ? "healthy" : "down",
          resolved ? up : down,
          `2026-09-10T08:0${id}:00.000Z`,
          {
            id: `incident-${id}`,
            openedAt: "2026-09-10T08:00:00.000Z",
            resolvedAt: resolved ? `2026-09-10T08:0${id}:00.000Z` : null,
          },
        ))
          await recordWorkspaceEvent(pool, workspace, event);
        await routeEvents(pool, async (id) =>
          id === user ? new Set() : undefined,
        );
      };
      await incident("1", false);
      await incident("2", false);
      await incident("3", true);
      await incident("4", false);
      const { rows } = await pool.query<{ type: string; status: string }>(
        `SELECT e.type, d.status FROM ship_live_webhook_deliveries d
       JOIN ship_live_webhook_events e ON e.id = d.event_id ORDER BY e.created_at`,
      );
      assert.deepEqual(
        rows.map((row) => `${row.type}:${row.status}`),
        [
          "incident.opened:pending",
          "incident.opened:skipped",
          "incident.resolved:pending",
          "incident.opened:pending",
        ],
      );
    },
  );
});

const target: WebhookTarget = {
  id: "w1",
  workspaceId: "ws",
  creatorUserId: "u",
  name: "Lark",
  url: "https://open.larksuite.com/open-apis/bot/v2/hook/token",
  method: "POST",
  contentType: "application/json",
  template: WEBHOOK_PRESETS.lark.template,
  headers: {},
  secret: "lark-secret",
  signing: "lark",
  successPath: "code",
  successValue: 0,
  events: ["incident.opened"],
  filters: {},
  cooldownSeconds: 0,
  repositoryIds: [],
  enabled: true,
};

test("Lark signing goes in the body, and Lark's reply code decides success", () => {
  const event = {
    version: 1 as const,
    id: "e1",
    type: "incident.opened",
    occurredAt: "2026-09-10T08:00:00.000Z",
    workspace: { id: "ws", name: "Acme" },
    summary: "Incident: Public API / Health is down",
    data: {},
  };
  const now = Date.parse("2026-09-10T08:00:05.000Z");
  const request = prepareRequest(target, event, { id: "d1", attempt: 1 }, now);
  const body = JSON.parse(request.body);
  assert.equal(body.timestamp, String(Math.floor(now / 1000)));
  assert.equal(body.sign, larkSignature("lark-secret", Math.floor(now / 1000)));
  assert.equal(body.card.header.template, "red");
  assert.equal(request.headers["x-ship-signature"], undefined);
  const ok = outcomeOf(
    target,
    { status: 200, body: '{"code":0}', latencyMs: 1 },
    1,
    "",
  );
  assert.equal(ok.status, "succeeded");
  const rejected = outcomeOf(
    target,
    {
      status: 200,
      body: '{"code":19021,"msg":"sign match fail"}',
      latencyMs: 1,
    },
    1,
    "",
  );
  assert.equal(rejected.status, "pending");
  assert.match(rejected.error!, /code was 19021, not 0/);
});

test("retry rules: final 4xx, Retry-After, and giving up", () => {
  const plain = { successPath: null, successValue: null };
  assert.equal(
    outcomeOf(plain, { status: 400, body: "", latencyMs: 1 }, 1, "").status,
    "failed",
  );
  assert.equal(
    outcomeOf(
      plain,
      { status: 429, body: "", latencyMs: 1, retryAfter: 900 },
      1,
      "",
    ).retryInSeconds,
    900,
  );
  assert.equal(
    outcomeOf(
      plain,
      { status: null, body: "", latencyMs: 1, error: "x" },
      2,
      "",
    ).retryInSeconds,
    300,
  );
  const last = outcomeOf(
    plain,
    { status: 502, body: "", latencyMs: 1 },
    MAX_ATTEMPTS,
    "",
  );
  assert.equal(last.status, "dead");
  assert.match(last.error!, /Gave up after 6 attempts/);
});
