import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import express, { type ErrorRequestHandler } from "express";
import type { Pool } from "pg";
import { WEBHOOK_PRESETS } from "../shared/webhooks.js";
import { AuthError, type AuthService, type Principal } from "./auth.js";
import type { OutboundRequest } from "./outbound.js";
import { PostgresEventStore } from "./postgres-store.js";
import { SecretBox } from "./secret-box.js";
import { createTestDatabase } from "./test-database.js";
import { inboundReceiver, webhookRouter } from "./webhook-app.js";
import { WebhookStore } from "./webhook-store.js";

interface Api {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  pool: Pool;
  workspace: string;
  sent: OutboundRequest[];
}

async function withApi(
  t: TestContext,
  kind: "team" | "personal",
  run: (api: Api) => Promise<void>,
) {
  const database = await createTestDatabase(t);
  if (!database) return;
  const events = await PostgresEventStore.open(database);
  const workspace = randomUUID();
  const user = randomUUID();
  await events.pool.query(
    "INSERT INTO ship_live_auth_users(id,name) VALUES($1,'Builder')",
    [user],
  );
  await events.pool.query(
    kind === "team"
      ? "INSERT INTO ship_live_workspaces(id,name,kind,installation_id) VALUES($1,'Acme','team',99)"
      : "INSERT INTO ship_live_workspaces(id,name,kind,owner_user_id) VALUES($1,'Journal','personal',$2)",
    kind === "team" ? [workspace] : [workspace, user],
  );
  const principal = {
    user: { id: user, name: "Builder" },
    sessionId: "session",
    csrfToken: "csrf",
  } as unknown as Principal;
  const auth = {
    authenticate: async () => principal,
    requireMutation: async () => principal,
    assertActive: async () => {},
    config: { appUrl: "https://ship.example.test" },
  } as unknown as AuthService;
  const viewer = async (_principal: Principal, id: string) => {
    if (id !== workspace) throw new AuthError(404, "Workspace not found.");
    return {
      workspace: { id, name: "Acme", kind, owner: kind === "personal" },
      repositories: [{ id: 7 }],
    };
  };
  const store = new WebhookStore(events.pool, new SecretBox("11".repeat(32)));
  const sent: OutboundRequest[] = [];
  const app = express();
  app.use(inboundReceiver({ webhooks: store, pool: events.pool }));
  app.use(express.json());
  app.use(
    webhookRouter({
      auth,
      webhooks: store,
      viewer: viewer as never,
      send: async (request) => {
        sent.push(request);
        return { status: 200, body: '{"ok":true}', latencyMs: 3 };
      },
    }),
  );
  const errors: ErrorRequestHandler = (error, _request, response, _next) => {
    response
      .status(error instanceof AuthError ? error.status : 500)
      .json({ error: error.message });
  };
  app.use(errors);
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    await run({
      request: (path, init = {}) =>
        fetch(`http://127.0.0.1:${port}${path}`, {
          ...init,
          headers: {
            "content-type": "application/json",
            ...(init.headers as Record<string, string>),
          },
          signal: AbortSignal.timeout(4000),
        }),
      pool: events.pool,
      workspace,
      sent,
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await events.close();
  }
}

const slack = {
  name: "Deploys",
  preset: "slack",
  url: "https://hooks.slack.com/services/T000/B000/secret-token",
  template: WEBHOOK_PRESETS.slack.template,
  secret: "generate",
  events: ["activity.merge"],
};
const post = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
});

test("team members create, test, update, and delete webhooks without seeing secrets", async (t) => {
  await withApi(t, "team", async ({ request, workspace, sent }) => {
    const base = `/api/workspaces/${workspace}/webhooks`;
    const created = await request(base, post(slack));
    assert.equal(created.status, 201);
    const saved = await created.json();
    assert.match(saved.secret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(saved.webhook.urlHint, "https://hooks.slack.com/services/…");
    const listing = await (await request(base)).json();
    assert.equal(listing.configured, true);
    assert.equal(listing.webhooks.length, 1);
    const text = JSON.stringify(listing);
    for (const secret of ["secret-token", saved.secret])
      assert.ok(!text.includes(secret));

    const test = await request(
      `${base}/${saved.webhook.id}/test`,
      post({ eventType: "activity.merge" }),
    );
    const result = await test.json();
    assert.deepEqual(
      { ok: result.ok, status: result.status },
      { ok: true, status: 200 },
    );
    assert.equal(sent[0].url, slack.url);
    assert.match(sent[0].headers["x-ship-signature"], /^v1=[a-f\d]{64}$/);
    assert.match(JSON.parse(sent[0].body).text, /merged #428/);

    const rejected = await request(`${base}/${saved.webhook.id}`, {
      method: "PUT",
      body: JSON.stringify({ ...slack, template: '{"text": {{summary}}}' }),
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /not valid JSON/);
    assert.equal(
      (await request(`/api/workspaces/${randomUUID()}/webhooks`)).status,
      404,
    );
    assert.equal(
      (await request(`${base}/${saved.webhook.id}`, { method: "DELETE" }))
        .status,
      204,
    );
    assert.deepEqual((await (await request(base)).json()).webhooks, []);
  });
});

test("a journal's owner manages its own webhooks", async (t) => {
  await withApi(t, "personal", async ({ request, workspace }) => {
    const base = `/api/workspaces/${workspace}/webhooks`;
    assert.equal((await request(base)).status, 200);
    assert.equal((await request(base, post(slack))).status, 201);
    assert.equal((await (await request(base)).json()).webhooks.length, 1);
  });
});

test("inbound endpoints accept signed JSON, map it, and deduplicate by the sender's ID", async (t) => {
  await withApi(t, "team", async ({ request, pool, workspace }) => {
    await request(
      `/api/workspaces/${workspace}/webhooks`,
      post({ ...slack, events: ["inbound"] }),
    );
    const created = await request(
      `/api/workspaces/${workspace}/inbound`,
      post({
        name: "Grafana",
        slug: "grafana",
        secret: "generate",
        mapping: {
          title:
            "{{payload.title}}{{#if payload.state}} is {{payload.state}}{{/if}}",
          body: "{{payload.message}}",
          url: "{{payload.link}}",
          id: "{{payload.id}}",
        },
      }),
    );
    assert.equal(created.status, 201);
    const saved = await created.json();
    const endpoint = new URL(saved.endpoint);
    assert.equal(endpoint.origin, "https://ship.example.test");
    assert.match(endpoint.pathname, /^\/api\/hooks\/[A-Za-z0-9_-]{32}$/);
    const send = (body: string, secret = saved.secret) =>
      request(endpoint.pathname, {
        method: "POST",
        body,
        headers: {
          "x-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        },
      });
    const alert = JSON.stringify({
      id: "alert-1",
      title: "API latency",
      state: "alerting",
      message: "p95 above 800 ms",
      link: "https://grafana.example.com/d/1",
    });
    assert.equal((await send(alert)).status, 202);
    assert.equal((await send(alert)).status, 202);
    assert.equal((await send(alert, "wrong-secret-value")).status, 401);
    assert.equal((await send("not json")).status, 400);
    assert.equal((await send(JSON.stringify({ id: "x" }))).status, 422);
    assert.equal(
      (await request(`/api/hooks/${"x".repeat(32)}`, post({}))).status,
      404,
    );
    const { rows } = await pool.query<{
      type: string;
      summary: string;
      url: string;
      body: string;
    }>(
      `SELECT type, payload->>'summary' AS summary, payload->>'url' AS url,
         payload->'data'->>'body' AS body FROM ship_live_webhook_events`,
    );
    assert.deepEqual(rows, [
      {
        type: "inbound.grafana",
        summary: "API latency is alerting",
        url: "https://grafana.example.com/d/1",
        body: "p95 above 800 ms",
      },
    ]);
    const settings = await (
      await request(`/api/workspaces/${workspace}/webhooks`)
    ).json();
    const receipts = settings.inbound[0].receipts;
    assert.equal(receipts.length, 5);
    assert.deepEqual(
      receipts.map((receipt: { accepted: boolean }) => receipt.accepted),
      [false, false, false, true, true],
    );
    assert.match(receipts[0].error, /title mapping/);
  });
});

test("inbound alerts are kept without an outbound webhook and refresh Live activity", async (t) => {
  await withApi(t, "team", async ({ request, pool, workspace }) => {
    const created = await request(
      `/api/workspaces/${workspace}/inbound`,
      post({
        name: "Grafana",
        slug: "grafana",
        mapping: {
          title: "{{payload.title}}",
          body: "{{payload.message}}",
          url: "{{payload.link}}",
          id: "",
        },
      }),
    );
    assert.equal(created.status, 201);
    const { endpoint } = await created.json();
    const listener = await pool.connect();
    const notifications: unknown[] = [];
    listener.on("notification", (message) =>
      notifications.push(JSON.parse(message.payload ?? "null")),
    );
    await listener.query("LISTEN ship_live_event_changes");
    try {
      const sent = await request(new URL(endpoint).pathname, {
        method: "POST",
        body: JSON.stringify({
          title: "API latency",
          message: "p95 above 800 ms",
          link: "https://grafana.example.com/d/1",
        }),
      });
      assert.equal(sent.status, 202);
      for (let wait = 0; wait < 50 && !notifications.length; wait++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(notifications, [
        { organization: `workspace-${workspace}`, eventId: "refresh" },
      ]);
    } finally {
      await listener.query("UNLISTEN *");
      listener.release();
    }
    const alerts = await new WebhookStore(
      pool,
      new SecretBox("11".repeat(32)),
    ).alerts(workspace);
    assert.equal(alerts.length, 1);
    const { id, occurredAt, ...alert } = alerts[0];
    assert.match(id, /^alert:/);
    assert.ok(Math.abs(Date.parse(occurredAt) - Date.now()) < 60_000);
    assert.deepEqual(alert, {
      type: "alert",
      actor: { login: "Grafana" },
      repo: "inbound.grafana",
      title: "API latency",
      url: "https://grafana.example.com/d/1",
      body: "p95 above 800 ms",
    });
  });
});
