import { WebhookStore } from "./webhook-store.js";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Request, Response } from "express";
import { AuthService, AuthError, type Principal } from "./auth.js";
import { createTestDatabase } from "./test-database.js";
import { PostgresEventStore } from "./postgres-store.js";
import { WorkspaceStore } from "./workspace-store.js";
import { DashboardShareStore } from "./share-store.js";
import { createWorkspaceApp } from "./workspace-app.js";
import { PulseStore } from "./pulse-store.js";
import type { GitHubApp } from "./github-app.js";
test("Pulse routes validate ranges, reauthorize aggregates and bind dashboard shares", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const store = await PostgresEventStore.open(url);
  let server:
    ReturnType<ReturnType<typeof createWorkspaceApp>["listen"]> | undefined;
  try {
    const user = { id: randomUUID(), name: "Builder" };
    await store.pool.query(
      "INSERT INTO ship_live_auth_users(id,name) VALUES($1,$2)",
      [user.id, user.name],
    );
    const workspaces = new WorkspaceStore(store.pool, "11".repeat(32));
    await workspaces.saveGrant(
      user.id,
      { id: 1, login: "builder" },
      { accessToken: "synthetic", expiresAt: Date.now() + 3600000 },
    );
    const connection = (await workspaces.connection(user.id))!;
    const installation = {
      id: 70,
      accountId: 700,
      account: "team",
      kind: "Organization" as const,
      suspended: false,
    };
    await workspaces.replaceAccess(
      user.id,
      connection.generation,
      connection.accessVersion,
      [
        {
          ...installation,
          repositories: [{ id: 101, name: "team/a", private: true }],
        },
      ],
    );
    const workspace = await workspaces.connectInstallation(
      user,
      installation,
      1,
      connection.generation,
    );
    let active = true;
    class FixtureAuth extends AuthService {
      override async authenticate(
        _request: Request,
        _response: Response,
      ): Promise<Principal> {
        return { user, sessionId: "synthetic", csrfToken: "synthetic" };
      }
      override async assertActive(_principal: Principal) {
        if (!active) throw new AuthError(401, "Sign in again.");
      }
    }
    const auth = new FixtureAuth(
      { appUrl: "http://localhost:3000" },
      store.pool,
    );
    server = createWorkspaceApp({
      store,
      workspaces,
      auth,
      github: {} as GitHubApp,
      webhooks: new WebhookStore(store.pool),
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const get = (path: string, token?: string) =>
      fetch(`http://127.0.0.1:${address.port}${path}`, {
        headers: token ? { "x-dashboard-share": token } : {},
      });
    const base = `/api/workspaces/${workspace.id}/pulse`;
    await store.merge(
      "installation-70",
      [
        {
          id: "allowed",
          type: "merge",
          actor: { login: "alice" },
          repo: "team/a",
          repositoryId: 101,
          title: "Merged",
          occurredAt: new Date().toISOString(),
        },
        {
          id: "note",
          type: "note",
          actor: { login: "alice" },
          repo: "team/a",
          repositoryId: 101,
          title: "Private",
          body: "secret",
          occurredAt: new Date().toISOString(),
        },
      ],
      { restricted: true },
    );
    await store.pool.query(`INSERT INTO ship_live_repository_sync VALUES
      (70,101,'2026-09-14T09:00:00Z'), (70,999,'2026-09-15T11:00:00Z'),
      (71,101,'2026-09-15T10:00:00Z')`);
    assert.equal((await get(`${base}/overview?period=garbage`)).status, 400);
    assert.equal((await get(`${base}/activity?cursor=garbage`)).status, 400);
    const overview = await get(`${base}/overview`);
    assert.equal(overview.status, 200);
    assert.equal((await overview.json()).totals.count, 1);
    const shares = new DashboardShareStore(store.pool);
    let link = await shares.create(
      user.id,
      workspace,
      connection.generation,
      [101],
      3600,
      false,
    );
    const shared = "/api/shared/pulse";
    assert.equal((await get(`${shared}/overview`)).status, 410);
    const activity = await get(`${shared}/activity`, link.token);
    assert.equal(activity.status, 200);
    assert.equal((await activity.json()).events.length, 1);
    const dashboard = await get(`${base}/dashboard`);
    assert.equal(dashboard.status, 200);
    const dashboardData = await dashboard.json();
    assert.equal(dashboardData.events.length, 1);
    assert.equal(dashboardData.overview.totals.count, 1);
    assert.deepEqual(dashboardData.range, dashboardData.overview.range);
    assert.deepEqual(dashboardData.overview.coverage.sourceSync, {
      lastSyncedAt: "2026-09-14T09:00:00.000Z",
      syncedRepositories: 1,
      totalRepositories: 1,
    });
    assert.ok(
      dashboardData.health,
      "private dashboard includes authorized health",
    );
    const publicDashboard = await get(`${shared}/dashboard`, link.token);
    assert.equal(publicDashboard.status, 200);
    const publicData = await publicDashboard.json();
    assert.equal(publicData.events.length, 1);
    assert.deepEqual(
      publicData.overview.coverage.sourceSync,
      {
        lastSyncedAt: "2026-09-14T09:00:00.000Z",
        syncedRepositories: 1,
        totalRepositories: 1,
      },
      "shared coverage excludes imports outside its pinned repository and installation",
    );
    assert.equal(
      publicData.health,
      undefined,
      "dashboard share cannot disclose health",
    );
    assert.equal((await get(`${shared}/dashboard`)).status, 410);
    const rotated = await shares.create(
      user.id,
      workspace,
      connection.generation,
      [101],
      3600,
      true,
    );
    assert.equal((await get(`${shared}/overview`, link.token)).status, 410);
    await store.pool.query(
      "UPDATE ship_live_dashboard_shares SET expires_at=now()-interval '1 second' WHERE workspace_id=$1",
      [workspace.id],
    );
    assert.equal((await get(`${shared}/activity`, rotated.token)).status, 410);
    link = await shares.create(
      user.id,
      workspace,
      connection.generation,
      [101],
      3600,
      true,
    );
    for (const query of [
      "period=custom&from=2026-02-30&to=2026-03-01",
      "period=custom&from=2026-09-01&to=2026-08-01",
      "period=7d&period=30d",
    ])
      assert.equal((await get(`${base}/overview?${query}`)).status, 400);
    const yearZero = await get(
      `${base}/overview?period=custom&from=0000-01-01&to=0000-01-02`,
    );
    assert.equal(yearZero.status, 400);
    assert.match((await yearZero.json()).error, /valid calendar dates/);
    const originalActivity = PulseStore.prototype.activity;
    try {
      PulseStore.prototype.activity = async function (...args) {
        const result = await originalActivity.apply(this, args);
        active = false;
        return result;
      };
      assert.equal((await get(`${base}/activity`)).status, 401);
      active = true;
      PulseStore.prototype.activity = async function (...args) {
        const result = await originalActivity.apply(this, args);
        await workspaces.dropAccess(user.id, 70, 101);
        return result;
      };
      assert.equal((await get(`${shared}/activity`, link.token)).status, 410);
      const refreshed = (await workspaces.connection(user.id))!;
      await workspaces.replaceAccess(
        user.id,
        refreshed.generation,
        refreshed.accessVersion,
        [
          {
            ...installation,
            repositories: [{ id: 101, name: "team/a", private: true }],
          },
        ],
      );
    } finally {
      active = true;
      PulseStore.prototype.activity = originalActivity;
    }
    // A personal dashboard combines sources and retains all notes in the period.
    const second = {
      ...installation,
      id: 71,
      accountId: 701,
      account: "another",
    };
    const refreshedAccess = (await workspaces.connection(user.id))!;
    await workspaces.replaceAccess(
      user.id,
      refreshedAccess.generation,
      refreshedAccess.accessVersion,
      [
        {
          ...installation,
          repositories: [{ id: 101, name: "team/a", private: true }],
        },
        {
          ...second,
          repositories: [{ id: 202, name: "another/b", private: true }],
        },
      ],
    );
    await workspaces.connectInstallation(
      user,
      second,
      1,
      refreshedAccess.generation,
    );
    const personal = await workspaces.ensurePersonal(user);
    await workspaces.setPersonalSources(user.id, personal.id, {
      installationIds: [70, 71],
      mineOnly: true,
    });
    const at = new Date().toISOString();
    for (const [installationId, repositoryId, repo] of [
      [70, 101, "team/a"],
      [71, 202, "another/b"],
    ] as const)
      await store.merge(
        `installation-${installationId}`,
        ["builder", "someone"].map((login) => ({
          id: `personal-${installationId}-${login}`,
          type: "merge" as const,
          actor: { login },
          repositoryId,
          repo,
          title: "Work",
          occurredAt: at,
        })),
        { restricted: true },
      );
    await store.pool.query(
      `INSERT INTO ship_live_notes(id,workspace_id,user_id,title,body,created_at)
      SELECT gen_random_uuid(),$1,$2,'Journal entry','private body',now() FROM generate_series(1,305)`,
      [personal.id, user.id],
    );
    const personalBase = `/api/workspaces/${personal.id}/pulse`;
    const personalResponse = await get(`${personalBase}/dashboard`);
    assert.equal(personalResponse.status, 200);
    const personalData = await personalResponse.json();
    assert.equal(personalData.overview.totals.count, 2);
    assert.equal(personalData.events.length, 307);
    assert.ok(
      personalData.events.every(
        (event: { actor: { login: string } }) =>
          event.actor.login === "builder",
      ),
    );
    const personalIds: string[] = [];
    let personalCursor: string | undefined;
    do {
      const page = await (
        await get(
          `${personalBase}/activity${personalCursor ? "?cursor=" + personalCursor : ""}`,
        )
      ).json();
      personalIds.push(...page.events.map((event: { id: string }) => event.id));
      personalCursor = page.nextCursor ?? undefined;
    } while (personalCursor);
    assert.equal(personalIds.length, 307);
    assert.equal(new Set(personalIds).size, 307);
    assert.equal(
      (await (await get(`${personalBase}/activity?repo=team%2Fa`)).json())
        .events.length,
      1,
    );
    await store.pool.query(
      `INSERT INTO ship_live_webhook_events(id,workspace_id,type,payload,dedupe_key)
      SELECT gen_random_uuid(),$1,'inbound.monitor',jsonb_build_object('summary','Period alert','occurredAt',now()),'alert-'||n FROM generate_series(1,125) n`,
      [personal.id],
    );
    await store.pool.query(
      `INSERT INTO ship_live_webhook_events(id,workspace_id,type,payload,dedupe_key)
      VALUES(gen_random_uuid(),$1,'inbound.monitor',jsonb_build_object('summary','Old alert','occurredAt',now()-interval '40 days'),'old-alert')`,
      [personal.id],
    );
    const alertsData = await (await get(`${personalBase}/dashboard`)).json();
    assert.equal(
      alertsData.events.filter(
        (event: { type: string }) => event.type === "alert",
      ).length,
      125,
    );
    assert.equal(alertsData.overview.totals.count, 2);
    assert.equal(
      (await (await get(`${base}/dashboard`)).json()).events.filter(
        (event: { type: string }) => event.type === "alert",
      ).length,
      0,
      "alerts stay workspace scoped",
    );
    assert.equal(
      (await (await get(`${personalBase}/overview`)).json()).totals.count,
      2,
    );
    const originalEvents = PulseStore.prototype.events;
    try {
      PulseStore.prototype.events = async function (...args) {
        const result = await originalEvents.apply(this, args);
        await workspaces.setPersonalSources(user.id, personal.id, {
          installationIds: [70, 71],
          mineOnly: false,
        });
        return result;
      };
      assert.equal(
        (await get(`${personalBase}/dashboard`)).status,
        403,
        "author restriction change invalidates the entire snapshot",
      );
      PulseStore.prototype.events = async function (...args) {
        const result = await originalEvents.apply(this, args);
        active = false;
        return result;
      };
      assert.equal(
        (await get(`${base}/dashboard`)).status,
        401,
        "logout during dashboard reads fails closed",
      );
    } finally {
      active = true;
      PulseStore.prototype.events = originalEvents;
    }
    const original = PulseStore.prototype.overview;
    try {
      PulseStore.prototype.overview = async function (...args) {
        const result = await original.apply(this, args);
        await shares.revoke(user.id, workspace.id);
        return result;
      };
      assert.equal((await get(`${shared}/overview`, link.token)).status, 410);
      PulseStore.prototype.overview = async function (...args) {
        const result = await original.apply(this, args);
        await workspaces.dropAccess(user.id, 70, 101);
        return result;
      };
      assert.equal((await get(`${base}/overview`)).status, 403);
    } finally {
      PulseStore.prototype.overview = original;
    }
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await store.close();
  }
});
