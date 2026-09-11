import { createHash } from "node:crypto";
import type { Pool } from "pg";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** When the current window ends, in epoch milliseconds. */
  resetAt: number;
}
export interface RateLimiter {
  hit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult>;
}

const result = (
  hits: number,
  limit: number,
  resetAt: number,
): RateLimitResult => ({
  allowed: hits <= limit,
  limit,
  remaining: Math.max(0, limit - hits),
  resetAt,
});

/** Fixed windows aligned to the clock, counted in this process only. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { hits: number; reset: number }>();
  constructor(
    private readonly maxKeys = 10_000,
    private readonly now: () => number = Date.now,
  ) {}
  async hit(key: string, limit: number, windowSeconds: number) {
    const now = this.now();
    const windowMs = windowSeconds * 1000;
    let current = this.windows.get(key);
    if (!current || current.reset <= now) {
      current = { hits: 0, reset: (Math.floor(now / windowMs) + 1) * windowMs };
      this.windows.delete(key);
      this.windows.set(key, current);
      if (this.windows.size > this.maxKeys)
        this.windows.delete(this.windows.keys().next().value!);
    }
    current.hits += 1;
    return result(current.hits, limit, current.reset);
  }
}

// Buckets are hashed so client addresses are not stored in the table.
const bucket = (key: string) =>
  createHash("sha256").update(key).digest("base64url").slice(0, 32);

/**
 * Fixed windows counted in PostgreSQL on the database clock, so every replica
 * enforces one limit per client. Rows are overwritten each window and pruned
 * by the retention job. If the database is unreachable, limits fall back to
 * this process until it recovers.
 */
export class PostgresRateLimiter implements RateLimiter {
  private reportedAt = 0;
  constructor(
    private readonly pool: Pool,
    private readonly onError: (error: unknown) => void = () => {},
    private readonly fallback: RateLimiter = new MemoryRateLimiter(),
  ) {}
  async hit(key: string, limit: number, windowSeconds: number) {
    try {
      const { rows } = await this.pool.query<{
        hits: number;
        reset_at: string;
      }>(
        `INSERT INTO ship_live_rate_limits AS l (bucket, window_start, hits)
         VALUES ($1, to_timestamp(floor(extract(epoch FROM clock_timestamp()) / $2::integer) * $2::integer), 1)
         ON CONFLICT (bucket) DO UPDATE SET
           hits = CASE WHEN l.window_start = EXCLUDED.window_start THEN l.hits + 1 ELSE 1 END,
           window_start = EXCLUDED.window_start
         RETURNING l.hits, floor((extract(epoch FROM l.window_start) + $2::integer) * 1000)::text AS reset_at`,
        [bucket(key), windowSeconds],
      );
      return result(rows[0].hits, limit, Number(rows[0].reset_at));
    } catch (error) {
      if (Date.now() - this.reportedAt > 60_000) {
        this.reportedAt = Date.now();
        this.onError(error);
      }
      return this.fallback.hit(key, limit, windowSeconds);
    }
  }
}
