import type { Pool } from "pg";
import {
  BRANCH_MERGE_POINTS,
  COMMIT_POINTS,
  EVENT_META,
} from "../src/lib/activity.js";

interface DigestSummary {
  totals: {
    merges: number;
    reviews: number;
    releases: number;
    contributors: number;
    xp: number;
  };
  topContributors: {
    login: string;
    xp: number;
    merges: number;
    reviews: number;
  }[];
  repositories: { name: string; merges: number; reviews: number }[];
  shipped: {
    id: string;
    type: string;
    title: string;
    repository: string;
    number?: number;
    url?: string;
    occurredAt: string;
  }[];
  helpfulReviewers: { login: string; reviews: number; pullRequests: number }[];
  needsHelp: {
    repository: string;
    number: number;
    title: string;
    url: string;
    state: "waiting" | "failing";
  }[];
}

// Same human eligibility as PulseStore/isHumanActor, including JavaScript trim.
const whitespace = [
  9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198,
  8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279,
]
  .map((c) => `chr(${c})`)
  .join(" || ");
const actor = `lower(btrim(event #>> '{actor,login}', ${whitespace}))`;

// GitHub repository names use this ASCII alphabet. Carry Node's locale ordering
// into a bytewise SQL key without depending on a database-specific ICU collation.
const repositoryAlphabet = [..."/_-.0123456789abcdefghijklmnopqrstuvwxyz"]
  .sort((a, b) => a.localeCompare(b))
  .join("");
const repositoryWeights = [...repositoryAlphabet]
  .map((_, index) => String.fromCharCode(33 + index))
  .join("");

/** Aggregate complete retained history inside PostgreSQL; only fixed-size lists cross into Node. */
export async function readDigestSummary(
  pool: Pool,
  scope: {
    installations: number[];
    sources?: { installationId: number; repositoryIds: number[] }[];
    repositoryIds: number[];
    author?: string;
    start: string;
    end: string;
    now: number;
  },
): Promise<DigestSummary> {
  const result = await pool.query<{ summary: DigestSummary }>(
    `WITH canonical AS MATERIALIZED (
      SELECT DISTINCT ON (event_id) event,event_id,occurred_at FROM ship_live_events
      WHERE organization=ANY($1::text[]) AND (event->>'repositoryId')::bigint=ANY($2::bigint[])
        AND ($13::jsonb IS NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements($13::jsonb) source
          WHERE organization='installation-' || (source->>'installationId')
          AND source->'repositoryIds' @> jsonb_build_array((event->>'repositoryId')::bigint)))
        AND ($3::text IS NULL OR lower(event #>> '{actor,login}')=$3)
        AND event->>'type' NOT IN ('note','alert') AND ${actor} <> ''
        AND ${actor} !~ '(\\[bot\\]|-bot)$' AND ${actor} NOT IN ('dependabot','renovate','github-actions')
      ORDER BY event_id,occurred_at DESC,organization
    ), weekly AS MATERIALIZED (
      SELECT event,event_id,occurred_at,event->>'type' AS type,event->>'repo' AS repo,
        event #>> '{actor,login}' AS login,lower(event #>> '{actor,login}') AS person,
        row_number() OVER (PARTITION BY lower(event #>> '{actor,login}'),lower(event->>'repo'),event->>'number',to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD'),event->>'type'
          ORDER BY occurred_at DESC,event_id DESC) AS review_rank
      FROM canonical WHERE occurred_at >= $4::timestamptz AND occurred_at < $5::timestamptz AND occurred_at <= $6::timestamptz
    ), credited AS MATERIALIZED (
      SELECT *, CASE
        WHEN type='review' AND event ? 'number' AND review_rank>1 THEN 0
        WHEN type='merge' AND event->'defaultBranch'='false'::jsonb THEN $8::numeric
        WHEN type='push' THEN $9::numeric*coalesce((event->>'commits')::numeric,0)
        ELSE ($7::jsonb->>type)::numeric END AS points FROM weekly
    ), people AS (
      SELECT person,sum(points) AS xp,count(*) AS contributions,
        count(*) FILTER(WHERE type='merge') AS merges,count(*) FILTER(WHERE type='review') AS reviews
      FROM credited GROUP BY person
    ), names AS (
      SELECT DISTINCT ON(person) person,login FROM weekly ORDER BY person,occurred_at DESC,event_id DESC
    ), top_people AS (
      SELECT names.login,people.xp,people.merges,people.reviews FROM people JOIN names USING(person)
      ORDER BY xp DESC,contributions DESC,lower(login) COLLATE "C",login COLLATE "C" LIMIT 5
    ), repo_counts AS (
      SELECT repo AS name,count(*) FILTER(WHERE type='merge') AS merges,count(*) FILTER(WHERE type='review') AS reviews
      FROM weekly WHERE type IN ('merge','review') GROUP BY repo
    ), repo_latest AS (
      SELECT DISTINCT ON(repo) repo AS name,event_id,occurred_at FROM weekly WHERE type IN ('merge','review')
      ORDER BY repo,occurred_at DESC,event_id DESC
    ), top_repos AS (
      SELECT name,merges,reviews FROM repo_counts JOIN repo_latest USING(name)
      ORDER BY merges+reviews DESC,occurred_at DESC,event_id DESC LIMIT 5
    ), shipped AS (
      SELECT jsonb_strip_nulls(jsonb_build_object('id',event->>'id','type',type,'title',event->>'title','repository',repo,'number',event->'number','url',event->>'url','occurredAt',event->>'occurredAt')) AS item
      FROM weekly WHERE type IN ('merge','release') ORDER BY occurred_at DESC,event_id DESC LIMIT 5
    ), signals AS MATERIALIZED (
      SELECT DISTINCT ON(repository_id,kind,signal_key) repository_id,repository,kind,signal_key,value
      FROM ship_live_wall_signals WHERE installation_id=ANY($10::bigint[]) AND repository_id=ANY($2::bigint[])
        AND kind IN ('pull_request','review','pipeline')
        AND ($13::jsonb IS NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements($13::jsonb) source
          WHERE installation_id=(source->>'installationId')::bigint
          AND source->'repositoryIds' @> jsonb_build_array(repository_id)))
      ORDER BY repository_id,kind,signal_key,
        (CASE WHEN kind='review' THEN value->>'submittedAt' ELSE value->>'updatedAt' END)::timestamptz DESC,
        installation_id
    ), pulls AS MATERIALIZED (
      SELECT repository_id,repository,value,(value->>'number')::int AS number FROM signals WHERE kind='pull_request'
        AND (value->>'createdAt')::timestamptz <= $6::timestamptz
    ), helpful AS (
      SELECT lower(btrim(w.login, ${whitespace})) AS person,count(*) AS reviews,
        count(DISTINCT (p.repository_id,p.number)) AS pulls
      FROM weekly w JOIN pulls p ON p.repository_id=(w.event->>'repositoryId')::bigint AND p.number=(w.event->>'number')::int
      WHERE w.type='review' AND coalesce(p.value->>'author','') <> ''
        AND lower(btrim(p.value->>'author', ${whitespace})) <> lower(btrim(w.login, ${whitespace}))
      GROUP BY lower(btrim(w.login, ${whitespace}))
    ), helper_names AS (
      SELECT DISTINCT ON (lower(btrim(w.login, ${whitespace}))) lower(btrim(w.login, ${whitespace})) AS person,w.login
      FROM weekly w JOIN pulls p ON p.repository_id=(w.event->>'repositoryId')::bigint AND p.number=(w.event->>'number')::int
      WHERE w.type='review' AND coalesce(p.value->>'author','') <> ''
        AND lower(btrim(p.value->>'author', ${whitespace})) <> lower(btrim(w.login, ${whitespace}))
      ORDER BY lower(btrim(w.login, ${whitespace})),w.occurred_at DESC,w.event_id DESC
    ), top_helpers AS (
      SELECT n.login,h.reviews,h.pulls AS "pullRequests" FROM helpful h JOIN helper_names n USING(person)
      ORDER BY h.pulls DESC,lower(n.login) COLLATE "C",n.login COLLATE "C" LIMIT 5
    ), latest_checks AS (
      SELECT DISTINCT ON(repository_id,value->>'headSha',value->>'provider',value->>'name') repository_id,value
      FROM signals WHERE kind='pipeline'
      ORDER BY repository_id,value->>'headSha',value->>'provider',value->>'name',(value->>'updatedAt')::timestamptz DESC,signal_key
    ), checks AS (
      SELECT repository_id,value->>'headSha' AS sha,count(*) AS count,
        bool_or(value->>'status'='failing') AS failing,
        bool_or(value->>'status' IN ('running','queued')) AS running,
        bool_and(value->>'status'='passing') AS passing
      FROM latest_checks GROUP BY repository_id,value->>'headSha'
    ), latest_reviews AS (
      SELECT DISTINCT ON(repository_id,value->>'pullRequestNumber',lower(value->>'reviewer')) repository_id,value
      FROM signals WHERE kind='review'
      ORDER BY repository_id,value->>'pullRequestNumber',lower(value->>'reviewer'),(value->>'submittedAt')::timestamptz DESC,signal_key
    ), decisions AS (
      SELECT repository_id,(value->>'pullRequestNumber')::int AS number,
        bool_or(value->>'decision'='approved') AS approved,
        bool_or(value->>'decision'='changes_requested') AS changes_requested
      FROM latest_reviews GROUP BY repository_id,(value->>'pullRequestNumber')::int
    ), radar AS (
      SELECT p.repository,p.number,p.value->>'title' AS title,p.value->>'url' AS url,(p.value->>'createdAt')::timestamptz AS created_at,
        CASE WHEN c.failing THEN 'failing' WHEN c.running THEN 'running'
          WHEN d.approved AND NOT d.changes_requested AND c.count>0 AND c.passing AND p.value->'mergeable' IS DISTINCT FROM 'false'::jsonb THEN 'ready'
          ELSE 'waiting' END AS state
      FROM pulls p LEFT JOIN checks c ON c.repository_id=p.repository_id AND c.sha=p.value->>'headSha'
      LEFT JOIN decisions d ON d.repository_id=p.repository_id AND d.number=p.number
      WHERE p.value->>'state'='open' AND p.value->'draft' IS DISTINCT FROM 'true'::jsonb
        AND ($3::text IS NULL OR lower(p.value->>'author')=$3)
    ), needs_help AS (
      SELECT repository,number,title,url,state FROM radar WHERE state IN ('waiting','failing')
      ORDER BY (state='failing') DESC,created_at,translate(lower(repository),$11::text,$12::text) COLLATE "C",repository COLLATE "C",number LIMIT 5
    )
    SELECT jsonb_build_object(
      'totals',(SELECT jsonb_build_object('merges',count(*) FILTER(WHERE type='merge'),'reviews',count(*) FILTER(WHERE type='review'),'releases',count(*) FILTER(WHERE type='release'),'contributors',count(DISTINCT person),'xp',coalesce(sum(points),0)) FROM credited),
      'topContributors',coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM top_people p),'[]'::jsonb),
      'repositories',coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM top_repos r),'[]'::jsonb),
      'shipped',coalesce((SELECT jsonb_agg(item) FROM shipped),'[]'::jsonb),
      'helpfulReviewers',coalesce((SELECT jsonb_agg(to_jsonb(h)) FROM top_helpers h),'[]'::jsonb),
      'needsHelp',coalesce((SELECT jsonb_agg(to_jsonb(n)) FROM needs_help n),'[]'::jsonb)
    ) AS summary`,
    [
      scope.installations.map((id) => `installation-${id}`),
      scope.repositoryIds,
      scope.author ?? null,
      scope.start,
      scope.end,
      new Date(scope.now).toISOString(),
      Object.fromEntries(
        Object.entries(EVENT_META).map(([type, meta]) => [type, meta.points]),
      ),
      BRANCH_MERGE_POINTS,
      COMMIT_POINTS,
      scope.installations,
      repositoryAlphabet,
      repositoryWeights,
      scope.sources ? JSON.stringify(scope.sources) : null,
    ],
  );
  return result.rows[0].summary;
}
