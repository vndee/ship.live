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
  type PulseActivityKind,
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
const eligible = `EXISTS (SELECT 1 FROM jsonb_each($1::jsonb) AS source(organization, repositories) WHERE source.organization = ship_live_events.organization AND event->>'repositoryId' = ANY(ARRAY(SELECT jsonb_array_elements_text(source.repositories))))
 AND ($2::text IS NULL OR lower(event #>> '{actor,login}') = $2)
 AND event->>'type' NOT IN ('note','alert') AND ${actor} <> ''
 AND ${actor} !~ '(\\[bot\\]|-bot)$' AND ${actor} NOT IN ('dependabot','renovate','github-actions')`;
// GitHub can deliver the same normalized event through multiple installations.
// Pick one deterministic row before aggregates and keyset boundaries are formed.
const scopedEvents = `SELECT DISTINCT ON (event_id) event,occurred_at,event_id
 FROM ship_live_events WHERE ${eligible} ORDER BY event_id,occurred_at DESC,organization`;
const counts = `count(*)::int AS count, count(*) FILTER (WHERE event->>'type'='merge')::int AS merges, count(*) FILTER (WHERE event->>'type'='review')::int AS reviews, count(*) FILTER (WHERE event->>'type'='release')::int AS releases`;
export function pulseQuery(query: Record<string, unknown>, now = Date.now()) {
  const read = (name: string) => {
    const value = query[name];
    if (value !== undefined && typeof value !== "string")
      throw new AuthError(400, `Invalid ${name}.`);
    return value as string | undefined;
  };
  try {
    const kind = read("kind");
    if (
      kind !== undefined &&
      !["merge", "review", "release", "contribution"].includes(kind)
    )
      throw new Error("Invalid kind.");
    return {
      kind: kind as PulseActivityKind | undefined,
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
export interface PulseScope {
  sources: { installationId: number; repositoryIds: number[] }[];
  author?: string;
  ownerLogin?: string;
  workspaceId?: string;
  noteUserId?: string;
}
export function samePulseReadScope(initial: PulseScope, current: PulseScope) {
  return scopeBinding(initial) === scopeBinding(current);
}
export function pulseScopeFingerprint(scope: PulseScope): string {
  return createHash("sha256").update(scopeBinding(scope)).digest("hex");
}
function scopeBinding(scope: PulseScope) {
  return JSON.stringify([
    scope.sources
      .map((s) => [
        s.installationId,
        [...s.repositoryIds].sort((a, b) => a - b),
      ])
      .sort((a, b) => Number(a[0]) - Number(b[0])),
    scope.author ?? null,
    scope.ownerLogin ?? null,
    scope.workspaceId ?? null,
    scope.noteUserId ?? null,
  ]);
}
function readScope(
  installation: number | undefined,
  repositoryIds: number[],
  scope?: PulseScope,
): PulseScope {
  return (
    scope ?? {
      sources: installation
        ? [{ installationId: installation, repositoryIds }]
        : [],
    }
  );
}
function scopeParams(scope: PulseScope) {
  return [
    JSON.stringify(
      Object.fromEntries(
        scope.sources.map((s) => [
          `installation-${s.installationId}`,
          s.repositoryIds.map(String),
        ]),
      ),
    ),
    scope.author ?? null,
  ];
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
  /** Full period read for every dashboard tab; never inherits the feed limit. */
  async events(
    scope: PulseScope,
    range: PulseRange,
    now = Date.now(),
  ): Promise<ActivityEvent[]> {
    if (!scope.sources.some((s) => s.repositoryIds.length)) return [];
    const rows = await this.pool.query<{ event: ActivityEvent }>(
      `WITH events AS (${scopedEvents}) SELECT event - 'body' AS event FROM events WHERE occurred_at >= $3::timestamptz AND occurred_at < $4::timestamptz AND occurred_at <= $5::timestamptz
       ORDER BY occurred_at DESC,event_id DESC`,
      [
        ...scopeParams(scope),
        range.start,
        range.end,
        new Date(now).toISOString(),
      ],
    );
    return rows.rows.map((row) => row.event);
  }
  /** Caller must authorize ownership before this read and recheck afterward. */
  async alerts(
    workspaceId: string,
    range: PulseRange,
    now = Date.now(),
  ): Promise<ActivityEvent[]> {
    const rows = await this.pool.query<{
      id: string;
      type: string;
      at: Date;
      payload: {
        summary?: string;
        url?: string;
        data?: { endpoint?: { name?: string }; body?: string };
      };
    }>(
      `SELECT id,type,payload,coalesce((payload->>'occurredAt')::timestamptz,created_at) AS at FROM ship_live_webhook_events
       WHERE workspace_id=$1 AND type LIKE 'inbound.%'
       AND coalesce((payload->>'occurredAt')::timestamptz,created_at) >= $2::timestamptz
       AND coalesce((payload->>'occurredAt')::timestamptz,created_at) < $3::timestamptz
       AND coalesce((payload->>'occurredAt')::timestamptz,created_at) <= $4::timestamptz
       ORDER BY at DESC,id`,
      [workspaceId, range.start, range.end, new Date(now).toISOString()],
    );
    return rows.rows.map((row) => ({
      id: "alert:" + row.id,
      type: "alert",
      actor: { login: row.payload.data?.endpoint?.name || "Inbound webhook" },
      repo: row.type,
      title: row.payload.summary ?? "",
      occurredAt: row.at.toISOString(),
      ...(row.payload.url ? { url: row.payload.url } : {}),
      ...(row.payload.data?.body ? { body: row.payload.data.body } : {}),
    }));
  }
  async notes(
    userId: string,
    workspaceId: string,
    ownerLogin: string | undefined,
    range: PulseRange,
    now = Date.now(),
  ): Promise<ActivityEvent[]> {
    const rows = await this.pool.query<{
      id: string;
      name: string;
      title: string;
      body: string;
      created_at: Date;
    }>(
      `SELECT n.*,u.name FROM ship_live_notes n JOIN ship_live_auth_users u ON u.id=n.user_id
       WHERE n.workspace_id=$1 AND n.user_id=$2 AND n.created_at >= $3::timestamptz AND n.created_at < $4::timestamptz AND n.created_at <= $5::timestamptz
       ORDER BY n.created_at DESC,n.id`,
      [
        workspaceId,
        userId,
        range.start,
        range.end,
        new Date(now).toISOString(),
      ],
    );
    return rows.rows.map((row) => ({
      id: "note-" + row.id,
      type: "note",
      actor: { login: ownerLogin ?? row.name },
      repo: "journal/notes",
      title: row.title,
      body: row.body,
      occurredAt: row.created_at.toISOString(),
    }));
  }
  async overview(
    installation: number | undefined,
    repositoryIds: number[],
    range: PulseRange,
    now = Date.now(),
    selectedScope?: PulseScope,
  ): Promise<PulseOverview> {
    const result = aggregatePulse([], range, now);
    result.coverage.retentionDays =
      retentionFromEnv(process.env).eventDays || null;
    const scope = readScope(installation, repositoryIds, selectedScope);
    result.coverage.sourceSync = {
      lastSyncedAt: null,
      syncedRepositories: 0,
      totalRepositories: 0,
    };
    result.comparison!.previous.coverage = result.coverage;
    if (!scope.sources.some((s) => s.repositoryIds.length)) return result;
    const params = [
      ...scopeParams(scope),
      range.start,
      range.end,
      new Date(now).toISOString(),
    ];
    params.push(result.comparison!.previous.range.start);
    // Aggregate both periods from the same authorized, deduplicated history.
    const rows = await this.pool.query<
      PulseCounts & {
        period: "current" | "previous";
        participants: number;
        bucket: string | null;
        repo: string | null;
        is_bucket: number;
        is_repo: number;
      }
    >(
      `WITH events AS (${scopedEvents}), scoped AS (SELECT event, CASE WHEN occurred_at >= $3::timestamptz THEN 'current' ELSE 'previous' END AS period, to_char(date_trunc('${range.granularity}', occurred_at AT TIME ZONE 'UTC'),'YYYY-MM-DD') AS bucket, event->>'repo' AS repo FROM events WHERE occurred_at >= $6::timestamptz AND occurred_at < $4::timestamptz AND occurred_at <= $5::timestamptz)
   SELECT period,bucket,repo,grouping(bucket) AS is_bucket,grouping(repo) AS is_repo,${counts}, count(DISTINCT ${actor})::int AS participants FROM scoped GROUP BY GROUPING SETS ((period),(period,bucket),(period,repo))`,
      params,
    );
    for (const row of rows.rows) {
      const values = {
        count: row.count,
        merges: row.merges,
        reviews: row.reviews,
        releases: row.releases,
      };
      if (row.period === "previous") {
        if (row.is_bucket === 1 && row.is_repo === 1) {
          result.comparison!.previous.totals = values;
          result.comparison!.previous.participants = row.participants;
        }
        continue;
      }
      if (row.is_bucket === 1 && row.is_repo === 1) {
        result.totals = values;
        result.comparison!.currentParticipants = row.participants;
      } else if (row.is_repo === 0 && row.repo !== null)
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
      `WITH events AS (${scopedEvents}) SELECT min(occurred_at) AS earliest FROM events WHERE occurred_at <= $3::timestamptz`,
      [params[0], params[1], params[4]],
    );
    result.coverage.earliestStoredAt =
      coverage.rows[0].earliest?.toISOString() ?? null;
    const sync = await this.pool.query<{
      latest: Date | null;
      synced: number;
      total: number;
    }>(
      `WITH selected AS (
         SELECT DISTINCT (source->>'installationId')::bigint AS installation_id,
           repository_id::bigint AS repository_id
         FROM jsonb_array_elements($1::jsonb) source,
           jsonb_array_elements_text(source->'repositoryIds') repository_id
       )
       SELECT max(s.synced_at) AS latest, count(s.synced_at)::int AS synced,
         count(*)::int AS total FROM selected r
       LEFT JOIN ship_live_repository_sync s USING (installation_id, repository_id)`,
      [JSON.stringify(scope.sources)],
    );
    result.coverage.sourceSync = {
      lastSyncedAt: sync.rows[0].latest?.toISOString() ?? null,
      syncedRepositories: sync.rows[0].synced,
      totalRepositories: sync.rows[0].total,
    };
    return result;
  }
  async activity(
    installation: number | undefined,
    repositoryIds: number[],
    range: PulseRange,
    repo?: string,
    cursor?: string,
    now = Date.now(),
    selectedScope?: PulseScope,
    kind?: PulseActivityKind,
  ): Promise<PulseActivityPage> {
    const scope = readScope(installation, repositoryIds, selectedScope);
    const binding = createHash("sha256")
      .update(
        JSON.stringify([
          scopeBinding(scope),
          range.start,
          range.end,
          repo ?? null,
          kind ?? null,
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
    if (
      !scope.sources.some((s) => s.repositoryIds.length) &&
      !(scope.noteUserId && !repo)
    )
      return { events: [], nextCursor: null };
    const cutoff = position?.cutoff ?? new Date(now).toISOString();
    const rows = await this.pool.query<{
      event: ActivityEvent;
      at: string;
      event_id: string;
    }>(
      `WITH activity AS (
     SELECT event,occurred_at,event_id FROM (${scopedEvents}) eligible_events
     UNION ALL
     SELECT jsonb_build_object('id','note-'||n.id,'type','note','actor',jsonb_build_object('login',coalesce($11::text,u.name)),'repo','journal/notes','title',n.title,'occurredAt',n.created_at),n.created_at,'note-'||n.id
     FROM ship_live_notes n JOIN ship_live_auth_users u ON u.id=n.user_id
     WHERE $6::text IS NULL AND n.user_id=$9::uuid AND n.workspace_id=$10::uuid
   )
   SELECT event - 'body' AS event, to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,event_id FROM activity
   WHERE occurred_at >= $3::timestamptz AND occurred_at < $4::timestamptz AND occurred_at <= $5::timestamptz
   AND ($6::text IS NULL OR event->>'repo'=$6)
   AND ($12::text IS NULL OR event->>'type'=$12 OR ($12='contribution' AND event->>'type' NOT IN ('note','alert')))
   AND ($7::timestamptz IS NULL OR (occurred_at,event_id) < ($7::timestamptz,$8::text))
   ORDER BY occurred_at DESC,event_id DESC LIMIT 101`,
      [
        ...scopeParams(scope),
        range.start,
        range.end,
        cutoff,
        repo ?? null,
        position?.at ?? null,
        position?.id ?? null,
        scope.noteUserId ?? null,
        scope.workspaceId ?? null,
        scope.ownerLogin ?? null,
        kind ?? null,
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
