import type { PoolClient } from "pg";
import type { ActivityEvent } from "../shared/types.js";
import type { PipelineState, ReviewState } from "../shared/wall.js";
import { mergeVerification } from "../shared/xp.js";

// Match JavaScript trim() when deciding whether an author is identifiable.
const whitespace = [
  9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198,
  8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279,
]
  .map((c) => `chr(${c})`)
  .join(" || ");

export type HistoryScope = (
  organization: string,
  repositoryId: string,
) => string;

/** Authorized source map used by workspace and Pulse reads. Never applies an author filter. */
export const mappedHistoryScope =
  (parameter: string): HistoryScope =>
  (org, repo) =>
    `EXISTS (SELECT 1 FROM jsonb_each(${parameter}::jsonb) AS history(scope,repositories)
    WHERE history.scope=${org} AND ${repo}=ANY(ARRAY(SELECT jsonb_array_elements_text(history.repositories))))`;

/** Enrich reviews before date, author or feed limits. Arguments are trusted SQL expressions. */
export function scoredEventSql(
  event: string,
  organization: string,
  scope?: HistoryScope,
): string {
  const number = `${event}->>'number'`;
  const permitted = (org: string, repo: string) =>
    scope ? scope(org, repo) : `${org}=${organization}`;
  const sameRepo = (
    alias: string,
  ) => `CASE WHEN ${event}->>'repositoryId' IS NOT NULL
    THEN ${alias}.event->>'repositoryId'=${event}->>'repositoryId'
    ELSE lower(${alias}.event->>'repo')=lower(${event}->>'repo') END`;
  const knownAuthor = (expression: string) =>
    `(CASE WHEN lower(btrim(${expression}, ${whitespace})) NOT IN ('','unknown') THEN btrim(${expression}, ${whitespace}) END)`;
  const prAuthor = knownAuthor("p.event #>> '{actor,login}'");
  const reviewAuthor = knownAuthor("a.event->>'pullRequestAuthor'");
  const wallAuthor = knownAuthor("w.value->>'author'");
  return `(CASE WHEN ${event}->>'type'='review' THEN ${event} || jsonb_build_object(
    'pullRequestAuthor', coalesce(${knownAuthor(`${event}->>'pullRequestAuthor'`)},
      (SELECT ${prAuthor} FROM ship_live_events p
       WHERE ${permitted("p.organization", "p.event->>'repositoryId'")} AND ${sameRepo("p")}
         AND p.event->>'number'=${number} AND p.event->>'type' IN ('pr','merge')
         AND ${prAuthor} IS NOT NULL
       ORDER BY p.occurred_at,p.event_id COLLATE "C" LIMIT 1),
      (SELECT ${reviewAuthor} FROM ship_live_events a
       WHERE ${permitted("a.organization", "a.event->>'repositoryId'")} AND ${sameRepo("a")}
         AND a.event->>'number'=${number} AND a.event->>'type'='review'
         AND ${reviewAuthor} IS NOT NULL
       ORDER BY a.occurred_at,a.event_id COLLATE "C" LIMIT 1),
      (SELECT ${wallAuthor} FROM ship_live_wall_signals w
       WHERE ${permitted("'installation-' || w.installation_id", "w.repository_id::text")}
         AND w.repository_id::text=${event}->>'repositoryId'
         AND w.kind='pull_request' AND w.signal_key=${number}
         AND ${wallAuthor} IS NOT NULL
       ORDER BY w.observed_at DESC,w.installation_id LIMIT 1)),
    'reviewCredit', ${event} ? 'number' AND NOT EXISTS (
      SELECT 1 FROM ship_live_events r WHERE ${permitted("r.organization", "r.event->>'repositoryId'")}
        AND r.event->>'type'='review' AND ${sameRepo("r")}
        AND r.event->>'number'=${number}
        AND lower(btrim(r.event #>> '{actor,login}'))=lower(btrim(${event} #>> '{actor,login}'))
        AND (r.occurred_at,r.event_id COLLATE "C") < ((${event}->>'occurredAt')::timestamptz,(${event}->>'id') COLLATE "C")
    )) ELSE ${event} END)`;
}

/** Called only for newly inserted live merges, inside the event transaction. */
export async function captureMergeVerification(
  client: PoolClient,
  organization: string,
  events: ActivityEvent[],
) {
  const installation = /^installation-(\d+)$/.exec(organization)?.[1];
  if (!installation) return;
  for (const event of events) {
    if (event.type !== "merge" || !event.repositoryId || !event.number)
      continue;
    // Serialize with wall ingest so the snapshot observes one consistent set of signals.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`wall:${installation}:${event.repositoryId}`],
    );
    const { rows } = await client.query<{
      kind: string;
      value: ReviewState | PipelineState;
    }>(
      `SELECT kind,value FROM ship_live_wall_signals WHERE installation_id=$1 AND repository_id=$2
       AND ((kind='review' AND value->>'pullRequestNumber'=$3) OR (kind='pipeline' AND value->>'headSha'=$4))`,
      [
        installation,
        event.repositoryId,
        String(event.number),
        event.headSha ?? null,
      ],
    );
    event.verification = mergeVerification(
      event,
      rows
        .filter((r) => r.kind === "review")
        .map((r) => r.value as ReviewState),
      rows
        .filter((r) => r.kind === "pipeline")
        .map((r) => r.value as PipelineState),
      new Date().toISOString(),
    );
    await client.query(
      "UPDATE ship_live_events SET event=event || jsonb_build_object('verification',$3::jsonb) WHERE organization=$1 AND event_id=$2",
      [organization, event.id, JSON.stringify(event.verification)],
    );
  }
}
