import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { Pool } from "pg";
import { AuthError } from "./auth.js";
import { PostgresEventStore } from "./postgres-store.js";
import { SecretBox } from "./secret-box.js";
import { createTestDatabase } from "./test-database.js";
import { urlHint, validateWebhook, WebhookStore } from "./webhook-store.js";
import { WEBHOOK_PRESETS } from "../shared/webhooks.js";

async function withStore(
  t: TestContext,
  run: (fixture: {
    store: WebhookStore;
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
      "INSERT INTO ship_live_workspaces(id,name,kind) VALUES($1,'Acme','team')",
      [workspace],
    );
    await events.pool.query(
      "INSERT INTO ship_live_auth_users(id,name) VALUES($1,'Builder')",
      [user],
    );
    await run({
      store: new WebhookStore(events.pool, new SecretBox("11".repeat(32))),
      pool: events.pool,
      workspace,
      user,
    });
  } finally {
    await events.close();
  }
}

const slack = {
  name: "Deploys",
  preset: "slack",
  url: "https://hooks.slack.com/services/T000/B000/secret-token",
  method: "POST",
  contentType: "application/json",
  template: WEBHOOK_PRESETS.slack.template,
  signing: "ship",
  successPath: "",
  successValue: null,
  events: ["deployment.failed", "incident.opened"],
  filters: { environments: ["production"] },
  cooldownSeconds: 300,
  enabled: true,
};

test("URL hints never show path tokens", () => {
  assert.equal(
    urlHint("https://hooks.slack.com/services/T000/B000/xyz"),
    "https://hooks.slack.com/services/…",
  );
  assert.equal(
    urlHint("https://example.com/secret-token"),
    "https://example.com/…",
  );
  assert.equal(urlHint("https://example.com"), "https://example.com");
});

test("validation renders every subscribed event and rejects unsafe settings", () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ url: "http://127.0.0.1/hook" }, /public HTTP/],
    [{ url: undefined }, /Enter the webhook URL/],
    [{ method: "GET" }, /POST, PUT, or PATCH/],
    [{ template: '{"text": {{summary}}}' }, /not valid JSON/],
    [{ template: "{{#if}}{{/if}}" }, /needs a value/],
    [{ events: [] }, /at least one/],
    [{ events: ["activity.deploy"] }, /at least one known/],
    [{ headers: { "X-Ship-Event": "x" } }, /set by ship\.live/],
    [{ headers: { Host: "evil" } }, /forbidden/],
    [{ successPath: "__proto__.x" }, /JSON path/],
    [{ cooldownSeconds: -1 }, /cooldown/],
    [{ secret: "short" }, /8–512/],
    [{ filters: { owners: ["x"] } }, /Unknown filter/],
    [{ name: "" }, /Name the webhook/],
    [{ preset: "pager" }, /preset/],
  ];
  for (const [change, pattern] of cases)
    assert.throws(
      () => validateWebhook({ ...slack, ...change }, true),
      (error: unknown) =>
        error instanceof AuthError &&
        error.status === 400 &&
        pattern.test(error.message),
      JSON.stringify(change),
    );
  // A template that renders for one event type but not another fails at save.
  assert.throws(
    () =>
      validateWebhook(
        {
          ...slack,
          template: '{"minutes": {{data.incident.durationSeconds}}}',
          events: ["incident.resolved", "incident.opened"],
        },
        true,
      ),
    /Incident opened/,
  );
  assert.deepEqual(
    validateWebhook(
      { ...slack, events: ["inbound.grafana", "inbound", "inbound"] },
      true,
    ).events,
    ["inbound.grafana", "inbound"],
  );
});

test("URLs, headers, and secrets are sealed; views show only hints and names", async (t) => {
  await withStore(t, async ({ store, pool, workspace, user }) => {
    const saved = await store.create(
      workspace,
      user,
      {
        ...slack,
        headers: { Authorization: "Bearer hidden-value" },
        secret: "generate",
      },
      [11, 12],
    );
    assert.match(saved.secret!, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(saved.webhook.urlHint, "https://hooks.slack.com/services/…");
    assert.deepEqual(saved.webhook.headerNames, ["authorization"]);
    assert.equal(saved.webhook.hasSecret, true);
    assert.equal(saved.webhook.creator.name, "Builder");
    assert.equal(saved.webhook.lastDelivery, null);
    const raw = JSON.stringify(
      (await pool.query("SELECT * FROM ship_live_webhooks")).rows,
    );
    for (const secret of ["secret-token", "hidden-value", saved.secret!])
      assert.ok(!raw.includes(secret), secret);
    const target = await store.targetById(workspace, saved.webhook.id);
    assert.equal(target.url, slack.url);
    assert.deepEqual(target.headers, { authorization: "Bearer hidden-value" });
    assert.equal(target.secret, saved.secret);
    assert.deepEqual(target.repositoryIds, [11, 12]);

    // Secret fields left out keep their values; "" removes the secret. The
    // editor becomes the owner, with their repositories.
    const editor = randomUUID();
    await pool.query(
      "INSERT INTO ship_live_auth_users(id,name) VALUES($1,'Editor')",
      [editor],
    );
    const updated = await store.update(
      workspace,
      saved.webhook.id,
      editor,
      { ...slack, url: undefined, name: "Prod deploys", secret: "" },
      [12],
    );
    assert.equal(updated.webhook.name, "Prod deploys");
    assert.equal(updated.webhook.hasSecret, false);
    assert.equal(updated.webhook.creator.name, "Editor");
    assert.equal(updated.secret, undefined);
    const after = await store.targetById(workspace, saved.webhook.id);
    assert.equal(after.url, slack.url);
    assert.deepEqual(after.headers, { authorization: "Bearer hidden-value" });
    assert.deepEqual(after.repositoryIds, [12]);

    // Another workspace can neither see nor change it.
    const elsewhere = randomUUID();
    await pool.query(
      "INSERT INTO ship_live_workspaces(id,name,kind) VALUES($1,'Other','team')",
      [elsewhere],
    );
    assert.deepEqual((await store.settings(elsewhere)).webhooks, []);
    await assert.rejects(
      store.update(elsewhere, saved.webhook.id, user, slack, []),
      /not found/,
    );
    await assert.rejects(
      store.targetById(elsewhere, saved.webhook.id),
      /not found/,
    );
    await assert.rejects(
      store.remove(elsewhere, saved.webhook.id),
      /not found/,
    );
    await store.remove(workspace, saved.webhook.id);
    assert.deepEqual((await store.settings(workspace)).webhooks, []);
  });
});

test("without an encryption key nothing is saved", async (t) => {
  await withStore(t, async ({ pool, workspace, user }) => {
    const store = new WebhookStore(pool, new SecretBox(""));
    assert.equal(store.configured, false);
    await assert.rejects(
      store.create(workspace, user, slack, []),
      (error: unknown) => error instanceof AuthError && error.status === 503,
    );
  });
});

test("inbound endpoints keep only a token hash, rotate, and keep 50 receipts", async (t) => {
  await withStore(t, async ({ store, pool, workspace, user }) => {
    const saved = await store.createInbound(workspace, user, {
      name: "Grafana",
      slug: "grafana",
      mapping: { title: "{{payload.title}}", body: "", url: "", id: "" },
      secret: "generate",
    });
    assert.match(saved.endpoint!, /^\/api\/hooks\/[A-Za-z0-9_-]{32}$/);
    const token = saved.endpoint!.split("/").pop()!;
    const raw = JSON.stringify(
      (await pool.query("SELECT * FROM ship_live_inbound_hooks")).rows,
    );
    assert.ok(!raw.includes(token));
    assert.ok(!raw.includes(saved.secret!));
    const target = await store.inboundByToken(token);
    assert.equal(target?.slug, "grafana");
    assert.equal(target?.secret, saved.secret);
    assert.equal(await store.inboundByToken("x".repeat(32)), undefined);
    await assert.rejects(
      store.createInbound(workspace, user, {
        name: "Duplicate",
        slug: "grafana",
        mapping: { title: "x" },
      }),
      /uses that slug/,
    );
    await assert.rejects(
      store.createInbound(workspace, user, {
        name: "Bad",
        slug: "Bad Slug",
        mapping: { title: "x" },
      }),
      /lowercase/,
    );
    const rotated = await store.rotateInbound(workspace, saved.hook.id);
    assert.equal(await store.inboundByToken(token), undefined);
    assert.equal(
      (await store.inboundByToken(rotated.endpoint!.split("/").pop()!))?.id,
      saved.hook.id,
    );
    for (let index = 0; index < 55; index += 1)
      await store.receipt(
        saved.hook.id,
        index % 2 === 0,
        `event ${index}`,
        null,
      );
    const { rows } = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM ship_live_inbound_receipts",
    );
    assert.equal(rows[0].count, 50);
    const [view] = (await store.settings(workspace)).inbound;
    assert.equal(view.receipts.length, 10);
    assert.equal(view.receipts[0].summary, "event 54");
    assert.ok(view.lastReceivedAt);
  });
});
