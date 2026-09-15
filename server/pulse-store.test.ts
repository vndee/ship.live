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
    assert.deepEqual(
      await pulse.overview(70, [101], weeklyRange, now),
      aggregatePulse(
        events.filter((e) => e.repositoryId === 101),
        weeklyRange,
        now,
      ),
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
