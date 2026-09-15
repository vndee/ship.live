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
