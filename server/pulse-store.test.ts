import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "./test-database.js";
import { PostgresEventStore } from "./postgres-store.js";
import { PulseStore } from "./pulse-store.js";
import { aggregatePulse, resolvePulseRange } from "../shared/pulse.js";
import type { ActivityEvent } from "../shared/types.js";
test("SQL aggregates full authorized history and stable keyset pages", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const store = await PostgresEventStore.open(url);
  try {
    const now = Date.parse("2026-09-15T12:00:00Z");
    const range = resolvePulseRange({}, now);
    const events: ActivityEvent[] = Array.from({ length: 2105 }, (_, i) => ({
      id: `event-${String(i).padStart(5, "0")}`,
      type: i % 2 ? "review" : "merge",
      actor: { login: "alice" },
      repo: "team/a",
      repositoryId: 101,
      title: "Activity",
      occurredAt: "2026-09-15T10:00:00.000Z",
    }));
    for (const [i, login] of [
      " DEPENDABOT ",
      "robot[bot]",
      "custom-bot",
      "\t github-actions \u00a0",
      " \u2000",
    ].entries())
      events.push({ ...events[0], id: `bot-${i}`, actor: { login } });
    events.push(
      { ...events[0], id: "bot", actor: { login: "renovate" } },
      { ...events[0], id: "note", type: "note" },
      { ...events[0], id: "alert", type: "alert" },
      { ...events[0], id: "private", repositoryId: 102, repo: "team/b" },
      { ...events[0], id: "future", occurredAt: "2026-09-15T13:00:00Z" },
      { ...events[0], id: "before", occurredAt: "2026-09-08T23:59:59.999Z" },
      { ...events[0], id: "boundary", occurredAt: range.start },
    );
    await store.merge("installation-70", events, { restricted: true });
    await store.merge(
      "installation-71",
      [events[0], { ...events[0], id: "other" }],
      {
        restricted: true,
      },
    );
    const pulse = new PulseStore(store.pool);
    const result = await pulse.overview(70, [101], range, now);
    const expected = aggregatePulse(
      events.filter((e) => e.repositoryId === 101),
      range,
      now,
    );
    expected.coverage.sourceSync = {
      lastSyncedAt: null,
      syncedRepositories: 0,
      totalRepositories: 1,
    };
    expected.comparison!.previous.coverage = expected.coverage;
    assert.deepEqual(result, expected);
    assert.equal(result.totals.count, 2106);
    const scope = {
      sources: [
        { installationId: 70, repositoryIds: [101] },
        { installationId: 71, repositoryIds: [101] },
      ],
      author: "alice",
    };
    const full = await pulse.events(scope, range, now);
    assert.equal(
      full.length,
      2107,
      "dashboard reads all selected events across installations",
    );
    assert.ok(
      !full.some(
        (event) =>
          event.id === "before" ||
          event.id === "private" ||
          event.id === "future" ||
          event.type === "note",
      ),
    );
    assert.equal(
      (await pulse.overview(undefined, [], range, now, scope)).totals.count,
      2107,
    );
    assert.equal(
      (await pulse.events({ ...scope, author: "bob" }, range, now)).length,
      0,
    );
    const scopedPage = await pulse.activity(
      undefined,
      [],
      range,
      undefined,
      undefined,
      now,
      scope,
    );
    assert.ok(scopedPage.nextCursor);
    const scopedIds = scopedPage.events.map((event) => event.id);
    let scopedCursor: string | null = scopedPage.nextCursor;
    while (scopedCursor) {
      const page = await pulse.activity(
        undefined,
        [],
        range,
        undefined,
        scopedCursor,
        now,
        scope,
      );
      scopedIds.push(...page.events.map((event) => event.id));
      scopedCursor = page.nextCursor;
    }
    assert.equal(
      scopedIds.length,
      2107,
      "duplicate normalized events across installations count once",
    );
    assert.equal(
      new Set(scopedIds).size,
      2107,
      "duplicate source rows cannot cross or disappear at cursor boundaries",
    );

    await assert.rejects(
      pulse.activity(
        undefined,
        [],
        range,
        undefined,
        scopedPage.nextCursor!,
        now,
        { ...scope, author: "bob" },
      ),
      /Invalid activity cursor/,
    );
    await assert.rejects(
      pulse.activity(
        undefined,
        [],
        range,
        undefined,
        scopedPage.nextCursor!,
        now,
        { ...scope, sources: scope.sources.slice(0, 1) },
      ),
      /Invalid activity cursor/,
    );

    const weeklyRange = resolvePulseRange(
      { period: "custom", from: "2026-08-01", to: "2026-09-15" },
      now,
    );
    const weeklyExpected = aggregatePulse(
      events.filter((e) => e.repositoryId === 101),
      weeklyRange,
      now,
    );
    weeklyExpected.coverage.sourceSync = expected.coverage.sourceSync;
    weeklyExpected.comparison!.previous.coverage = weeklyExpected.coverage;
    assert.deepEqual(
      await pulse.overview(70, [101], weeklyRange, now),
      weeklyExpected,
    );
    const emptyRange = resolvePulseRange(
      { period: "custom", from: "2026-08-01", to: "2026-08-01" },
      now,
    );
    assert.equal(
      (await pulse.overview(70, [101], emptyRange, now)).buckets[0].count,
      0,
    );
    const exactRange = resolvePulseRange(
      { period: "custom", from: "2026-09-09", to: "2026-09-14" },
      now,
    );
    assert.equal(
      (await pulse.overview(70, [101], exactRange, now)).totals.count,
      1,
    );
    assert.equal(
      (await pulse.activity(70, [101], range, "team/b", undefined, now)).events
        .length,
      0,
    );
    const plan = await store.pool.query(
      "EXPLAIN SELECT count(*) FROM ship_live_events WHERE organization=$1 AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz",
      ["installation-70", range.start, range.end],
    );
    t.diagnostic(plan.rows.map((row) => row["QUERY PLAN"]).join("\n"));

    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await pulse.activity(
        70,
        [101],
        range,
        undefined,
        cursor,
        now,
      );
      assert.ok(page.events.length <= 100);
      ids.push(...page.events.map((e) => e.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(ids.length, 2106);
    assert.equal(new Set(ids).size, 2106);
    const first = await pulse.activity(
      70,
      [101],
      range,
      undefined,
      undefined,
      now,
    );
    await assert.rejects(
      pulse.activity(70, [101], range, "team/a", first.nextCursor!, now),
      /cursor/i,
    );
    await assert.rejects(
      pulse.activity(70, [101], range, undefined, "bad", now),
      /cursor/i,
    );
    await assert.rejects(
      pulse.activity(71, [101], range, undefined, first.nextCursor!, now),
      /cursor/i,
    );
    await assert.rejects(
      pulse.activity(70, [101, 102], range, undefined, first.nextCursor!, now),
      /cursor/i,
    );
    await assert.rejects(
      pulse.activity(70, [101], emptyRange, undefined, first.nextCursor!, now),
      /cursor/i,
    );
    const tampered = JSON.parse(
      Buffer.from(first.nextCursor!, "base64url").toString(),
    );
    tampered.cutoff = "2026-09-16T00:00:00Z";
    await assert.rejects(
      pulse.activity(
        70,
        [101],
        range,
        undefined,
        Buffer.from(JSON.stringify(tampered)).toString("base64url"),
        now,
      ),
      /cursor/i,
    );
    const later = await pulse.activity(
      70,
      [101],
      range,
      undefined,
      first.nextCursor!,
      now + 7200000,
    );
    assert.ok(
      later.events.every((event) => Date.parse(event.occurredAt) <= now),
    );
  } finally {
    await store.close();
  }
});

test("coverage counts only selected repository imports and keeps personal history scoped", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const store = await PostgresEventStore.open(url);
  try {
    const now = Date.parse("2026-09-15T12:00:00Z");
    const pulse = new PulseStore(store.pool);
    const range = resolvePulseRange({ period: "today" }, now);
    await store.pool.query(`INSERT INTO ship_live_repository_sync VALUES
      (70,101,'2026-09-14T09:00:00Z'), (70,999,'2026-09-15T11:00:00Z'),
      (71,101,'2026-09-15T10:00:00Z')`);
    await store.merge(
      "installation-70",
      [
        {
          id: "alice",
          type: "merge",
          actor: { login: "alice" },
          repo: "team/a",
          repositoryId: 101,
          title: "Alice",
          occurredAt: "2026-09-01T10:00:00Z",
        },
        {
          id: "bob",
          type: "merge",
          actor: { login: "bob" },
          repo: "team/a",
          repositoryId: 101,
          title: "Bob",
          occurredAt: "2026-08-01T10:00:00Z",
        },
      ],
      { restricted: true },
    );
    const result = await pulse.overview(undefined, [], range, now, {
      sources: [{ installationId: 70, repositoryIds: [101, 102] }],
      author: "alice",
    });
    assert.equal(result.totals.count, 0);
    assert.equal(result.coverage.earliestStoredAt, "2026-09-01T10:00:00.000Z");
    assert.deepEqual(result.coverage.sourceSync, {
      lastSyncedAt: "2026-09-14T09:00:00.000Z",
      syncedRepositories: 1,
      totalRepositories: 2,
    });
    const empty = await pulse.overview(70, [102], range, now);
    assert.equal(empty.coverage.earliestStoredAt, null);
    assert.deepEqual(empty.coverage.sourceSync, {
      lastSyncedAt: null,
      syncedRepositories: 0,
      totalRepositories: 1,
    });
    const unconnected = await pulse.overview(undefined, [], range, now);
    assert.deepEqual(unconnected.coverage.sourceSync, {
      lastSyncedAt: null,
      syncedRepositories: 0,
      totalRepositories: 0,
    });
  } finally {
    await store.close();
  }
});

test("comparison aggregates full previous history with the same repository and author scope", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const store = await PostgresEventStore.open(url);
  try {
    const now = Date.parse("2026-09-15T12:00:00Z");
    const range = resolvePulseRange({ period: "today" }, now);
    const events: ActivityEvent[] = Array.from({ length: 2105 }, (_, i) => ({
      id: `previous-${i}`,
      type: "merge",
      actor: { login: i % 2 ? "alice" : "Alice" },
      repo: "team/a",
      repositoryId: 101,
      title: "Previous merge",
      occurredAt: "2026-09-14T10:00:00Z",
    }));
    events.push(
      { ...events[0], id: "current", type: "review", occurredAt: range.start },
      {
        ...events[0],
        id: "private",
        repositoryId: 102,
        actor: { login: "secret" },
      },
      { ...events[0], id: "bob", actor: { login: "bob" } },
      { ...events[0], id: "too-early", occurredAt: "2026-09-13T23:59:59Z" },
    );
    await store.merge("installation-70", events, { restricted: true });
    await store.merge("installation-71", [events[0]], { restricted: true });
    const result = await new PulseStore(store.pool).overview(
      undefined,
      [],
      range,
      now,
      {
        sources: [
          { installationId: 70, repositoryIds: [101] },
          { installationId: 71, repositoryIds: [101] },
        ],
        author: "alice",
      },
    );
    assert.equal(result.comparison?.previous.totals.merges, 2105);
    assert.equal(result.comparison?.previous.participants, 1);
    assert.equal(result.comparison?.currentParticipants, 1);
    assert.equal(result.comparison?.currentIncomplete, true);
    assert.deepEqual(result.comparison?.previous.coverage, result.coverage);
    assert.equal(result.totals.reviews, 1);
  } finally {
    await store.close();
  }
});

test("activity kind filters before pagination and binds cursors to that kind", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const store = await PostgresEventStore.open(url);
  try {
    const now = Date.parse("2026-09-15T12:00:00Z");
    const range = resolvePulseRange({ period: "today" }, now);
    const events: ActivityEvent[] = Array.from({ length: 205 }, (_, i) => ({
      id: `kind-${String(i).padStart(4, "0")}`,
      type: i % 2 ? "merge" : "review",
      actor: { login: "alice" },
      repo: "team/a",
      repositoryId: 101,
      title: "Contribution",
      occurredAt: "2026-09-15T10:00:00Z",
    }));
    await store.merge("installation-70", events, { restricted: true });
    const pulse = new PulseStore(store.pool);
    const first = await pulse.activity(
      70,
      [101],
      range,
      undefined,
      undefined,
      now,
      undefined,
      "review",
    );
    assert.equal(first.events.length, 100);
    assert.ok(first.events.every((event) => event.type === "review"));
    assert.ok(first.nextCursor);
    const second = await pulse.activity(
      70,
      [101],
      range,
      undefined,
      first.nextCursor,
      now,
      undefined,
      "review",
    );
    assert.equal(second.events.length, 3);
    assert.ok(second.events.every((event) => event.type === "review"));
    await assert.rejects(
      pulse.activity(
        70,
        [101],
        range,
        undefined,
        first.nextCursor,
        now,
        undefined,
        "merge",
      ),
      /cursor/i,
    );
    await assert.rejects(
      pulse.activity(70, [101], range, undefined, first.nextCursor, now),
      /cursor/i,
    );
  } finally {
    await store.close();
  }
});

test("pulse query accepts only supported contribution kinds", async () => {
  const { pulseQuery } = await import("./pulse-store.js");
  assert.equal(pulseQuery({ kind: "review" }).kind, "review");
  assert.equal(pulseQuery({ kind: "contribution" }).kind, "contribution");
  for (const kind of ["note", "bad", ["merge"], ""])
    assert.throws(() => pulseQuery({ kind }), /kind/);
});

test("participant contribution drilldown excludes personal notes without removing generic journal history", async (t) => {
  const url = await createTestDatabase(t);
  if (!url) return;
  const store = await PostgresEventStore.open(url);
  try {
    const now = Date.parse("2026-09-15T12:00:00Z");
    const range = resolvePulseRange({ period: "today" }, now);
    const user = (
      await store.pool.query(
        "INSERT INTO ship_live_auth_users(id,name) VALUES(gen_random_uuid(),'Alice') RETURNING id",
      )
    ).rows[0].id;
    const workspace = (
      await store.pool.query(
        "INSERT INTO ship_live_workspaces(id,name,kind,owner_user_id) VALUES(gen_random_uuid(),'Journal','personal',$1) RETURNING id",
        [user],
      )
    ).rows[0].id;
    await store.pool.query(
      "INSERT INTO ship_live_notes(id,workspace_id,user_id,title,body,created_at) VALUES(gen_random_uuid(),$1,$2,'Private note','', $3)",
      [workspace, user, range.start],
    );
    await store.merge(
      "installation-70",
      [
        {
          id: "push",
          type: "push",
          actor: { login: "alice" },
          repo: "team/a",
          repositoryId: 101,
          title: "Push",
          occurredAt: range.start,
        },
      ],
      { restricted: true },
    );
    const scope = {
      sources: [{ installationId: 70, repositoryIds: [101] }],
      noteUserId: user,
      workspaceId: workspace,
      ownerLogin: "alice",
    };
    const pulse = new PulseStore(store.pool);
    const generic = await pulse.activity(
      undefined,
      [],
      range,
      undefined,
      undefined,
      now,
      scope,
    );
    assert.equal(generic.events.length, 2);
    const contributions = await pulse.activity(
      undefined,
      [],
      range,
      undefined,
      undefined,
      now,
      scope,
      "contribution",
    );
    assert.deepEqual(
      contributions.events.map((event) => event.type),
      ["push"],
    );
  } finally {
    await store.close();
  }
});
