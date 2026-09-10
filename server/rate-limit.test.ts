import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { Pool } from "pg";
import { PostgresEventStore } from "./postgres-store.js";
import { MemoryRateLimiter, PostgresRateLimiter } from "./rate-limit.js";
import { createTestDatabase } from "./test-database.js";

test("the memory limiter counts clock-aligned windows per key", async () => {
  let now = 125_000;
  const limiter = new MemoryRateLimiter(10_000, () => now);
  assert.deepEqual(await limiter.hit("api:a", 2, 60), {
    allowed: true,
    limit: 2,
    remaining: 1,
    resetAt: 180_000,
  });
  await limiter.hit("api:a", 2, 60);
  assert.equal((await limiter.hit("api:a", 2, 60)).allowed, false);
  assert.equal((await limiter.hit("api:b", 2, 60)).allowed, true);
  now = 180_000;
  assert.deepEqual(await limiter.hit("api:a", 2, 60), {
    allowed: true,
    limit: 2,
    remaining: 1,
    resetAt: 240_000,
  });
});

test("the memory limiter forgets the oldest key beyond its capacity", async () => {
  const limiter = new MemoryRateLimiter(2, () => 0);
  await limiter.hit("a", 1, 60);
  await limiter.hit("b", 1, 60);
  await limiter.hit("c", 1, 60);
  assert.equal((await limiter.hit("a", 1, 60)).allowed, true);
  assert.equal((await limiter.hit("c", 1, 60)).allowed, false);
});

test("PostgreSQL limits share one count across replicas without storing addresses", async (t) => {
  const database = await createTestDatabase(t);
  if (!database) return;
  // Stay inside one window: wait out the last seconds of a minute.
  const intoMinute = Date.now() % 60_000;
  if (intoMinute > 55_000) await delay(60_500 - intoMinute);
  const first = await PostgresEventStore.open(database);
  const second = await PostgresEventStore.open(database);
  try {
    const a = new PostgresRateLimiter(first.pool);
    const b = new PostgresRateLimiter(second.pool);
    const results = [];
    for (const limiter of [a, b, a, b])
      results.push(await limiter.hit("api:203.0.113.7", 3, 60));
    assert.deepEqual(
      results.map(({ allowed, remaining }) => [allowed, remaining]),
      [
        [true, 2],
        [true, 1],
        [true, 0],
        [false, 0],
      ],
    );
    assert.equal(results[0].resetAt % 60_000, 0);
    assert.ok(Math.abs(results[0].resetAt - Date.now()) <= 61_000);
    assert.equal((await a.hit("api:198.51.100.2", 3, 60)).remaining, 2);
    const stored = await first.pool.query<{ bucket: string }>(
      "SELECT bucket FROM ship_live_rate_limits",
    );
    assert.equal(stored.rowCount, 2);
    assert.ok(stored.rows.every(({ bucket }) => !/\d+\.\d+/.test(bucket)));
    // The next window starts a fresh count for the same client.
    await first.pool.query(
      "UPDATE ship_live_rate_limits SET window_start = window_start - interval '1 minute'",
    );
    assert.equal((await b.hit("api:203.0.113.7", 3, 60)).remaining, 2);
  } finally {
    await first.close();
    await second.close();
  }
});

test("PostgreSQL limits fall back to this process and report the outage once", async () => {
  const errors: unknown[] = [];
  const pool = {
    query: async () => {
      throw new Error("connection refused");
    },
  } as unknown as Pool;
  const limiter = new PostgresRateLimiter(pool, (error) => errors.push(error));
  assert.equal((await limiter.hit("api:x", 1, 60)).allowed, true);
  assert.equal((await limiter.hit("api:x", 1, 60)).allowed, false);
  assert.equal(errors.length, 1);
});
