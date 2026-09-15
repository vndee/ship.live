import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { AuthService, AuthError, type Principal } from "./auth.js";
import { createTestDatabase } from "./test-database.js";
import { PostgresEventStore } from "./postgres-store.js";
import { WallStore } from "./wall-store.js";
import type { Workspace } from "../shared/workspaces.js";
import type { Pool } from "pg";
import { ReviewFollowthroughStore } from "./review-followthrough-store.js";
import type { ReviewFollowthroughItem } from "../shared/review-followthrough.js";

test("a broken rollback preserves the original review error and discards its connection", async () => {
  const original = new Error("Connection lost during review mutation");
  let released: boolean | undefined;
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql === "BEGIN") return { rows: [] };
      if (sql === "ROLLBACK") throw new Error("Connection still unavailable");
      throw original;
    },
    release(failed?: boolean) {
      released = failed;
    },
  };
  const reviews = new ReviewFollowthroughStore({
    connect: async () => client,
  } as unknown as Pool);
  await assert.rejects(
    reviews.mutate(
      "workspace",
      "user",
      { repositoryId: 101, number: 7 } as ReviewFollowthroughItem,
      "claim",
      undefined,
      { sources: [{ installationId: 10, repositories: [{ id: 101 }] }] },
    ),
    (error) => error === original,
  );
  assert.equal(queries.at(-1), "ROLLBACK");
  assert.equal(
    released,
    true,
    "Do not reuse a connection whose rollback failed",
  );
});
class FixtureAuth extends AuthService {
  userId = "";
  override async authenticate(
    req: Request,
    _res: Response,
  ): Promise<Principal> {
    return {
      user: { id: req.get("x-user") || this.userId, name: "Person" },
      sessionId: "session",
      csrfToken: "token",
    };
  }
  override async requireMutation(req: Request, res: Response) {
    if (req.get("x-csrf-token") !== "token") throw new AuthError(403, "CSRF");
    return this.authenticate(req, res);
  }
  override async assertActive() {}
}
test("oversized review context blocks only its PR and leaves neighbors actionable", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const store = await PostgresEventStore.open(url);
  try {
    const { ReviewFollowthroughStore } =
      await import("./review-followthrough-store.js");
    const reviews = new ReviewFollowthroughStore(store.pool);
    const wall = new WallStore(store.pool);
    const at = "2026-09-10T00:00:00Z";
    for (const number of [7, 8, 9])
      await wall.apply(10, 101, "team/api", randomUUID(), [
        {
          kind: "pull_request",
          observedAt: at,
          value: {
            number,
            title: `PR ${number}`,
            url: `https://github.com/team/api/pull/${number}`,
            author: "alice",
            headSha: `head-${number}`,
            state: "open",
            draft: false,
            createdAt: at,
            updatedAt: at,
          },
        },
      ]);
    await wall.apply(
      10,
      101,
      "team/api",
      randomUUID(),
      Array.from({ length: 101 }, (_, id) => ({
        kind: "review" as const,
        observedAt: at,
        value: {
          id,
          pullRequestNumber: 7,
          reviewer: `reviewer-${id}`,
          decision: "approved" as const,
          submittedAt: at,
        },
      })),
    );
    await wall.apply(
      10,
      101,
      "team/api",
      randomUUID(),
      Array.from({ length: 101 }, (_, id) => ({
        kind: "pipeline" as const,
        observedAt: at,
        value: {
          id: String(id),
          name: `check-${id}`,
          provider: "ci",
          headSha: "head-8",
          status: "passing" as const,
          updatedAt: at,
        },
      })),
    );
    const scope = {
      sources: [{ installationId: 10, repositories: [{ id: 101 }] }],
    };
    const targets = [7, 8, 9].map((number) => ({ repositoryId: 101, number }));
    const items = await reviews.current(scope, targets);
    assert.deepEqual(
      items.map((item) => item.number),
      [9],
      "Only the oversized PRs must be omitted from the batch",
    );
    const own = await reviews.current(scope, [targets[2]]);
    assert.equal(items[0].fingerprint, own[0].fingerprint);
    assert.equal(items[0].actionable, true);
    const user = randomUUID(),
      workspace = randomUUID();
    await store.pool.query(
      "INSERT INTO ship_live_auth_users(id,name) VALUES($1,'Alice')",
      [user],
    );
    await store.pool.query(
      "INSERT INTO ship_live_workspaces(id,name,kind,installation_id) VALUES($1,'Team','team',10)",
      [workspace],
    );
    await reviews.mutate(workspace, user, items[0], "claim", undefined, scope);
    assert.equal(
      (await reviews.states(workspace, user, items))[0].claim?.userId,
      user,
    );
  } finally {
    await store.close();
  }
});
test("review API shares atomic claims only within current repo scope, keeps snoozes personal and invalidates obsolete state", async (t) => {
  const mod = await import("./review-followthrough.js").catch(() => null);
  assert.ok(
    mod?.reviewFollowthroughRouter,
    "review follow-through router must exist",
  );
  const url = await createTestDatabase(t);
  if (!url) return;
  const store = await PostgresEventStore.open(url);
  let closeServer = async () => {};
  try {
    const a = randomUUID(),
      b = randomUUID(),
      wid = randomUUID();
    await store.pool.query(
      "INSERT INTO ship_live_auth_users(id,name) VALUES($1,'Alice'),($2,'Bob')",
      [a, b],
    );
    await store.pool.query(
      "INSERT INTO ship_live_workspaces(id,name,kind,installation_id) VALUES($1,'Team','team',10)",
      [wid],
    );
    const workspace = {
      id: wid,
      kind: "team",
      installationId: 10,
    } as Workspace;
    const auth = new FixtureAuth(
      { appUrl: "http://localhost:3000" },
      store.pool,
    );
    auth.userId = a;
    let allowed = true;
    let author: string | undefined;
    let reads = 0;
    let revokeAt = Infinity;
    let additional = false;
    const viewer = async () => {
      reads++;
      return {
        workspace,
        sources:
          allowed && reads < revokeAt
            ? [
                {
                  installationId: 10,
                  repositories: [{ id: 101, name: "team/api", private: true }],
                },
                ...(additional
                  ? [
                      {
                        installationId: 11,
                        repositories: [
                          { id: 101, name: "team/api", private: true },
                        ],
                      },
                    ]
                  : []),
              ]
            : [],
        author,
      };
    };
    const app = express();
    app.use(express.json());
    app.use(mod.reviewFollowthroughRouter({ auth, store, viewer }));
    app.use(
      (error: AuthError, _req: Request, res: Response, _next: NextFunction) =>
        res.status(error.status || 500).json({ error: error.message }),
    );
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    closeServer = () =>
      new Promise<void>((resolve) => server.close(() => resolve()));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/workspaces/${wid}/review-followthrough`;
    const wall = new WallStore(store.pool);
    let version = 0;
    const pull = {
      number: 7,
      title: "Ship",
      url: "https://github.com/team/api/pull/7",
      author: "alice",
      headSha: "abc",
      state: "open" as const,
      draft: false,
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-10T00:00:00Z",
    };
    async function put(p = pull) {
      await wall.apply(10, 101, "team/api", `delivery-${++version}`, [
        {
          kind: "pull_request",
          observedAt: new Date(Date.now() + version * 1000).toISOString(),
          value: p,
        },
      ]);
    }
    await put();
    const get = async (user = a) =>
      fetch(`${base}?items=101:7`, { headers: { "x-user": user } });
    const read = async (user = a) => (await (await get(user)).json()).items[0];
    const mutate = async (action: string, user = a, extra: object = {}) =>
      fetch(base, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": "token",
          "x-user": user,
        },
        body: JSON.stringify({
          repositoryId: 101,
          number: 7,
          fingerprint: (await read(user))?.fingerprint,
          action,
          ...extra,
        }),
      });
    const first = await read();
    assert.ok(first.actionable);
    await wall.apply(11, 101, "team/api", "extra-source", [
      {
        kind: "pull_request",
        observedAt: new Date().toISOString(),
        value: { ...pull, number: 8 },
      },
    ]);
    additional = true;
    const batch = await (await fetch(`${base}?items=101:7,101:8`)).json();
    assert.equal(
      batch.items.find((i: { number: number }) => i.number === 7).fingerprint,
      first.fingerprint,
      "batch neighbors must not change a PR fingerprint",
    );
    additional = false;
    assert.equal(
      (
        await fetch(base, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
    const claims = await Promise.all([mutate("claim", a), mutate("claim", b)]);
    assert.deepEqual(claims.map((r) => r.status).sort(), [200, 409]);
    const claimed = await read();
    const owner = claimed.claim.userId;
    const other = owner === a ? b : a;
    assert.equal((await mutate("release", other)).status, 409);
    assert.equal((await read(other)).claim.userId, owner);
    assert.equal((await mutate("snooze", a, { hours: 4 })).status, 200);
    assert.ok((await read(a)).snoozedUntil);
    assert.equal((await read(b)).snoozedUntil, undefined);
    await store.pool.query(
      "UPDATE ship_live_review_snoozes SET expires_at=now()-interval '1 second'",
    );
    assert.equal((await read(a)).snoozedUntil, undefined);
    assert.equal((await mutate("snooze", a, { hours: 4 })).status, 200);
    await put({ ...pull, headSha: "new", updatedAt: "2026-09-15T00:00:00Z" });
    assert.equal((await read()).claim, undefined);
    assert.equal((await read()).snoozedUntil, undefined);
    const stale = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "token" },
      body: JSON.stringify({
        repositoryId: 101,
        number: 7,
        fingerprint: first.fingerprint,
        action: "claim",
      }),
    });
    assert.equal(stale.status, 409);
    assert.equal((await mutate("claim", b)).status, 200);
    const { ReviewFollowthroughStore } =
      await import("./review-followthrough-store.js");
    await assert.rejects(
      new ReviewFollowthroughStore(store.pool).mutate(
        wid,
        a,
        first,
        "claim",
        undefined,
        await viewer(),
      ),
      (error: unknown) => error instanceof AuthError && error.status === 409,
      "a delayed claim must not overwrite a newer head claim",
    );
    assert.equal((await read()).claim.userId, b);
    author = "bob";
    assert.deepEqual((await (await get()).json()).items, []);
    author = undefined;
    allowed = false;
    assert.deepEqual((await (await get()).json()).items, []);
    allowed = true;
    revokeAt = reads + 2;
    assert.equal((await get()).status, 403);
    revokeAt = Infinity;
    assert.equal(
      (await fetch(`${base}?items=${Array(51).fill("101:7").join(",")}`))
        .status,
      400,
    );
    await put({
      ...pull,
      state: "merged" as "open",
      updatedAt: "2026-09-16T00:00:00Z",
    });
    assert.deepEqual((await (await get()).json()).items, []);
  } finally {
    await closeServer();
    await store.close();
  }
});
