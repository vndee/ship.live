import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { Pool } from "pg";
import { WEBHOOK_PRESETS } from "../shared/webhooks.js";
import { mondayOf, scheduleDigests, withDigest } from "./digest.js";
import { PostgresEventStore } from "./postgres-store.js";
import { SecretBox } from "./secret-box.js";
import { createTestDatabase } from "./test-database.js";
import { routeEvents, webhookEvent } from "./webhook-outbox.js";
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
    // A webhook added to the same team after the send time starts next week.
    const second = await listen(pool, workspace, user);
    await pool.query(
      "UPDATE ship_live_webhooks SET created_at = '2026-09-07T10:00:00Z' WHERE id = $1",
      [second.webhook.id],
    );
    await routeEvents(pool, async () => new Set([7]));
    const deliveries = await pool.query<{ webhook_id: string }>(
      "SELECT webhook_id FROM ship_live_webhook_deliveries",
    );
    assert.equal(deliveries.rows.length, 1);
    assert.notEqual(deliveries.rows[0].webhook_id, second.webhook.id);
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

test("a journal's digest counts its sources and only its owner's activity by default", async (t) => {
  await withWorkspace(t, async ({ pool, workspace, user }) => {
    const journal = randomUUID();
    await pool.query(
      "INSERT INTO ship_live_workspaces(id,name,kind,owner_user_id) VALUES($1,'Journal','personal',$2)",
      [journal, user],
    );
    await pool.query(
      "INSERT INTO ship_live_workspace_members(workspace_id,user_id) VALUES($1,$2)",
      [workspace, user],
    );
    await pool.query(
      "INSERT INTO ship_live_github_connections(user_id,github_user_id,login,encrypted_grant) VALUES($1,1,'SarahPark','sealed')",
      [user],
    );
    await pool.query(
      "INSERT INTO ship_live_organizations(organization) VALUES ('installation-99')",
    );
    for (const [id, login] of [
      ["mine", "sarahpark"],
      ["theirs", "leowang"],
    ])
      await pool.query(
        "INSERT INTO ship_live_events(organization,event_id,event,occurred_at) VALUES('installation-99',$1,$2,'2026-09-01T10:00:00Z')",
        [
          id,
          {
            id,
            type: "merge",
            actor: { login },
            repo: "acme/api",
            title: "Work",
            occurredAt: "2026-09-01T10:00:00Z",
            number: 1,
            repositoryId: 7,
          },
        ],
      );
    const event = webhookEvent({
      id: randomUUID(),
      workspace_id: journal,
      workspace_name: "Journal",
      type: "digest.weekly",
      payload: {
        occurredAt: "2026-09-07T09:30:00Z",
        summary: "Weekly digest",
        data: { weekStart: "2026-08-31", weekEnd: "2026-09-06" },
      },
    });
    const logins = async () =>
      (
        (await withDigest(pool, event, [7])).data.topContributors as {
          login: string;
        }[]
      ).map((person) => person.login);
    assert.deepEqual(await logins(), ["sarahpark"]);
    await pool.query(
      "UPDATE ship_live_workspaces SET source_mine_only=false WHERE id=$1",
      [journal],
    );
    assert.deepEqual((await logins()).sort(), ["leowang", "sarahpark"]);
    // A source left out of the journal is not counted.
    await pool.query(
      "UPDATE ship_live_workspaces SET source_installation_ids='{}' WHERE id=$1",
      [journal],
    );
    assert.deepEqual(await logins(), []);
  });
});

test("digest highlights authorized team shipping, cross-author reviews, and current help separately from the week", async (t) => {
  await withWorkspace(t, async ({ pool, workspace }) => {
    await pool.query(
      "INSERT INTO ship_live_organizations(organization) VALUES ('installation-99')",
    );
    const fixtures = [
      {
        id: "merge",
        type: "merge",
        login: "alice",
        number: 1,
        title: "Ship search",
        repositoryId: 7,
      },
      {
        id: "review",
        type: "review",
        login: "bob",
        number: 1,
        title: "Review search",
        repositoryId: 7,
      },
      {
        id: "self",
        type: "review",
        login: "alice",
        number: 1,
        title: "Self review",
        repositoryId: 7,
      },
      {
        id: "release",
        type: "release",
        login: "alice",
        title: "v1.2",
        repositoryId: 7,
      },
      {
        id: "note",
        type: "note",
        login: "alice",
        title: "Private journal",
        repositoryId: 7,
      },
      {
        id: "bot",
        type: "merge",
        login: "renovate[bot]",
        title: "Bot work",
        repositoryId: 7,
      },
      {
        id: "secret",
        type: "merge",
        login: "secret",
        title: "Secret feature",
        repositoryId: 8,
      },
    ];
    for (const item of fixtures) {
      const at = "2026-09-03T10:00:00Z";
      await pool.query(
        "INSERT INTO ship_live_events(organization,event_id,event,occurred_at) VALUES('installation-99',$1,$2,$3)",
        [
          item.id,
          {
            ...item,
            actor: { login: item.login },
            repo: item.repositoryId === 7 ? "acme/api" : "acme/private",
            occurredAt: at,
            url: `https://github.com/acme/api/pull/${item.number ?? 1}`,
            body: "Never include raw body",
          },
          at,
        ],
      );
    }
    for (const [number, state, draft, repositoryId] of [
      [1, "merged", false, 7],
      [2, "open", false, 7],
      [3, "closed", false, 7],
      [4, "open", true, 7],
      [5, "open", false, 8],
    ] as const) {
      await pool.query(
        `INSERT INTO ship_live_wall_signals(installation_id,repository_id,repository,kind,signal_key,observed_at,value) VALUES(99,$1,$2,'pull_request',$3,'2026-09-08T10:00:00Z',$4)`,
        [
          repositoryId,
          repositoryId === 7 ? "acme/api" : "acme/private",
          String(number),
          {
            number,
            state,
            draft,
            title: `PR ${number}`,
            author: "alice",
            url: `https://github.com/acme/api/pull/${number}`,
            headSha: `sha-${number}`,
            createdAt: "2026-09-01T00:00:00Z",
            updatedAt: "2026-09-08T10:00:00Z",
          },
        ],
      );
    }
    const event = webhookEvent({
      id: randomUUID(),
      workspace_id: workspace,
      workspace_name: "Acme",
      type: "digest.weekly",
      payload: {
        occurredAt: "2026-09-07T09:00:00Z",
        summary: "Digest",
        data: { weekStart: "2026-08-31", weekEnd: "2026-09-06" },
      },
    });
    const digest = await withDigest(pool, event, [7], {
      appUrl: "https://ship.example",
      now: Date.parse("2026-09-09T00:00:00Z"),
    });
    assert.deepEqual(
      (digest.data.shipped as { title: string }[])
        .map((item) => item.title)
        .sort(),
      ["Ship search", "v1.2"],
    );
    assert.deepEqual(digest.data.helpfulReviewers, [
      { login: "bob", pullRequests: 1, reviews: 1 },
    ]);
    const attention = digest.data.needsHelp as {
      basis: string;
      items: { number: number; state: string }[];
    };
    assert.equal(attention.basis, "current");
    assert.deepEqual(
      attention.items.map(({ number, state }) => ({ number, state })),
      [{ number: 2, state: "waiting" }],
    );
    const milestone = digest.data.nextMilestone as {
      id: string;
      progress: number;
      target: number;
      remaining: number;
    };
    assert.deepEqual(
      {
        id: milestone.id,
        progress: milestone.progress,
        target: milestone.target,
        remaining: milestone.remaining,
      },
      { id: "team-release", progress: 1, target: 5, remaining: 4 },
    );
    const url = new URL(digest.url!);
    assert.equal(url.origin, "https://ship.example");
    assert.equal(url.searchParams.get("workspace"), workspace);
    assert.equal(url.searchParams.get("scene"), "pulse");
    assert.equal(url.searchParams.get("period"), "custom");
    assert.equal(url.searchParams.get("from"), "2026-08-31");
    assert.equal(url.searchParams.get("to"), "2026-09-06");
    assert.match(String(digest.data.body), /Ship search/);
    assert.match(String(digest.data.body), /Current/);
    assert.ok(
      String(digest.data.body).includes("https://github.com/acme/api/pull/2"),
    );
    assert.equal(
      new URL(
        (digest.data.links as { reviewers: string }).reviewers,
      ).searchParams.get("scene"),
      "leaderboard",
    );
    assert.match(String(digest.data.body), /stored/i);
    for (const secret of [
      "Private journal",
      "Bot work",
      "Secret feature",
      "acme/private",
      "Never include raw body",
    ])
      assert.ok(!JSON.stringify(digest).includes(secret), secret);
    await pool.query(
      "UPDATE ship_live_events SET event=jsonb_set(event,'{title}',to_jsonb($1::text)) WHERE event_id='merge'",
      ["Long <title> ".repeat(400)],
    );
    const long = await withDigest(pool, event, [7], {
      appUrl: "https://ship.example",
      now: Date.parse("2026-09-09T00:00:00Z"),
    });
    assert.ok(
      String(long.data.body).length <= 2800,
      "digest narrative must leave room for caveats and action links",
    );
    const { renderTemplate } = await import("../shared/webhook-template.js");
    const slack = JSON.parse(
      renderTemplate(WEBHOOK_PRESETS.slack.template, long, "json"),
    );
    const detail = slack.blocks[1].text.text;
    assert.ok(detail.length <= 3000);
    assert.ok(detail.includes("missing history"));
    assert.ok(detail.includes("Recent review activity:"));
    const empty = await withDigest(pool, event, [], {
      appUrl: "https://ship.example",
    });
    assert.deepEqual(empty.data.shipped, []);
    assert.deepEqual(empty.data.helpfulReviewers, []);
    assert.deepEqual((empty.data.needsHelp as { items: unknown[] }).items, []);
  });
});

test("digest totals cover every stored weekly event without the old 20,000-row cutoff", async (t) => {
  await withWorkspace(t, async ({ pool, workspace }) => {
    await pool.query(
      "INSERT INTO ship_live_organizations(organization) VALUES ('installation-99')",
    );
    await pool.query(`INSERT INTO ship_live_events(organization,event_id,event,occurred_at)
      SELECT 'installation-99','merge-' || n,jsonb_build_object('id','merge-' || n,'type','merge','actor',jsonb_build_object('login','alice'),'repo','acme/api','repositoryId',7,'title','Ship ' || n,'occurredAt','2026-09-01T10:00:00Z'),'2026-09-01T10:00:00Z'::timestamptz FROM generate_series(1,20001) AS n`);
    const event = webhookEvent({
      id: randomUUID(),
      workspace_id: workspace,
      workspace_name: "Acme",
      type: "digest.weekly",
      payload: {
        occurredAt: "2026-09-07T09:00:00Z",
        summary: "Digest",
        data: { weekStart: "2026-08-31", weekEnd: "2026-09-06" },
      },
    });
    const digest = await withDigest(pool, event, [7]);
    assert.equal((digest.data.totals as { merges: number }).merges, 20001);
    assert.equal((digest.data.shipped as unknown[]).length, 5);
    assert.equal(
      (digest.data.repositories as { merges: number }[])[0].merges,
      20001,
    );
  });
});

test("a prepared digest is no longer authorized when its source scope changes", async (t) => {
  await withWorkspace(t, async ({ pool, workspace }) => {
    const event = webhookEvent({
      id: randomUUID(),
      workspace_id: workspace,
      workspace_name: "Acme",
      type: "digest.weekly",
      payload: {
        occurredAt: "2026-09-07T09:00:00Z",
        summary: "Digest",
        data: { weekStart: "2026-08-31", weekEnd: "2026-09-06" },
      },
    });
    const { prepareDigest } = await import("./digest.js");
    const prepared = await prepareDigest(pool, event, [7]);
    assert.equal(await prepared.authorize(), true);
    await pool.query(
      "UPDATE ship_live_workspaces SET installation_id=100 WHERE id=$1",
      [workspace],
    );
    assert.equal(await prepared.authorize(), false);
  });
});
