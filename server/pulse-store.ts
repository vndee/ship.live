import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { ActivityEvent } from "../shared/types.js";
import {
  aggregatePulse,
  resolvePulseRange,
  type PulseRange,
  type PulseSelection,
  type PulseOverview,
  type PulseActivityPage,
  type PulseCounts,
} from "../shared/pulse.js";
import { AuthError } from "./auth.js";
import { retentionFromEnv } from "./runtime-config.js";

// Match JavaScript trim(), including Unicode whitespace, before the existing bot rule.
const whitespace = [
  9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198,
  8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279,
]
  .map((c) => `chr(${c})`)
  .join(" || ");
const actor = `lower(btrim(event #>> '{actor,login}', ${whitespace}))`;
const eligible = `organization = $1 AND event->>'repositoryId' = ANY($2::text[])
 AND event->>'type' <> 'note' AND ${actor} <> ''
 AND ${actor} !~ '(\\[bot\\]|-bot)$' AND ${actor} NOT IN ('dependabot','renovate','github-actions')`;
const counts = `count(*)::int AS count, count(*) FILTER (WHERE event->>'type'='merge')::int AS merges, count(*) FILTER (WHERE event->>'type'='review')::int AS reviews, count(*) FILTER (WHERE event->>'type'='release')::int AS releases`;
export function pulseQuery(query: Record<string, unknown>, now = Date.now()) {
  const read = (name: string) => {
    const value = query[name];
    if (value !== undefined && typeof value !== "string")
      throw new AuthError(400, `Invalid ${name}.`);
    return value as string | undefined;
  };
  try {
    return {
      range: resolvePulseRange(
        {
          period: read("period") as PulseSelection["period"],
          from: read("from"),
          to: read("to"),
        },
        now,
      ),
      repo: read("repo"),
      cursor: read("cursor"),
    };
  } catch (error) {
    throw new AuthError(
      400,
      error instanceof Error ? error.message : "Invalid range.",
    );
  }
}
export function samePulseScope(
  initial: { installationId?: number; repositoryIds: number[] },
  current: { installationId?: number; repositoryIds: number[] },
) {
  return (
    initial.installationId === current.installationId &&
    initial.repositoryIds.length === current.repositoryIds.length &&
    initial.repositoryIds.every((id) => current.repositoryIds.includes(id))
  );
}
interface Cursor {
  version: 1;
  binding: string;
  cutoff: string;
  at: string;
  id: string;
}
/** SQL aggregates the entire authorized range; only drill-down pages are bounded. */
export class PulseStore {
  constructor(private readonly pool: Pool) {}
  async overview(
    installation: number | undefined,
    repositoryIds: number[],
    range: PulseRange,
    now = Date.now(),
  ): Promise<PulseOverview> {
    const result = aggregatePulse([], range, now);
    result.coverage.retentionDays =
      retentionFromEnv(process.env).eventDays || null;
    if (!installation || !repositoryIds.length) return result;
    const params = [
      `installation-${installation}`,
      repositoryIds.map(String),
      range.start,
      range.end,
      new Date(now).toISOString(),
    ];
    // GROUPING SETS returns total, bucket, and repository summaries in one scan.
    const rows = await this.pool.query<
      PulseCounts & {
        bucket: string | null;
        repo: string | null;
        is_bucket: number;
        is_repo: number;
      }
    >(
      `WITH scoped AS (SELECT event, to_char(date_trunc('${range.granularity}', occurred_at AT TIME ZONE 'UTC'),'YYYY-MM-DD') AS bucket, event->>'repo' AS repo FROM ship_live_events WHERE ${eligible} AND occurred_at >= $3::timestamptz AND occurred_at < $4::timestamptz AND occurred_at <= $5::timestamptz)
   SELECT bucket,repo,grouping(bucket) AS is_bucket,grouping(repo) AS is_repo,${counts} FROM scoped GROUP BY GROUPING SETS ((),(bucket),(repo))`,
      params,
    );
    for (const row of rows.rows) {
      const values = {
        count: row.count,
        merges: row.merges,
        reviews: row.reviews,
        releases: row.releases,
      };
      if (row.is_bucket === 1 && row.is_repo === 1) result.totals = values;
      else if (row.is_repo === 0 && row.repo !== null)
        result.repositories.push({ repo: row.repo, ...values });
      else if (row.bucket) {
        const key = row.bucket < range.from ? range.from : row.bucket;
        const bucket = result.buckets.find((b) => b.from === key);
        if (bucket) Object.assign(bucket, values);
      }
    }
    result.repositories.sort(
      (a, b) => b.count - a.count || a.repo.localeCompare(b.repo),
    );
    const coverage = await this.pool.query<{ earliest: Date | null }>(
      `SELECT min(occurred_at) AS earliest FROM ship_live_events WHERE ${eligible} AND occurred_at <= $3::timestamptz`,
      [params[0], params[1], params[4]],
    );
    result.coverage.earliestStoredAt =
      coverage.rows[0].earliest?.toISOString() ?? null;
    return result;
  }
  async activity(
    installation: number | undefined,
    repositoryIds: number[],
    range: PulseRange,
    repo?: string,
    cursor?: string,
    now = Date.now(),
  ): Promise<PulseActivityPage> {
    const binding = createHash("sha256")
      .update(
        JSON.stringify([
          installation ?? null,
          [...repositoryIds].sort((a, b) => a - b),
          range.start,
          range.end,
          repo ?? null,
        ]),
      )
      .digest("hex");
    let position: Cursor | undefined;
    if (cursor !== undefined) {
      try {
        if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor))
          throw new Error();
        position = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (
          !position ||
          position.version !== 1 ||
          position.binding !== binding ||
          typeof position.id !== "string" ||
          !position.id ||
          position.id.length > 1024 ||
          typeof position.at !== "string" ||
          typeof position.cutoff !== "string"
        )
          throw new Error();
        const at = Date.parse(position.at),
          cutoff = Date.parse(position.cutoff);
        if (
          !Number.isFinite(at) ||
          !Number.isFinite(cutoff) ||
          cutoff > now ||
          at > cutoff ||
          at < Date.parse(range.start) ||
          at >= Date.parse(range.end)
        )
          throw new Error();
      } catch {
        throw new AuthError(
          400,
          "Invalid activity cursor. Reload this date range.",
        );
      }
    }
    if (!installation || !repositoryIds.length)
      return { events: [], nextCursor: null };
    const cutoff = position?.cutoff ?? new Date(now).toISOString();
    const rows = await this.pool.query<{
      event: ActivityEvent;
      at: string;
      event_id: string;
    }>(
      `SELECT event - 'body' AS event, to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,event_id FROM ship_live_events WHERE ${eligible}
   AND occurred_at >= $3::timestamptz AND occurred_at < $4::timestamptz AND occurred_at <= $5::timestamptz
   AND ($6::text IS NULL OR event->>'repo'=$6)
   AND ($7::timestamptz IS NULL OR (occurred_at,event_id) < ($7::timestamptz,$8::text))
   ORDER BY occurred_at DESC,event_id DESC LIMIT 101`,
      [
        `installation-${installation}`,
        repositoryIds.map(String),
        range.start,
        range.end,
        cutoff,
        repo ?? null,
        position?.at ?? null,
        position?.id ?? null,
      ],
    );
    const page = rows.rows.slice(0, 100);
    const last = page.at(-1);
    return {
      events: page.map((row) => row.event),
      nextCursor:
        rows.rows.length > 100 && last
          ? Buffer.from(
              JSON.stringify({
                version: 1,
                binding,
                cutoff,
                at: last.at,
                id: last.event_id,
              } satisfies Cursor),
            ).toString("base64url")
          : null,
    };
  }
}
