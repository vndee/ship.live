import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Request, Response } from "express";
import { AuthService, AuthError, type Principal } from "./auth.js";
import { createTestDatabase } from "./test-database.js";
import { PostgresEventStore } from "./postgres-store.js";
import { WorkspaceStore } from "./workspace-store.js";
import { createWorkspaceApp } from "./workspace-app.js";
test("saved views enforce ownership, CSRF, workspace access and the concurrent account limit", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const store = await PostgresEventStore.open(url);
  const users = [
    { id: randomUUID(), name: "One" },
    { id: randomUUID(), name: "Two" },
  ];
  for (const user of users)
    await store.pool.query(
      "INSERT INTO ship_live_auth_users(id,name) VALUES($1,$2)",
      [user.id, user.name],
    );
  const workspaces = new WorkspaceStore(store.pool, "11".repeat(32));
  const work = await workspaces.ensurePersonal(users[0]);
  const csrf = "ab".repeat(32);
  class FixtureAuth extends AuthService {
    override async authenticate(
      req: Request,
      _res: Response,
    ): Promise<Principal> {
      return {
        user: users[req.get("x-user") === "two" ? 1 : 0],
        sessionId: "fixture",
        csrfToken: csrf,
      };
    }
    override async assertActive(_p: Principal) {}
  }
  const app = createWorkspaceApp({
    store,
    workspaces,
    auth: new FixtureAuth({ appUrl: "https://ship.test" }, store.pool),
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const call = (
    path = "",
    method = "GET",
    body?: unknown,
    user = "one",
    token = csrf,
  ) =>
    fetch(`http://127.0.0.1:${address.port}/api/saved-views${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        origin: "https://ship.test",
        "x-csrf-token": token,
        "x-user": user,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const input = {
    name: "Review morning",
    href: `/?workspace=${work.id}&scene=review`,
  };
  assert.equal((await call("", "POST", input, "one", "")).status, 403);
  assert.equal((await call("", "POST", input, "two")).status, 404);
  const created = await call("", "POST", input);
  assert.equal(created.status, 201);
  const view = await created.json();
  assert.equal(view.href, `/?workspace=${work.id}&scene=review&period=7d`);
  assert.equal((await (await call()).json()).views.length, 1);
  assert.equal(
    (await (await call("", "GET", undefined, "two")).json()).views.length,
    0,
  );
  assert.equal(
    (await call(`/${view.id}`, "PATCH", { name: "Stolen" }, "two")).status,
    404,
  );
  assert.equal(
    (await call(`/${view.id}`, "DELETE", undefined, "two")).status,
    404,
  );
  const renamed = await call(`/${view.id}`, "PATCH", { name: "Morning" });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).name, "Morning");
  const fixed = await call(`/${view.id}`, "PATCH", {
    name: "Launch",
    href: `/?workspace=${work.id}&period=custom&from=2026-09-01&to=2026-09-07`,
  });
  assert.equal(fixed.status, 200);
  assert.match((await fixed.json()).href, /period=custom/);
  assert.equal(
    (await call("", "POST", { name: "Unsafe", href: "https://evil.test" }))
      .status,
    400,
  );
  const attempts = await Promise.all(
    Array.from({ length: 31 }, (_, i) =>
      call("", "POST", { ...input, name: `View ${i}` }),
    ),
  );
  assert.equal(attempts.filter((r) => r.status === 201).length, 29);
  assert.equal(attempts.filter((r) => r.status === 409).length, 2);
  assert.equal((await (await call()).json()).views.length, 30);
  assert.equal((await call(`/${view.id}`, "DELETE")).status, 204);
  assert.equal((await (await call()).json()).views.length, 29);
});
