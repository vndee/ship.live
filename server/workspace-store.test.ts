import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PostgresEventStore } from "./postgres-store.js";
import { createTestDatabase } from "./test-database.js";
import { WorkspaceStore } from "./workspace-store.js";
import type { ActivityEvent } from "../shared/types.js";

test("personal journals cannot be read or changed by a different signed-in user", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const events = await PostgresEventStore.open(url);
  try {
    const a = { id: randomUUID(), name: "Builder A" };
    const b = { id: randomUUID(), name: "Builder B" };
    for (const user of [a, b])
      await events.pool.query(
        "INSERT INTO ship_live_auth_users(id,name) VALUES($1,$2)",
        [user.id, user.name],
      );
    const work = new WorkspaceStore(events.pool, "11".repeat(32));
    const journal = await work.ensurePersonal(a);
    assert.equal((await work.ensurePersonal(a)).id, journal.id);
    const note = await work.addNote(a, journal.id, {
      title: "Shipped the first version",
      body: "A private reflection.",
    });
    assert.equal((await work.notes(a.id, journal.id))[0].id, note.id);
    await assert.rejects(work.notes(b.id, journal.id), /not found/i);
    await assert.rejects(
      work.addNote(b, journal.id, { title: "Intrusion", body: "" }),
      /not found/i,
    );
    await assert.rejects(
      work.deleteNote(b.id, journal.id, note.id),
      /not found/i,
    );
    assert.equal((await work.notes(a.id, journal.id)).length, 1);
    await work.deleteNote(a.id, journal.id, note.id);
    assert.deepEqual(await work.notes(a.id, journal.id), []);
  } finally {
    await events.close();
  }
});

test("GitHub credentials are encrypted, bound to their owner and cannot be attached to another account", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const events = await PostgresEventStore.open(url);
  try {
    const a = { id: randomUUID(), name: "A" },
      b = { id: randomUUID(), name: "B" };
    for (const user of [a, b])
      await events.pool.query(
        "INSERT INTO ship_live_auth_users(id,name) VALUES($1,$2)",
        [user.id, user.name],
      );
    const work = new WorkspaceStore(events.pool, "11".repeat(32));
    const grant = {
      accessToken: "synthetic-private-token",
      refreshToken: "synthetic-refresh",
      expiresAt: Date.now() + 3600000,
    };
    await work.saveGrant(a.id, { id: 123, login: "builder-a" }, grant);
    const stored = await events.pool.query(
      "SELECT encrypted_grant FROM ship_live_github_connections WHERE user_id=$1",
      [a.id],
    );
    assert.equal(
      stored.rows[0].encrypted_grant.includes(grant.accessToken),
      false,
    );
    assert.equal(
      (
        await work.withGrant(a.id, async () => {
          throw new Error("No refresh needed");
        })
      ).accessToken,
      grant.accessToken,
    );
    await assert.rejects(
      work.saveGrant(b.id, { id: 123, login: "builder-a" }, grant),
      /already connected/i,
    );
    await events.pool.query(
      "UPDATE ship_live_github_connections SET user_id=$1 WHERE user_id=$2",
      [b.id, a.id],
    );
    await assert.rejects(work.withGrant(b.id, async () => grant));
  } finally {
    await events.close();
  }
});

test("all application tables deny direct unauthenticated Supabase Data API access", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const events = await PostgresEventStore.open(url);
  try {
    const rows = await events.pool.query(
      "SELECT relname,relrowsecurity FROM pg_class JOIN pg_namespace ON pg_namespace.oid=relnamespace WHERE nspname=current_schema() AND relkind='r' AND left(relname,10)='ship_live_'",
    );
    assert.ok(rows.rowCount && rows.rowCount >= 10);
    assert.deepEqual(
      rows.rows.filter((row) => !row.relrowsecurity),
      [],
    );
  } finally {
    await events.close();
  }
});

test("GitHub refresh rotation is serialized across store instances and uncertain refresh fails closed", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const events = await PostgresEventStore.open(url);
  try {
    const user = { id: randomUUID(), name: "Builder" };
    await events.pool.query(
      "INSERT INTO ship_live_auth_users(id,name) VALUES($1,$2)",
      [user.id, user.name],
    );
    const first = new WorkspaceStore(events.pool, "22".repeat(32));
    const second = new WorkspaceStore(events.pool, "22".repeat(32));
    await first.saveGrant(
      user.id,
      { id: 1, login: "builder" },
      { accessToken: "expired", refreshToken: "rotate-once", expiresAt: 0 },
    );
    let calls = 0;
    const refreshed = {
      accessToken: "new-token",
      refreshToken: "new-refresh",
      expiresAt: Date.now() + 3600000,
    };
    const refresh = async (token: string) => {
      assert.equal(token, "rotate-once");
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return refreshed;
    };
    const result = await Promise.all([
      first.withGrant(user.id, refresh),
      second.withGrant(user.id, refresh),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual(result, [refreshed, refreshed]);
    await first.saveGrant(
      user.id,
      { id: 1, login: "builder" },
      { accessToken: "expired-again", refreshToken: "uncertain", expiresAt: 0 },
    );
    await assert.rejects(
      first.withGrant(user.id, async () => {
        throw new Error("Provider unavailable");
      }),
      /expired/i,
    );
    assert.equal(await first.connection(user.id), undefined);
  } finally {
    await events.close();
  }
});

test("GitHub connection state is bound to the initiating user and session and consumed once", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const events = await PostgresEventStore.open(url);
  try {
    const user = { id: randomUUID(), name: "Builder" };
    await events.pool.query(
      "INSERT INTO ship_live_auth_users(id,name) VALUES($1,$2)",
      [user.id, user.name],
    );
    const work = new WorkspaceStore(events.pool, "22".repeat(32));
    const flow = await work.beginConnection(user.id, "session-a");
    await assert.rejects(
      work.consumeConnection(randomUUID(), "session-a", flow.state),
    );
    await assert.rejects(
      work.consumeConnection(user.id, "session-b", flow.state),
    );
    const verifier = await work.consumeConnection(
      user.id,
      "session-a",
      flow.state,
    );
    assert.equal(verifier.length, 64);
    await assert.rejects(
      work.consumeConnection(user.id, "session-a", flow.state),
    );
  } finally {
    await events.close();
  }
});

test("repository authorization filters before the feed limit and legacy rows stay isolated", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const events = await PostgresEventStore.open(url);
  try {
    const user = { id: randomUUID(), name: "Builder" };
    await events.pool.query(
      "INSERT INTO ship_live_auth_users(id,name) VALUES($1,$2)",
      [user.id, user.name],
    );
    const work = new WorkspaceStore(events.pool, "22".repeat(32));
    await work.saveGrant(
      user.id,
      { id: 42, login: "builder" },
      {
        accessToken: "synthetic-token",
        expiresAt: Date.now() + 3600000,
      },
    );
    const selected = await work.connectInstallation(
      user,
      {
        id: 123,
        accountId: 50,
        account: "team",
        kind: "Organization",
        suspended: false,
      },
      42,
      (await work.connection(user.id))!.generation,
    );
    const visible: ActivityEvent = {
      id: "visible",
      type: "merge",
      actor: { login: "builder" },
      repo: "team/visible",
      repositoryId: 1,
      title: "Allowed",
      occurredAt: "2026-09-01T00:00:00.000Z",
    };
    await events.merge("installation-123", [
      visible,
      ...Array.from({ length: 2100 }, (_, i) => ({
        ...visible,
        id: `hidden-${i}`,
        repositoryId: 2,
        repo: "team/secret",
        title: "Hidden",
        occurredAt: "2026-09-02T00:00:00.000Z",
      })),
    ]);
    await events.merge("team", [{ ...visible, id: "legacy-unclaimed" }]);
    assert.deepEqual(
      (await work.feed(user.id, selected, [1])).map((event) => event.id),
      ["visible"],
    );
    assert.deepEqual(await work.feed(user.id, selected, []), []);
    await work.setInstallationActive(123, false);
    await assert.rejects(
      work.feed(user.id, selected, [1]),
      /no longer available/i,
    );
  } finally {
    await events.close();
  }
});

test("lifecycle revocation and delivery deduplication commit or roll back together", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const events = await PostgresEventStore.open(url);
  try {
    const user = { id: randomUUID(), name: "Builder" };
    await events.pool.query(
      "INSERT INTO ship_live_auth_users(id,name) VALUES($1,$2)",
      [user.id, user.name],
    );
    const work = new WorkspaceStore(events.pool, "22".repeat(32));
    await work.saveGrant(
      user.id,
      { id: 42, login: "builder" },
      {
        accessToken: "synthetic-token",
        expiresAt: Date.now() + 3600000,
      },
    );
    await work.connectInstallation(
      user,
      {
        id: 123,
        accountId: 50,
        account: "team",
        kind: "Organization",
        suspended: false,
      },
      42,
      (await work.connection(user.id))!.generation,
    );
    await events.pool.query(
      "ALTER TABLE ship_live_installations ADD CONSTRAINT test_block_suspension CHECK(active)",
    );
    await assert.rejects(
      work.applyLifecycle("suspend-once", {
        kind: "installation",
        installationId: 123,
        active: false,
      }),
    );
    assert.equal(
      (
        await events.pool.query(
          "SELECT 1 FROM ship_live_deliveries WHERE delivery_id='suspend-once'",
        )
      ).rowCount,
      0,
    );
    assert.equal(await work.installationActive(123), true);
    await events.pool.query(
      "ALTER TABLE ship_live_installations DROP CONSTRAINT test_block_suspension",
    );
    assert.deepEqual(
      await work.applyLifecycle("suspend-once", {
        kind: "installation",
        installationId: 123,
        active: false,
      }),
      { duplicate: false },
    );
    assert.equal(await work.installationActive(123), false);
    await work.applyLifecycle("resume-once", {
      kind: "installation",
      installationId: 123,
      active: true,
    });
    assert.deepEqual(
      await work.applyLifecycle("suspend-once", {
        kind: "installation",
        installationId: 123,
        active: false,
      }),
      { duplicate: true },
    );
    assert.equal(await work.installationActive(123), true);
  } finally {
    await events.close();
  }
});

test("a claimed GitHub callback cannot recreate a disconnected connection or complete after logout", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const events = await PostgresEventStore.open(url);
  try {
    const user = { id: randomUUID(), name: "Builder" };
    await events.pool.query(
      "INSERT INTO ship_live_auth_users(id,name) VALUES($1,$2)",
      [user.id, user.name],
    );
    const sessionId = "44".repeat(32);
    await events.pool.query(
      "INSERT INTO ship_live_auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [sessionId, user.id],
    );
    const work = new WorkspaceStore(events.pool, "22".repeat(32));
    const identity = { id: 42, login: "builder" };
    const grant = {
      accessToken: "synthetic-token",
      expiresAt: Date.now() + 3600000,
    };
    const cancelled = await work.beginConnection(user.id, sessionId);
    await work.consumeConnection(user.id, sessionId, cancelled.state);
    await work.disconnect(user.id);
    await assert.rejects(
      work.completeConnection(
        user.id,
        sessionId,
        cancelled.state,
        identity,
        grant,
      ),
      /expired/i,
    );
    assert.equal(await work.connection(user.id), undefined);

    const loggedOut = await work.beginConnection(user.id, sessionId);
    await work.consumeConnection(user.id, sessionId, loggedOut.state);
    await events.pool.query(
      "DELETE FROM ship_live_auth_sessions WHERE token_hash=$1",
      [sessionId],
    );
    await assert.rejects(
      work.completeConnection(
        user.id,
        sessionId,
        loggedOut.state,
        identity,
        grant,
      ),
      /sign in/i,
    );
    assert.equal(await work.connection(user.id), undefined);

    await events.pool.query(
      "INSERT INTO ship_live_auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [sessionId, user.id],
    );
    const valid = await work.beginConnection(user.id, sessionId);
    await assert.rejects(
      work.completeConnection(user.id, sessionId, valid.state, identity, grant),
      /expired/i,
    );
    await work.consumeConnection(user.id, sessionId, valid.state);
    await work.completeConnection(
      user.id,
      sessionId,
      valid.state,
      identity,
      grant,
    );
    assert.equal((await work.connection(user.id))?.githubUserId, 42);
    await assert.rejects(
      work.completeConnection(user.id, sessionId, valid.state, identity, grant),
      /expired/i,
    );
  } finally {
    await events.close();
  }
});

test("an old GitHub authorization cannot attach an installation after disconnect and same-account reconnect", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const events = await PostgresEventStore.open(url);
  try {
    const user = { id: randomUUID(), name: "Builder" };
    await events.pool.query(
      "INSERT INTO ship_live_auth_users(id,name) VALUES($1,$2)",
      [user.id, user.name],
    );
    const work = new WorkspaceStore(events.pool, "22".repeat(32));
    const identity = { id: 42, login: "builder" };
    const grant = {
      accessToken: "synthetic-token",
      expiresAt: Date.now() + 3600000,
    };
    await work.saveGrant(user.id, identity, grant);
    const previous = (await work.connection(user.id))!.generation;
    await work.disconnect(user.id);
    await work.saveGrant(user.id, identity, grant);
    const current = (await work.connection(user.id))!.generation;
    assert.notEqual(previous, current);
    const installation = {
      id: 123,
      accountId: 42,
      account: "builder",
      kind: "User" as const,
      suspended: false,
    };
    await assert.rejects(
      work.connectInstallation(user, installation, 42, previous),
      /connection changed/i,
    );
    assert.equal((await work.ensurePersonal(user)).installationId, undefined);
    assert.equal(
      (await work.connectInstallation(user, installation, 42, current))
        .installationId,
      123,
    );
    await work.saveGrant(user.id, identity, grant);
    await assert.rejects(
      work.connectInstallation(user, installation, 42, current),
      /connection changed/i,
    );
  } finally {
    await events.close();
  }
});

test("failed GitHub refresh clears workspace associations and cancels pending OAuth transactions", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const events = await PostgresEventStore.open(url);
  try {
    const user = { id: randomUUID(), name: "Builder" };
    await events.pool.query(
      "INSERT INTO ship_live_auth_users(id,name) VALUES($1,$2)",
      [user.id, user.name],
    );
    const work = new WorkspaceStore(events.pool, "22".repeat(32));
    await work.saveGrant(
      user.id,
      { id: 42, login: "builder-a" },
      {
        accessToken: "expired",
        refreshToken: "synthetic-refresh",
        expiresAt: 0,
      },
    );
    const generation = (await work.connection(user.id))!.generation;
    const journal = await work.connectInstallation(
      user,
      {
        id: 123,
        accountId: 42,
        account: "builder-a",
        kind: "User",
        suspended: false,
      },
      42,
      generation,
    );
    await work.connectInstallation(
      user,
      {
        id: 124,
        accountId: 50,
        account: "private-team",
        kind: "Organization",
        suspended: false,
      },
      42,
      generation,
    );
    const flow = await work.beginConnection(user.id, "synthetic-session");
    assert.equal((await work.list(user.id)).length, 2);
    await assert.rejects(
      work.withGrant(user.id, async () => {
        throw new Error("Uncertain token rotation");
      }),
      /expired/i,
    );
    assert.equal(await work.connection(user.id), undefined);
    assert.equal(
      (await work.get(user.id, journal.id)).installationId,
      undefined,
    );
    assert.equal((await work.list(user.id)).length, 1);
    await assert.rejects(
      work.consumeConnection(user.id, "synthetic-session", flow.state),
      /expired/i,
    );
    await work.saveGrant(
      user.id,
      { id: 43, login: "builder-b" },
      { accessToken: "new-account", expiresAt: Date.now() + 3600000 },
    );
    assert.equal((await work.list(user.id)).length, 1);
    assert.equal(
      (await work.get(user.id, journal.id)).installationId,
      undefined,
    );
  } finally {
    await events.close();
  }
});
