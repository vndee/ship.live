import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import express, { type ErrorRequestHandler } from "express";
import { AuthError, type AuthService, type Principal } from "./auth.js";
import { PostgresEventStore } from "./postgres-store.js";
import { createTestDatabase } from "./test-database.js";
import { recapRouter } from "./recap-app.js";

test("recap HTTP boundary enforces exact source pairs, author scope, private notes, and access recheck", async (t) => {
  const db = await createTestDatabase(t);
  if (!db) return;
  const store = await PostgresEventStore.open(db),
    pool = store.pool;
  const workspace = randomUUID(),
    user = randomUUID(),
    other = randomUUID();
  await pool.query(
    "INSERT INTO ship_live_auth_users(id,name) VALUES($1,'A'),($2,'B')",
    [user, other],
  );
  await pool.query(
    "INSERT INTO ship_live_workspaces(id,name,kind,installation_id) VALUES($1,'Team','team',99)",
    [workspace],
  );
  await pool.query(
    "INSERT INTO ship_live_organizations(organization) VALUES('installation-99'),('installation-100')",
  );
  for (const [id, installation, repositoryId, login] of [
    ["visible", 99, 7, "alice"],
    ["wrong-source", 99, 8, "alice"],
    ["wrong-author", 100, 8, "bob"],
  ] as const) {
    const at = "2026-09-08T12:00:00Z";
    await pool.query(
      "INSERT INTO ship_live_events(organization,event_id,event,occurred_at) VALUES($1,$2,$3,$4)",
      [
        `installation-${installation}`,
        id,
        {
          id,
          type: "merge",
          actor: { login },
          repo: "org/" + id,
          repositoryId,
          title: id,
          occurredAt: at,
        },
        at,
      ],
    );
    await pool.query(
      `INSERT INTO ship_live_wall_signals(installation_id,repository_id,repository,kind,signal_key,observed_at,value)
       VALUES($1,$2,$3,'pull_request','1',$4,$5)`,
      [
        installation,
        repositoryId,
        "org/" + id,
        at,
        {
          number: 1,
          title: id,
          url: `https://github.com/org/${id}/pull/1`,
          author: login,
          state: "open",
          draft: false,
          headSha: id,
          createdAt: at,
          updatedAt: at,
        },
      ],
    );
  }
  let currentUser = user,
    denied = false,
    changeDuringRead = false,
    reads = 0;
  const auth = {
    authenticate: async () => ({
      user: { id: currentUser },
      sessionId: "session",
    }),
    requireMutation: async (req: { headers: Record<string, string> }) => {
      if (req.headers["x-csrf-token"] !== "token")
        throw new AuthError(403, "CSRF required");
      return { user: { id: currentUser }, sessionId: "session" };
    },
    assertActive: async () => {},
  } as unknown as AuthService;
  const viewer = async (_p: Principal, id: string) => {
    if (id !== workspace || denied) throw new AuthError(403, "Access changed");
    reads++;
    return {
      workspace: {
        id: workspace,
        name: "Team",
        kind: "team" as const,
        owner: false,
      },
      repositories: [{ id: 7 }, { id: 8 }],
      sources: [
        { installationId: 99, repositories: [{ id: 7 }] },
        { installationId: 100, repositories: [{ id: 8 }] },
      ],
      author: changeDuringRead && reads % 2 === 0 ? "bob" : "alice",
    };
  };
  const app = express();
  app.use(express.json());
  app.use(
    recapRouter({
      auth,
      store,
      viewer: viewer as never,
      now: () => Date.parse("2026-09-15T00:00:00Z"),
    }),
  );
  app.use(((e, _q, r, _n) =>
    r
      .status(e instanceof AuthError ? e.status : 500)
      .json({ error: e.message })) as ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/workspaces/${workspace}/recap`;
  const request = (path = "", init: RequestInit = {}) =>
    fetch(base + path, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-csrf-token": "token",
        ...init.headers,
      },
    });
  try {
    let response = await request("?week=2026-09-07");
    assert.equal(response.status, 200);
    let body = await response.json();
    assert.equal(body.totals.merges, 1);
    assert.deepEqual(
      body.shipped.map((i: { title: string }) => i.title),
      ["visible"],
    );
    assert.deepEqual(
      body.needsHelp.map((item: { title: string }) => item.title),
      ["visible"],
    );
    assert.equal(body.weekEnd, "2026-09-13");
    assert.equal((await request("?week=2026-09-14")).status, 400);
    assert.equal(
      (
        await request("/reflection", {
          method: "PUT",
          body: JSON.stringify({
            week: "2026-09-07",
            reflection: "What mattered to me",
          }),
        })
      ).status,
      200,
    );
    body = await (await request("?week=2026-09-07")).json();
    assert.equal(body.reflection, "What mattered to me");
    currentUser = other;
    body = await (await request("?week=2026-09-07")).json();
    assert.equal(body.reflection, "");
    currentUser = user;
    assert.equal(
      (
        await request("/reflection", {
          method: "PUT",
          body: JSON.stringify({
            week: "2026-09-07",
            reflection: "x".repeat(5001),
          }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("/reflection", {
          method: "PUT",
          headers: { "x-csrf-token": "" },
          body: JSON.stringify({ week: "2026-09-07", reflection: "overwrite" }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request("/schedule", {
          method: "PUT",
          body: JSON.stringify({
            weekday: 2,
            time: "16:30",
            timezone: "Asia/Ho_Chi_Minh",
          }),
        })
      ).status,
      200,
    );
    body = await (await request()).json();
    assert.deepEqual(body.schedule, {
      weekday: 2,
      time: "16:30",
      timezone: "Asia/Ho_Chi_Minh",
    });
    assert.equal(
      (
        await request("/schedule", {
          method: "PUT",
          body: JSON.stringify({
            weekday: 2,
            time: "16:30",
            timezone: "Invalid",
          }),
        })
      ).status,
      400,
    );
    const md = await (await request("/export?week=2026-09-07")).text();
    assert.match(md, /What mattered to me/);
    assert.ok(!md.includes("wrong-source"));
    assert.match(md, /Current needs help/);
    reads = 0;
    changeDuringRead = true;
    response = await request();
    assert.equal(response.status, 403);
    assert.ok(!(await response.text()).includes("visible"));
    denied = true;
    assert.equal((await request()).status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
  }
});
