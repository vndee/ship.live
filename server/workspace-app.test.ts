import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomUUID,
} from "node:crypto";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import type { Request, Response as ExpressResponse } from "express";
import type { AuthUser } from "../shared/auth.js";
import type { ActivityEvent, FeedResponse } from "../shared/types.js";
import { AuthError, AuthService, type Principal } from "./auth.js";
import { GitHubApp, type InstallationInfo, type Repo } from "./github-app.js";
import { PostgresEventStore } from "./postgres-store.js";
import { createTestDatabase } from "./test-database.js";
import { createWorkspaceApp } from "./workspace-app.js";
import { HealthStore } from "./health-store.js";
import { WorkspaceStore } from "./workspace-store.js";
import { WallStore } from "./wall-store.js";

const APP_URL = "http://localhost:3000";
const SECRET = "synthetic-workspace-webhook-secret";
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const team: InstallationInfo = {
  id: 70,
  accountId: 700,
  account: "team",
  kind: "Organization",
  suspended: false,
};
const otherTeam: InstallationInfo = {
  id: 71,
  accountId: 701,
  account: "other-team",
  kind: "Organization",
  suspended: false,
};
const repoA: Repo = { id: 101, name: "team/alpha", private: true };
const repoB: Repo = { id: 102, name: "team/beta", private: true };

// Only this test fixture supplies principals. Production always uses AuthService's
// Supabase verification, opaque sessions and CSRF checks (covered in auth.test.ts).
class FixtureAuth extends AuthService {
  readonly active = new Set<string>();
  readonly originals = new WeakSet<Principal>();
  users: AuthUser[] = [];
  override async authenticate(
    request: Request,
    _response: ExpressResponse,
  ): Promise<Principal> {
    const user = this.users.find(
      (user) => user.id === request.get("x-test-user"),
    );
    if (!user || !this.active.has(user.id))
      throw new AuthError(401, "Sign in again.");
    const principal = {
      user,
      sessionId:
        request.get("x-test-session") ||
        createHash("sha256").update(`session-${user.id}`).digest("hex"),
      csrfToken: "fixture-csrf",
    };
    this.originals.add(principal);
    return principal;
  }
  override async requireMutation(
    request: Request,
    response: ExpressResponse,
  ): Promise<Principal> {
    const principal = await this.authenticate(request, response);
    if (
      request.get("origin") !== APP_URL ||
      request.get("x-csrf-token") !== principal.csrfToken
    )
      throw new AuthError(403, "Invalid request.");
    return principal;
  }
  override async assertActive(principal: Principal): Promise<void> {
    assert.ok(
      this.originals.has(principal),
      "handlers must retain the original authenticated principal",
    );
    if (!this.active.has(principal.user.id))
      throw new AuthError(401, "Sign in again.");
  }
}

function upstream() {
  const visible = new Map<string, Repo[]>([
    ["token-a", [repoA]],
    ["token-b", [repoB]],
  ]);
  const accessible = new Map<string, InstallationInfo[]>([
    ["token-a", [team]],
    ["token-b", [team]],
  ]);
  const calls: string[] = [];
  const codes = new Map<string, string>();
  let unavailable = false;
  let beforeRepositories: (() => Promise<void>) | undefined;
  let beforeUser: (() => Promise<void>) | undefined;
  const install = (info: InstallationInfo) => ({
    id: info.id,
    app_id: 9,
    account: { id: info.accountId, login: info.account, type: info.kind },
    suspended_at: info.suspended ? new Date().toISOString() : null,
  });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.ok(["api.github.com", "github.com"].includes(url.hostname));
    const token =
      new Headers(init?.headers)
        .get("authorization")
        ?.replace(/^Bearer /, "") || "";
    calls.push(`${url.pathname}:${token.startsWith("token-") ? token : "app"}`);
    if (unavailable)
      return Response.json(
        { error: "synthetic private upstream detail" },
        { status: 503 },
      );
    if (url.pathname === "/login/oauth/access_token") {
      const parameters = new URLSearchParams(String(init?.body));
      const challenge = codes.get(parameters.get("code") || "");
      if (
        !challenge ||
        createHash("sha256")
          .update(parameters.get("code_verifier") || "")
          .digest("base64url") !== challenge
      )
        return Response.json({ error: "bad_verifier" });
      return Response.json({
        access_token: "token-a",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "refresh-a",
        refresh_token_expires_in: 86400,
      });
    }
    if (url.pathname === "/user") {
      const callback = beforeUser;
      beforeUser = undefined;
      await callback?.();
      return Response.json({
        id: token === "token-a" ? 1 : 2,
        login: token === "token-a" ? "builder-a" : "builder-b",
      });
    }
    if (url.pathname === "/user/installations") {
      const installations = (accessible.get(token) || []).map(install);
      return Response.json({
        total_count: installations.length,
        installations,
      });
    }
    if (/^\/user\/installations\/\d+\/repositories$/.test(url.pathname)) {
      const callback = beforeRepositories;
      beforeRepositories = undefined;
      await callback?.();
      const repositories = (visible.get(token) || []).map((repo) => ({
        id: repo.id,
        full_name: repo.name,
        private: repo.private,
      }));
      return Response.json({ total_count: repositories.length, repositories });
    }
    if (url.pathname === `/app/installations/${team.id}`)
      return Response.json(install(team));
    if (url.pathname.endsWith("/access_tokens"))
      return Response.json({
        token: "installation-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    if (url.pathname.startsWith("/repos/")) return Response.json([]);
    return Response.json({ error: "unknown" }, { status: 404 });
  };
  const github = new GitHubApp(
    {
      appId: "9",
      clientId: "app-client",
      clientSecret: "synthetic-client-secret",
      privateKey,
      slug: "ship-live-test",
      appUrl: APP_URL,
    },
    fetcher,
  );
  return {
    github,
    visible,
    accessible,
    calls,
    codes,
    unavailable: () => {
      unavailable = true;
    },
    beforeRepositories: (callback: () => Promise<void>) => {
      beforeRepositories = callback;
    },
    beforeUser: (callback: () => Promise<void>) => {
      beforeUser = callback;
    },
  };
}

async function withApp(
  t: TestContext,
  run: (fixture: {
    store: PostgresEventStore;
    workspaces: WorkspaceStore;
    auth: FixtureAuth;
    users: AuthUser[];
    provider: ReturnType<typeof upstream>;
    request: (
      path: string,
      user?: AuthUser | null,
      init?: RequestInit,
    ) => Promise<Response>;
  }) => Promise<void>,
) {
  const database = await createTestDatabase(t);
  if (!database) return;
  const store = await PostgresEventStore.open(database);
  const replica = await PostgresEventStore.open(database);
  let server:
    ReturnType<ReturnType<typeof createWorkspaceApp>["listen"]> | undefined;
  try {
    const users = [
      { id: randomUUID(), name: "Builder A" },
      { id: randomUUID(), name: "Builder B" },
    ];
    for (const user of users) {
      await store.pool.query(
        "INSERT INTO ship_live_auth_users(id,name) VALUES($1,$2)",
        [user.id, user.name],
      );
      await store.pool.query(
        "INSERT INTO ship_live_auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
        [
          createHash("sha256").update(`session-${user.id}`).digest("hex"),
          user.id,
        ],
      );
    }
    const workspaces = new WorkspaceStore(store.pool, "11".repeat(32));
    const auth = new FixtureAuth({ appUrl: APP_URL }, store.pool);
    auth.users = users;
    users.forEach((user) => auth.active.add(user.id));
    const provider = upstream();
    server = createWorkspaceApp({
      store: replica,
      workspaces,
      auth,
      github: provider.github,
      webhookSecret: SECRET,
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const request = (
      path: string,
      user: AuthUser | null = users[0],
      init: RequestInit = {},
    ) => {
      const headers = new Headers({
        "content-type": "application/json",
        origin: APP_URL,
        "x-csrf-token": "fixture-csrf",
        ...(user ? { "x-test-user": user.id } : {}),
      });
      new Headers(init.headers).forEach((value, key) =>
        headers.set(key, value),
      );
      return fetch(`http://127.0.0.1:${address.port}${path}`, {
        ...init,
        headers,
        signal: init.signal || AbortSignal.timeout(4000),
      });
    };
    await run({ store, workspaces, auth, users, provider, request });
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await replica.close();
    await store.close();
  }
}

async function connect(
  workspaces: WorkspaceStore,
  user: AuthUser,
  index: number,
  installation: InstallationInfo = team,
) {
  await workspaces.saveGrant(
    user.id,
    { id: index, login: `builder-${index}` },
    {
      accessToken: index === 1 ? "token-a" : "token-b",
      expiresAt: Date.now() + 3600000,
    },
  );
  return workspaces.connectInstallation(
    user,
    installation,
    index,
    (await workspaces.connection(user.id))!.generation,
  );
}
function event(id: string, repositoryId?: number): ActivityEvent {
  return {
    id,
    type: "merge",
    actor: { login: "builder" },
    repo: "team/alpha",
    title: id,
    occurredAt: new Date().toISOString(),
    ...(repositoryId ? { repositoryId } : {}),
  };
}

test("dashboard shares expose only the creator's pinned repositories and never notes", async (t) => {
  await withApp(t, async ({ store, workspaces, users, provider, request }) => {
    const workspace = await connect(workspaces, users[0], 1);
    await store.merge("installation-70", [
      event("allowed", 101),
      event("other-repo", 102),
      event("missing-repo"),
      { ...event("private-note", 101), type: "note", body: "private journal" },
    ]);
    const wall = new WallStore(store.pool);
    for (const repository of [repoA, repoB])
      await wall.apply(70, repository.id, repository.name, randomUUID(), [
        {
          kind: "pipeline",
          observedAt: "2026-09-10T12:00:00Z",
          value: {
            id: `check:${repository.id}`,
            name: "CI",
            provider: "github-actions",
            headSha: "a".repeat(40),
            status: "passing",
            updatedAt: "2026-09-10T12:00:00Z",
          },
        },
      ]);
    const created = await request(
      `/api/workspaces/${workspace.id}/share`,
      users[0],
      {
        method: "POST",
        body: JSON.stringify({ expiresIn: 86400 }),
      },
    );
    assert.equal(created.status, 201);
    const link = await created.json();
    assert.match(link.token, /^[A-Za-z0-9_-]{43}$/);
    const read = () =>
      request("/api/shared/feed", null, {
        headers: { "x-dashboard-share": link.token },
      });
    const response = await read();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") || "", /no-store/);
    const shared = await response.json();
    assert.deepEqual(
      shared.events.map((e: ActivityEvent) => e.id),
      ["allowed"],
    );
    assert.deepEqual(
      shared.wall.repositories.map(
        (repository: { repositoryId: number }) => repository.repositoryId,
      ),
      [101],
    );
    // New permission grants must not silently widen an already distributed link.
    provider.visible.set("token-a", [repoA, repoB]);
    assert.deepEqual(
      (await (await read()).json()).events.map((e: ActivityEvent) => e.id),
      ["allowed"],
    );
    provider.visible.set("token-a", [repoB]);
    assert.deepEqual((await (await read()).json()).events, []);
    const row = (
      await store.pool.query("SELECT * FROM ship_live_dashboard_shares")
    ).rows[0];
    assert.equal(
      row.token_hash,
      createHash("sha256").update(link.token).digest("hex"),
    );
    assert.ok(!JSON.stringify(row).includes(link.token));
  });
});

test("share creation and management require membership, CSRF, and creator ownership", async (t) => {
  await withApp(t, async ({ workspaces, users, request }) => {
    const workspace = await connect(workspaces, users[0], 1);
    const path = `/api/workspaces/${workspace.id}/share`;
    const post = {
      method: "POST",
      body: JSON.stringify({ expiresIn: 3_155_760_000 }),
    };
    assert.equal((await request(path, null, post)).status, 401);
    assert.equal((await request(path, users[1], post)).status, 404);
    assert.equal(
      (
        await request(path, users[0], {
          ...post,
          headers: { "x-csrf-token": "bad" },
        })
      ).status,
      403,
    );
    for (const expiresIn of [0, -1, "86400", 2592001, null]) {
      assert.equal(
        (
          await request(path, users[0], {
            method: "POST",
            body: JSON.stringify({ expiresIn }),
          })
        ).status,
        400,
      );
    }
    const link = await (await request(path, users[0], post)).json();
    assert.ok(
      Date.parse(link.expiresAt) > Date.now() + 99 * 365 * 86_400_000,
      "the no-expiration option must persist a roughly 100-year expiry",
    );
    assert.equal((await request(path, users[0], post)).status, 409);
    await connect(workspaces, users[1], 2);
    assert.equal((await (await request(path, users[1])).json()).share, null);
    await request(path, users[1], { method: "DELETE" });
    assert.equal(
      (
        await request("/api/shared/feed", null, {
          headers: { "x-dashboard-share": link.token },
        })
      ).status,
      200,
    );
    const personal = await workspaces.ensurePersonal(users[0]);
    assert.equal(
      (await request(`/api/workspaces/${personal.id}/share`, users[0], post))
        .status,
      400,
    );
  });
});

test("rotating, revoking, and expiring a share invalidates its bearer token", async (t) => {
  await withApp(t, async ({ store, workspaces, users, request }) => {
    const workspace = await connect(workspaces, users[0], 1);
    const path = `/api/workspaces/${workspace.id}/share`;
    const post = { method: "POST", body: JSON.stringify({ expiresIn: 3600 }) };
    const old = await (await request(path, users[0], post)).json();
    const rotated = await request(`${path}/rotate`, users[0], post);
    assert.equal(rotated.status, 200);
    const next = await rotated.json();
    assert.notEqual(next.token, old.token);
    const read = (token: string) =>
      request("/api/shared/feed", null, {
        headers: { "x-dashboard-share": token },
      });
    assert.equal((await read(old.token)).status, 410);
    assert.equal((await read(next.token)).status, 200);
    await store.pool.query(
      "UPDATE ship_live_dashboard_shares SET expires_at=now()-interval '1 second'",
    );
    assert.equal((await read(next.token)).status, 410);
    const fresh = await (await request(path, users[0], post)).json();
    assert.equal(
      (await request(path, users[0], { method: "DELETE" })).status,
      204,
    );
    assert.equal((await read(fresh.token)).status, 410);
    assert.equal((await read("invalid")).status, 410);
    assert.equal((await request("/api/shared/feed", null)).status, 410);
  });
});

test("shared feed fails closed on disconnect and concurrent rotation during GitHub checks", async (t) => {
  await withApp(t, async ({ workspaces, users, provider, request }) => {
    const workspace = await connect(workspaces, users[0], 1);
    const path = `/api/workspaces/${workspace.id}/share`;
    const post = { method: "POST", body: JSON.stringify({ expiresIn: 3600 }) };
    const link = await (await request(path, users[0], post)).json();
    provider.beforeRepositories(async () => {
      await request(`${path}/rotate`, users[0], post);
    });
    assert.equal(
      (
        await request("/api/shared/feed", null, {
          headers: { "x-dashboard-share": link.token },
        })
      ).status,
      410,
    );
    const next = await (await request(`${path}/rotate`, users[0], post)).json();
    await workspaces.disconnect(users[0].id);
    assert.equal(
      (
        await request("/api/shared/feed", null, {
          headers: { "x-dashboard-share": next.token },
        })
      ).status,
      410,
    );
  });
});

test("an open shared stream receives revocation when another replica rotates its link", async (t) => {
  await withApp(t, async ({ workspaces, users, request }) => {
    const workspace = await connect(workspaces, users[0], 1);
    const path = `/api/workspaces/${workspace.id}/share`;
    const post = { method: "POST", body: JSON.stringify({ expiresIn: 3600 }) };
    const link = await (await request(path, users[0], post)).json();
    const controller = new AbortController();
    const response = await request("/api/shared/events", null, {
      signal: controller.signal,
      headers: { "x-dashboard-share": link.token },
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      await reader.read();
      await request(`${path}/rotate`, users[0], post);
      let text = "";
      while (!text.includes("access-revoked")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      assert.match(text, /event: access-revoked/);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  });
});
function delivery(payload: unknown, id: string = randomUUID()): RequestInit {
  const body = JSON.stringify(payload);
  return {
    method: "POST",
    body,
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": id,
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
    },
  };
}
function mergePayload(installationId = 70, ownerId = 700) {
  return {
    action: "closed",
    installation: { id: installationId },
    repository: {
      id: 101,
      full_name: "team/alpha",
      owner: { id: ownerId, login: "team" },
      private: true,
    },
    pull_request: {
      number: 7,
      title: "A private improvement",
      user: { login: "builder-a" },
      merged: true,
      merged_at: new Date().toISOString(),
      html_url: "https://github.com/team/alpha/pull/7",
    },
  };
}

test("concurrent share rotations leave exactly one usable token", async (t) => {
  await withApp(t, async ({ workspaces, users, request }) => {
    const workspace = await connect(workspaces, users[0], 1);
    const path = `/api/workspaces/${workspace.id}/share`;
    const post = { method: "POST", body: JSON.stringify({ expiresIn: 3600 }) };
    assert.equal((await request(path, users[0], post)).status, 201);
    const responses = await Promise.all([
      request(`${path}/rotate`, users[0], post),
      request(`${path}/rotate`, users[0], post),
    ]);
    const tokens = await Promise.all(
      responses.map(async (response) => {
        assert.equal(response.status, 200);
        return (await response.json()).token as string;
      }),
    );
    const statuses = await Promise.all(
      tokens.map(
        async (token) =>
          (
            await request("/api/shared/feed", null, {
              headers: { "x-dashboard-share": token },
            })
          ).status,
      ),
    );
    assert.deepEqual(statuses.sort(), [200, 410]);
  });
});

test("shared streams expire even without new activity or a revocation notification", async (t) => {
  await withApp(t, async ({ store, workspaces, users, request }) => {
    const workspace = await connect(workspaces, users[0], 1);
    const created = await request(
      `/api/workspaces/${workspace.id}/share`,
      users[0],
      { method: "POST", body: JSON.stringify({ expiresIn: 3600 }) },
    );
    assert.equal(created.status, 201);
    const { token } = await created.json();
    await store.pool.query(
      "UPDATE ship_live_dashboard_shares SET expires_at=now()+interval '1 second'",
    );
    const controller = new AbortController();
    const response = await request("/api/shared/events", null, {
      headers: { "x-dashboard-share": token },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      assert.match(await response.text(), /event: access-revoked/);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  });
});

test("shared feeds never return cached private activity when GitHub access cannot be verified", async (t) => {
  await withApp(t, async ({ store, workspaces, users, provider, request }) => {
    const workspace = await connect(workspaces, users[0], 1);
    await store.merge("installation-70", [event("private", 101)]);
    const created = await request(
      `/api/workspaces/${workspace.id}/share`,
      users[0],
      { method: "POST", body: JSON.stringify({ expiresIn: 3600 }) },
    );
    assert.equal(created.status, 201);
    const { token } = await created.json();
    provider.unavailable();
    const response = await request("/api/shared/feed", null, {
      headers: { "x-dashboard-share": token },
    });
    assert.equal(response.status, 410);
    assert.equal((await response.json()).events, undefined);
  });
});

test("workspace HTTP routes keep notes owner-only, enforce mutation checks and remove legacy public/key routes", async (t) => {
  await withApp(t, async ({ request, users }) => {
    const response = await request("/api/workspaces");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const { workspaces } = await response.json();
    const journal = workspaces[0];
    const created = await request(
      `/api/workspaces/${journal.id}/notes`,
      users[0],
      {
        method: "POST",
        body: JSON.stringify({
          title: "Shipped a prototype",
          body: "My private reflection",
        }),
      },
    );
    assert.equal(created.status, 201);
    const note = await created.json();
    assert.equal(note.type, "note");
    assert.equal(
      (await request(`/api/workspaces/${journal.id}/feed`, users[1])).status,
      404,
    );
    assert.equal(
      (
        await request(
          `/api/workspaces/${journal.id}/notes/${note.id}`,
          users[1],
          { method: "DELETE" },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await request(`/api/workspaces/${journal.id}/notes`, users[0], {
          method: "POST",
          headers: { "x-csrf-token": "wrong" },
          body: '{"title":"blocked","body":""}',
        })
      ).status,
      403,
    );
    const feed: FeedResponse = await (
      await request(`/api/workspaces/${journal.id}/feed`)
    ).json();
    assert.deepEqual(
      feed.events.map((item) => item.id),
      [note.id],
    );
    assert.equal(feed.source, "workspace");
    assert.equal(
      (
        await request(
          `/api/workspaces/${journal.id}/notes/${note.id}`,
          users[0],
          { method: "DELETE" },
        )
      ).status,
      204,
    );
    assert.equal((await request("/api/workspaces", null)).status, 401);
    for (const route of ["/api/feed?org=team", "/api/events?org=team"])
      assert.equal(
        (
          await request(route, null, {
            headers: { "x-dashboard-key": "anything" },
          })
        ).status,
        404,
      );
    assert.deepEqual(await (await request("/api/health", null)).json(), {
      status: "ok",
    });
  });
});

test("health probes do not consume the authenticated request-rate budget", async (t) => {
  await withApp(t, async ({ request }) => {
    for (let index = 0; index < 125; index++) {
      const response = await request("/api/health", null);
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }
    assert.equal((await request("/api/workspaces")).status, 200);
  });
});

test("feed verifies the session after each permission read without redundant entry checks", async (t) => {
  await withApp(t, async ({ workspaces, store, auth, users, request }) => {
    const workspace = await connect(workspaces, users[0], 1);
    await store.merge("installation-70", [event("alpha", 101)], {
      restricted: true,
    });
    let checks = 0;
    const verify = auth.assertActive.bind(auth);
    auth.assertActive = async (principal) => {
      checks++;
      await verify(principal);
    };
    const response = await request(`/api/workspaces/${workspace.id}/feed`);
    assert.equal(response.status, 200);
    assert.deepEqual(
      (await response.json()).events.map((item: ActivityEvent) => item.id),
      ["alpha"],
    );
    assert.equal(checks, 2);
  });
});

test("each viewer gets a fresh immutable repository intersection, including access changes during a feed read", async (t) => {
  await withApp(t, async ({ store, workspaces, users, provider, request }) => {
    const workspace = await connect(workspaces, users[0], 1);
    await connect(workspaces, users[1], 2);
    await store.merge(
      "installation-70",
      [
        event("alpha", 101),
        event("beta-with-alpha-name", 102),
        event("legacy-without-id"),
      ],
      { restricted: true },
    );
    const feed = async (user: AuthUser) =>
      (await (
        await request(`/api/workspaces/${workspace.id}/feed`, user)
      ).json()) as FeedResponse;
    assert.deepEqual(
      (await feed(users[0])).events.map((item) => item.id),
      ["alpha"],
    );
    assert.deepEqual(
      (await feed(users[1])).events.map((item) => item.id),
      ["beta-with-alpha-name"],
    );
    const read = workspaces.feed.bind(workspaces);
    workspaces.feed = async (...args) => {
      const result = await read(...args);
      provider.visible.set("token-a", []);
      return result;
    };
    assert.deepEqual((await feed(users[0])).events, []);
    provider.unavailable();
    const denied = await request(
      `/api/workspaces/${workspace.id}/feed`,
      users[1],
    );
    assert.equal(denied.status, 403);
    assert.doesNotMatch(
      await denied.text(),
      /beta-with-alpha-name|synthetic private/,
    );
  });
});

test("disconnect and logout during the final authorization read cannot release saved activity or notes", async (t) => {
  await withApp(
    t,
    async ({ workspaces, store, auth, users, provider, request }) => {
      const workspace = await connect(workspaces, users[0], 1);
      await store.merge("installation-70", [event("must-stay-private", 101)], {
        restricted: true,
      });
      const read = workspaces.feed.bind(workspaces);
      workspaces.feed = async (...args) => {
        const result = await read(...args);
        provider.beforeRepositories(() => workspaces.disconnect(users[0].id));
        return result;
      };
      const denied = await request(`/api/workspaces/${workspace.id}/feed`);
      assert.ok([403, 404].includes(denied.status));
      assert.doesNotMatch(await denied.text(), /must-stay-private/);
      workspaces.feed = read;
      const journal = await workspaces.ensurePersonal(users[0]);
      await workspaces.addNote(users[0], journal.id, {
        title: "A private note",
        body: "",
      });
      let finalRead = false;
      const get = workspaces.get.bind(workspaces);
      workspaces.get = async (...args) => {
        const result = await get(...args);
        if (finalRead) auth.active.delete(users[0].id);
        return result;
      };
      workspaces.feed = async (...args) => {
        const result = await read(...args);
        finalRead = true;
        return result;
      };
      const loggedOut = await request(`/api/workspaces/${journal.id}/feed`);
      assert.equal(loggedOut.status, 401);
      assert.doesNotMatch(await loggedOut.text(), /A private note/);
    },
  );
});

test("workspace discovery hides revoked teams and personal journals retain only notes during GitHub outages", async (t) => {
  await withApp(t, async ({ workspaces, store, users, provider, request }) => {
    const workspace = await connect(workspaces, users[0], 1);
    const before = await (await request("/api/workspaces")).json();
    assert.ok(
      before.workspaces.some(
        (item: { id: string }) => item.id === workspace.id,
      ),
    );
    provider.accessible.set("token-a", []);
    const removed = await (await request("/api/workspaces")).json();
    assert.deepEqual(
      removed.workspaces.map((item: { kind: string }) => item.kind),
      ["personal"],
    );
    const personal: InstallationInfo = {
      id: 71,
      accountId: 1,
      account: "builder-a",
      kind: "User",
      suspended: false,
    };
    const journal = await workspaces.connectInstallation(
      users[0],
      personal,
      1,
      (await workspaces.connection(users[0].id))!.generation,
    );
    const note = await workspaces.addNote(users[0], journal.id, {
      title: "An offline reflection",
      body: "Still private",
    });
    await store.merge(
      "installation-71",
      [event("must-not-escape-outage", 101)],
      { restricted: true },
    );
    provider.accessible.set("token-a", [personal]);
    const live = await stream(
      await request(`/api/workspaces/${journal.id}/events`),
    );
    try {
      await live.frame("connected");
      provider.unavailable();
      await store.merge(
        "installation-71",
        [event("new-event-after-outage", 101)],
        { restricted: true, deliveryId: randomUUID() },
      );
      await live.frame("refresh");
      const response = await request(`/api/workspaces/${journal.id}/feed`);
      assert.equal(response.status, 200);
      const feed = await response.json();
      assert.deepEqual(
        feed.events.map((item: ActivityEvent) => item.id),
        [note.id],
      );
      assert.match(feed.notice, /notes only/i);
      const listed = await (await request("/api/workspaces")).json();
      assert.deepEqual(
        listed.workspaces.map((item: { kind: string }) => item.kind),
        ["personal"],
      );
    } finally {
      await live.close();
    }
  });
});

test("GitHub installation metadata and connection requests cannot outlive a disconnect", async (t) => {
  await withApp(t, async ({ workspaces, users, provider, request }) => {
    await connect(workspaces, users[0], 1);
    provider.beforeRepositories(() => workspaces.disconnect(users[0].id));
    const listed = await request("/api/github/installations");
    assert.ok([401, 403].includes(listed.status));
    assert.doesNotMatch(await listed.text(), /team\/alpha/);
    await connect(workspaces, users[0], 1);
    provider.beforeRepositories(() => workspaces.disconnect(users[0].id));
    const connected = await request(
      "/api/github/installations/70/connect",
      users[0],
      { method: "POST" },
    );
    assert.ok([401, 403, 409].includes(connected.status));
    assert.equal(
      (await workspaces.list(users[0].id)).some((item) => item.kind === "team"),
      false,
    );
  });
});

test("an OAuth callback already in flight cannot recreate a disconnected GitHub connection", async (t) => {
  await withApp(t, async ({ workspaces, users, provider, request }) => {
    const started = await (
      await request("/api/github/connect", users[0], { method: "POST" })
    ).json();
    const url = new URL(started.url);
    provider.codes.set("race-code", url.searchParams.get("code_challenge")!);
    provider.beforeUser(() => workspaces.disconnect(users[0].id));
    const callback = await request(
      `/api/github/callback?state=${url.searchParams.get("state")}&code=race-code`,
      users[0],
      { redirect: "manual" },
    );
    assert.ok([400, 401, 403, 409].includes(callback.status));
    assert.equal(await workspaces.connection(users[0].id), undefined);
  });
});

test("installation connection proves user access and sync processes every selected repository", async (t) => {
  await withApp(t, async ({ workspaces, users, provider, request }) => {
    await workspaces.saveGrant(
      users[0].id,
      { id: 1, login: "builder-a" },
      { accessToken: "token-a", expiresAt: Date.now() + 3600000 },
    );
    assert.equal(
      (
        await request("/api/github/installations/999/connect", users[0], {
          method: "POST",
        })
      ).status,
      403,
    );
    assert.equal(
      (await workspaces.list(users[0].id)).filter(
        (item) => item.kind === "team",
      ).length,
      0,
    );
    const batches: number[][] = [];
    provider.github.backfill = async (_installation, repositories) => {
      batches.push(repositories.map((repo) => repo.id));
      return { synced: 0, notice: "Partial historical coverage." };
    };
    provider.visible.set(
      "token-a",
      Array.from({ length: 21 }, (_, index) => ({
        id: 101 + index,
        name: `team/repo-${index}`,
        private: true,
      })),
    );
    const connected = await request(
      "/api/github/installations/70/connect",
      users[0],
      { method: "POST" },
    );
    assert.equal(connected.status, 200);
    const { workspace } = await connected.json();
    assert.deepEqual(
      batches.map((batch) => batch.length),
      [20, 1],
    );
    batches.length = 0;
    assert.equal(
      (
        await request(`/api/workspaces/${workspace.id}/sync`, users[0], {
          method: "POST",
        })
      ).status,
      200,
    );
    assert.deepEqual(
      batches.flat(),
      Array.from({ length: 21 }, (_, index) => 101 + index),
    );
    provider.accessible.set("token-a", []);
    assert.equal(
      (
        await request(`/api/workspaces/${workspace.id}/sync`, users[0], {
          method: "POST",
        })
      ).status,
      403,
    );
  });
});

test("GitHub callback state is one-use and bound to the authenticated user and original session", async (t) => {
  await withApp(t, async ({ workspaces, users, provider, request }) => {
    const started = await (
      await request("/api/github/connect", users[0], { method: "POST" })
    ).json();
    const url = new URL(started.url);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    provider.codes.set("good-code", url.searchParams.get("code_challenge")!);
    const callback = `/api/github/callback?state=${url.searchParams.get("state")}&code=good-code`;
    assert.equal(
      (await request(callback, users[1], { redirect: "manual" })).status,
      400,
    );
    assert.equal(
      (
        await request(callback, users[0], {
          redirect: "manual",
          headers: { "x-test-session": "different-session" },
        })
      ).status,
      400,
    );
    const connected = await request(callback, users[0], { redirect: "manual" });
    assert.equal(connected.status, 302);
    assert.equal(
      connected.headers.get("location"),
      `${APP_URL}/?github=connected`,
    );
    assert.equal((await workspaces.connection(users[0].id))?.githubUserId, 1);
    assert.equal(
      (await request(callback, users[0], { redirect: "manual" })).status,
      400,
    );
  });
});

test("signed webhooks ingest only known active installation repositories and preserve durable delivery deduplication", async (t) => {
  await withApp(t, async ({ workspaces, store, users, request }) => {
    const post = (payload: unknown, id?: string) =>
      request("/api/webhooks/github", null, delivery(payload, id));
    assert.equal((await post(mergePayload(999))).status, 202);
    const workspace = await connect(workspaces, users[0], 1);
    assert.equal((await post(mergePayload(70, 999))).status, 202);
    assert.deepEqual(await store.list("installation-70"), []);
    const payload = mergePayload();
    const id = randomUUID();
    assert.equal((await post(payload, id)).status, 202);
    assert.equal((await post(payload, id)).status, 202);
    const saved = await store.list("installation-70");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].repositoryId, 101);
    const check = delivery(
      {
        installation: { id: 70 },
        repository: {
          id: 101,
          full_name: "team/alpha",
          owner: { id: 700, login: "team" },
        },
        check_run: {
          id: 44,
          name: "CI",
          head_sha: "a".repeat(40),
          status: "completed",
          conclusion: "success",
          completed_at: "2026-09-10T12:00:00Z",
          details_url: "https://github.com/team/alpha/actions/runs/44",
          app: { slug: "github-actions" },
        },
      },
      randomUUID(),
    );
    (check.headers as Record<string, string>)["x-github-event"] = "check_run";
    assert.equal(
      (await request("/api/webhooks/github", null, check)).status,
      202,
    );
    assert.equal(
      (await request("/api/webhooks/github", null, check)).status,
      202,
    );
    const wall = await (
      await request(`/api/workspaces/${workspace.id}/wall`, users[0])
    ).json();
    assert.deepEqual(
      wall.repositories.flatMap(
        (repository: { pipelines: Array<{ status: string }> }) =>
          repository.pipelines.map((pipeline) => pipeline.status),
      ),
      ["passing"],
    );
    const forged = delivery(payload);
    (forged.headers as Record<string, string>)["x-hub-signature-256"] =
      `sha256=${"0".repeat(64)}`;
    assert.equal(
      (await request("/api/webhooks/github", null, forged)).status,
      401,
    );
    const suspend = delivery({ action: "suspend", installation: { id: 70 } });
    (suspend.headers as Record<string, string>)["x-github-event"] =
      "installation";
    assert.equal(
      (await request("/api/webhooks/github", null, suspend)).status,
      202,
    );
    assert.equal(await workspaces.installationActive(70), false);
    assert.equal((await post(mergePayload())).status, 202);
    assert.equal((await store.list("installation-70")).length, 1);
    const unsuspend = delivery({
      action: "unsuspend",
      installation: { id: 70 },
    });
    (unsuspend.headers as Record<string, string>)["x-github-event"] =
      "installation";
    assert.equal(
      (await request("/api/webhooks/github", null, unsuspend)).status,
      202,
    );
    assert.equal(await workspaces.installationActive(70), true);
    assert.equal(
      (await request("/api/webhooks/github", null, suspend)).status,
      202,
    );
    assert.equal(
      await workspaces.installationActive(70),
      true,
      "a duplicate old suspension must not undo a later unsuspension",
    );
  });
});

test("personal GitHub installations accept signed User-owner payloads and revoke the linked account atomically", async (t) => {
  await withApp(t, async ({ workspaces, store, users, request }) => {
    await workspaces.saveGrant(
      users[0].id,
      { id: 1, login: "builder-a" },
      { accessToken: "token-a", expiresAt: Date.now() + 3600000 },
    );
    await workspaces.connectInstallation(
      users[0],
      {
        id: 71,
        accountId: 1,
        account: "builder-a",
        kind: "User",
        suspended: false,
      },
      1,
      (await workspaces.connection(users[0].id))!.generation,
    );
    const payload = mergePayload(71, 1);
    payload.repository.full_name = "builder-a/project";
    payload.repository.owner.login = "builder-a";
    payload.pull_request.html_url =
      "https://github.com/builder-a/project/pull/7";
    assert.equal(
      (await request("/api/webhooks/github", null, delivery(payload))).status,
      202,
    );
    assert.equal((await store.list("installation-71"))[0].repositoryId, 101);
    assert.deepEqual(await store.list("installation-70"), []);
    const revoked = delivery({ action: "revoked", sender: { id: 1 } });
    (revoked.headers as Record<string, string>)["x-github-event"] =
      "github_app_authorization";
    assert.equal(
      (await request("/api/webhooks/github", null, revoked)).status,
      202,
    );
    assert.equal(await workspaces.connection(users[0].id), undefined);
    await workspaces.saveGrant(
      users[0].id,
      { id: 1, login: "builder-a" },
      { accessToken: "new-grant", expiresAt: Date.now() + 3600000 },
    );
    assert.equal(
      (await request("/api/webhooks/github", null, revoked)).status,
      202,
    );
    assert.equal(
      (await workspaces.connection(users[0].id))?.githubUserId,
      1,
      "redelivery cannot revoke a newly connected grant",
    );
  });
});

async function stream(response: Response) {
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  let buffer = "";
  return {
    async frame(kind: string) {
      const timeout = setTimeout(() => {
        void reader.cancel("Stream test timed out");
      }, 3000);
      try {
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (frame.includes(`event: ${kind}\n`)) return frame;
            continue;
          }
          const next = await reader.read();
          assert.equal(next.done, false, `Stream ended before ${kind}`);
          buffer += new TextDecoder().decode(next.value);
        }
      } finally {
        clearTimeout(timeout);
      }
    },
    close: () => reader.cancel(),
  };
}

test("SSE checks cross-instance notifications against current repository access and closes on session revocation", async (t) => {
  await withApp(
    t,
    async ({ workspaces, store, auth, users, provider, request }) => {
      const workspace = await connect(workspaces, users[0], 1);
      const live = await stream(
        await request(`/api/workspaces/${workspace.id}/events`),
      );
      try {
        await live.frame("connected");
        await store.merge("installation-70", [event("hidden-beta", 102)], {
          restricted: true,
          deliveryId: randomUUID(),
        });
        await store.merge("installation-70", [event("visible-alpha", 101)], {
          restricted: true,
          deliveryId: randomUUID(),
        });
        const frame = await live.frame("activity");
        assert.match(frame, /visible-alpha/);
        assert.doesNotMatch(frame, /hidden-beta/);
        provider.visible.set("token-a", []);
        await workspaces.notifyInstallation(70);
        await live.frame("refresh");
        auth.active.delete(users[0].id);
        await workspaces.notifyInstallation(70);
        await live.frame("access-revoked");
      } finally {
        await live.close();
      }
    },
  );
});

test("SSE closes when the user's installation grant disappears and notes emit refresh frames", async (t) => {
  await withApp(t, async ({ workspaces, users, provider, request }) => {
    const journal = await workspaces.ensurePersonal(users[0]);
    const journalLive = await stream(
      await request(`/api/workspaces/${journal.id}/events`),
    );
    try {
      await journalLive.frame("connected");
      const note = await workspaces.addNote(users[0], journal.id, {
        title: "A milestone",
        body: "",
      });
      await journalLive.frame("refresh");
      await workspaces.deleteNote(users[0].id, journal.id, note.id);
      await journalLive.frame("refresh");
    } finally {
      await journalLive.close();
    }
    const workspace = await connect(workspaces, users[0], 1);
    const live = await stream(
      await request(`/api/workspaces/${workspace.id}/events`),
    );
    try {
      await live.frame("connected");
      provider.accessible.set("token-a", []);
      await workspaces.notifyInstallation(70);
      await live.frame("access-revoked");
    } finally {
      await live.close();
    }
  });
});

test("team health UI routes enforce access and CSRF, validate public probes and stream updates", async (t) => {
  await withApp(t, async ({ workspaces, auth, users, provider, request }) => {
    const workspace = await connect(workspaces, users[0], 1);
    const base = `/api/workspaces/${workspace.id}/health`;
    assert.equal((await request(base, null)).status, 401);
    assert.equal((await request(base, users[1])).status, 404);
    const rejected = await request(`${base}/services`, users[0], {
      method: "POST",
      headers: { "x-csrf-token": "invalid" },
      body: JSON.stringify({ name: "API" }),
    });
    assert.equal(rejected.status, 403);
    const mutate = (path: string, method: string, body?: unknown) =>
      request(`${base}${path}`, users[0], {
        method,
        headers: { "x-csrf-token": "fixture-csrf" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const created = await mutate("/services", "POST", { name: "Platform API" });
    assert.equal(created.status, 201);
    const service = (await created.json()) as { id: string };
    const another = await (
      await mutate("/services", "POST", { name: "Worker" })
    ).json();
    assert.equal(
      (
        await mutate("/services/order", "PUT", {
          serviceIds: [another.id, service.id],
        })
      ).status,
      204,
    );
    assert.deepEqual(
      (await (await request(base)).json()).services.map(
        (item: { id: string }) => item.id,
      ),
      [another.id, service.id],
    );
    assert.equal(
      (
        await mutate("/services/order", "PUT", {
          serviceIds: [service.id, service.id],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(`${base}/services/order`, users[0], {
          method: "PUT",
          headers: { "x-csrf-token": "invalid" },
          body: JSON.stringify({ serviceIds: [service.id, another.id] }),
        })
      ).status,
      403,
    );
    provider.accessible.set("token-a", [team, otherTeam]);
    const otherWorkspace = await connect(workspaces, users[0], 1, otherTeam);
    assert.notEqual(otherWorkspace.id, workspace.id);
    const otherBase = `/api/workspaces/${otherWorkspace.id}/health`;
    const foreign = await (
      await request(`${otherBase}/services`, users[0], {
        method: "POST",
        body: JSON.stringify({ name: "Foreign worker" }),
      })
    ).json();
    const firstOrder = (await (await request(base)).json()).services.map(
      (item: { id: string }) => item.id,
    );
    const secondOrder = (await (await request(otherBase)).json()).services.map(
      (item: { id: string }) => item.id,
    );
    assert.equal(
      (
        await mutate("/services/order", "PUT", {
          serviceIds: [another.id, foreign.id],
        })
      ).status,
      400,
    );
    assert.deepEqual(
      (await (await request(base)).json()).services.map(
        (item: { id: string }) => item.id,
      ),
      firstOrder,
    );
    assert.deepEqual(
      (await (await request(otherBase)).json()).services.map(
        (item: { id: string }) => item.id,
      ),
      secondOrder,
    );
    const invalid = await mutate(`/services/${service.id}/probes`, "POST", {
      name: "Private",
      url: "http://127.0.0.1/health",
    });
    assert.equal(invalid.status, 400);
    const createdProbe = await mutate(
      `/services/${service.id}/probes`,
      "POST",
      { name: "Readiness", url: "https://example.com/health" },
    );
    assert.equal(createdProbe.status, 201);
    const probe = (await createdProbe.json()) as { id: string };
    const snapshot = await (await request(base)).json();
    const probedService = snapshot.services.find(
      (item: { id: string }) => item.id === service.id,
    );
    assert.equal(probedService?.probes[0].status, "unknown");
    assert.equal(
      (await mutate(`/probes/${probe.id}/check`, "POST")).status,
      202,
    );
    const controller = new AbortController();
    const response = await request(`${base}/events`, users[0], {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    try {
      assert.match(
        new TextDecoder().decode((await reader.read()).value),
        /event: health/,
      );
      const frame = reader.read();
      assert.equal(
        (
          await mutate(`/services/${service.id}`, "PATCH", {
            name: "Renamed API",
          })
        ).status,
        204,
      );
      const update = await Promise.race([
        frame,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Missing health invalidation")),
            2000,
          ).unref(),
        ),
      ]);
      assert.match(new TextDecoder().decode(update.value), /event: health/);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
    const personal = await workspaces.ensurePersonal(users[0]);
    assert.equal(
      (await request(`/api/workspaces/${personal.id}/health`)).status,
      403,
    );
    assert.equal(
      (await mutate(`/services/${service.id}`, "DELETE")).status,
      204,
    );
    assert.equal((await (await request(base)).json()).services.length, 0);
    auth.active.delete(users[0].id);
    assert.equal((await request(base)).status, 401);
  });
});

test("health share links expose only status data and rotate independently of dashboard links", async (t) => {
  await withApp(t, async ({ workspaces, store, users, request }) => {
    const workspace = await connect(workspaces, users[0], 1);
    const base = `/api/workspaces/${workspace.id}`;
    const createdService = await (
      await request(`${base}/health/services`, users[0], {
        method: "POST",
        body: JSON.stringify({ name: "Public status name" }),
      })
    ).json();
    const probe = await (
      await request(
        `${base}/health/services/${createdService.id}/probes`,
        users[0],
        {
          method: "POST",
          body: JSON.stringify({
            name: "Readiness",
            url: "https://example.com/private-probe-path?key=private-query",
            jsonPath: "internal.state",
            jsonExpected: "private-condition",
          }),
        },
      )
    ).json();
    assert.ok(probe.id);
    const dashboardResponse = await request(`${base}/share`, users[0], {
      method: "POST",
      body: JSON.stringify({ expiresIn: 3600 }),
    });
    assert.equal(dashboardResponse.status, 201);
    const dashboard = await dashboardResponse.json();
    const created = await request(`${base}/health/share`, users[0], {
      method: "POST",
      body: JSON.stringify({ expiresIn: 3600 }),
    });
    assert.equal(created.status, 201);
    const link = await created.json();
    assert.ok(link.token);
    const healthRead = (token: string) =>
      request("/api/shared/health", null, {
        headers: { "x-health-share": token },
      });
    const publicResponse = await healthRead(link.token);
    assert.equal(publicResponse.status, 200);
    const text = await publicResponse.text();
    assert.match(text, /Public status name/);
    assert.doesNotMatch(
      text,
      /private-probe-path|private-query|private-condition|internal.state|hasHeaders|statusMin|jsonPath|"url"/,
    );
    assert.equal((await healthRead(dashboard.token)).status, 410);
    assert.equal(
      (
        await request("/api/shared/feed", null, {
          headers: { "x-dashboard-share": link.token },
        })
      ).status,
      410,
    );
    const persisted = await store.pool.query(
      "SELECT token_hash FROM ship_live_health_shares",
    );
    assert.ok(!JSON.stringify(persisted.rows).includes(link.token));
    const rotated = await (
      await request(`${base}/health/share/rotate`, users[0], {
        method: "POST",
        body: JSON.stringify({ expiresIn: 86400 }),
      })
    ).json();
    assert.notEqual(rotated.token, link.token);
    assert.equal((await healthRead(link.token)).status, 410);
    assert.equal((await healthRead(rotated.token)).status, 200);
    assert.equal(
      (
        await request("/api/shared/feed", null, {
          headers: { "x-dashboard-share": dashboard.token },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(`${base}/health/share`, users[1], {
          method: "POST",
          body: JSON.stringify({ expiresIn: 3600 }),
        })
      ).status,
      404,
    );
    await request(`${base}/health/share`, users[0], { method: "DELETE" });
    assert.equal((await healthRead(rotated.token)).status, 410);
  });
});

test("health shares expire, revoke live viewers and reject loss of creator access", async (t) => {
  await withApp(t, async ({ workspaces, store, users, provider, request }) => {
    const workspace = await connect(workspaces, users[0], 1);
    const base = `/api/workspaces/${workspace.id}/health/share`;
    const create = async () => {
      const response = await request(base, users[0], {
        method: "POST",
        body: JSON.stringify({ expiresIn: 3600 }),
      });
      assert.equal(response.status, 201);
      return response.json() as Promise<{ token: string }>;
    };
    assert.equal(
      (
        await request(base, users[0], {
          method: "POST",
          headers: { "x-csrf-token": "invalid" },
          body: JSON.stringify({ expiresIn: 3600 }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(base, users[0], {
          method: "POST",
          body: JSON.stringify({ expiresIn: 10 }),
        })
      ).status,
      400,
    );
    const link = await create();
    const controller = new AbortController();
    const stream = await request("/api/shared/health/events", null, {
      headers: { "x-health-share": link.token },
      signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("cache-control") || "", /no-store/);
    const reader = stream.body!.getReader();
    try {
      const connectedFrame = new TextDecoder().decode(
        (await reader.read()).value,
      );
      assert.match(connectedFrame, /connected/);
      // Wait for the subscription-race authorization to finish before counting.
      let initial = connectedFrame;
      const initialDeadline = setTimeout(() => controller.abort(), 3000);
      try {
        // Connected and initial refresh can be delivered in the same chunk.
        while (!initial.includes("refresh")) {
          const frame = await reader.read();
          if (frame.done) break;
          initial += new TextDecoder().decode(frame.value);
        }
      } finally {
        clearTimeout(initialDeadline);
      }
      const callsBefore = provider.calls.length;
      await store.pool.query("SELECT pg_notify('ship_live_event_changes',$1)", [
        JSON.stringify({
          organization: `health-${workspace.id}`,
          eventId: "health",
        }),
      ]);
      const invalidationDeadline = setTimeout(() => controller.abort(), 3000);
      try {
        const frame = new TextDecoder().decode((await reader.read()).value);
        assert.match(frame, /refresh/);
        assert.equal(
          provider.calls.length,
          callsBefore,
          "empty health invalidations must not call GitHub",
        );
      } finally {
        clearTimeout(invalidationDeadline);
      }
      await request(base, users[0], { method: "DELETE" });
      const deadline = setTimeout(() => controller.abort(), 3000);
      deadline.unref();
      let text = "";
      try {
        while (!text.includes("access-revoked")) {
          const frame = await reader.read();
          if (frame.done) break;
          text += new TextDecoder().decode(frame.value);
        }
      } finally {
        clearTimeout(deadline);
      }
      assert.match(text, /access-revoked/);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
    const expiring = await create();
    await store.pool.query(
      "UPDATE ship_live_health_shares SET expires_at=now()-interval '1 second'",
    );
    assert.equal(
      (
        await request("/api/shared/health", null, {
          headers: { "x-health-share": expiring.token },
        })
      ).status,
      410,
    );
    const replacement = await create();
    provider.visible.set("token-a", []);
    assert.equal(
      (
        await request("/api/shared/health", null, {
          headers: { "x-health-share": replacement.token },
        })
      ).status,
      410,
    );
    assert.equal(
      (
        await request(`${base.replace("/share", "")}/services`, null, {
          method: "POST",
          headers: { "x-health-share": replacement.token },
          body: JSON.stringify({ name: "Forbidden" }),
        })
      ).status,
      401,
    );
  });
});

test("health share revocation during the snapshot read cannot release data", async (t) => {
  await withApp(t, async ({ workspaces, store, users, request }) => {
    const workspace = await connect(workspaces, users[0], 1);
    const base = `/api/workspaces/${workspace.id}/health`;
    await request(`${base}/services`, users[0], {
      method: "POST",
      body: JSON.stringify({ name: "Never release this service" }),
    });
    const link = await (
      await request(`${base}/share`, users[0], {
        method: "POST",
        body: JSON.stringify({ expiresIn: 3600 }),
      })
    ).json();
    const read = HealthStore.prototype.snapshot;
    HealthStore.prototype.snapshot = async function (id) {
      const result = await read.call(this, id);
      await store.pool.query(
        "DELETE FROM ship_live_health_shares WHERE workspace_id=$1",
        [id],
      );
      return result;
    };
    try {
      const response = await request("/api/shared/health", null, {
        headers: { "x-health-share": link.token },
      });
      assert.equal(response.status, 410);
      assert.doesNotMatch(await response.text(), /Never release this service/);
    } finally {
      HealthStore.prototype.snapshot = read;
    }
  });
});

test("private health reads recheck installation access after fetching the snapshot", async (t) => {
  await withApp(t, async ({ workspaces, store, users, request }) => {
    const workspace = await connect(workspaces, users[0], 1);
    const base = `/api/workspaces/${workspace.id}/health`;
    await request(`${base}/services`, users[0], {
      method: "POST",
      body: JSON.stringify({ name: "Restricted service" }),
    });
    const read = HealthStore.prototype.snapshot;
    HealthStore.prototype.snapshot = async function (id) {
      const result = await read.call(this, id);
      await store.pool.query(
        "UPDATE ship_live_installations SET active=false WHERE id=$1",
        [workspace.installationId],
      );
      return result;
    };
    try {
      const response = await request(base);
      assert.equal(response.status, 403);
      assert.doesNotMatch(await response.text(), /Restricted service/);
    } finally {
      HealthStore.prototype.snapshot = read;
    }
  });
});
