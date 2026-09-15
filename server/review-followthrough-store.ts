import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  reviewFollowthrough,
  type ReviewFollowthroughItem,
  type ReviewAction,
} from "../shared/review-followthrough.js";
import type { WallRepositorySnapshot } from "../shared/wall.js";
import { AuthError } from "./auth.js";
import { combineWallSnapshots } from "./wall-store.js";
export interface ReviewScope {
  sources: { installationId: number; repositories: { id: number }[] }[];
  author?: string;
}
export interface ReviewTarget {
  repositoryId: number;
  number: number;
}
export class ReviewFollowthroughStore {
  constructor(private readonly pool: Pool) {}
  async current(
    scope: ReviewScope,
    targets: ReviewTarget[],
    database: Pick<Pool, "query"> = this.pool,
  ): Promise<ReviewFollowthroughItem[]> {
    if (!targets.length || !scope.sources.length) return [];
    const pairs = scope.sources.flatMap((s) =>
      s.repositories.map((r) => ({
        installation: s.installationId,
        repository: r.id,
      })),
    );
    const rows = await database.query<{
      installation_id: string;
      repository: WallRepositorySnapshot;
    }>(
      `WITH permitted AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS p(installation bigint,repository bigint)
  ), targets AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS t("repositoryId" bigint,number integer)), pulls AS (
    SELECT s.* FROM ship_live_wall_signals s JOIN permitted p ON p.installation=s.installation_id AND p.repository=s.repository_id
    JOIN targets t ON t."repositoryId"=s.repository_id AND t.number::text=s.signal_key
    WHERE s.kind='pull_request' AND ($3::text IS NULL OR lower(s.value->>'author')=$3)
  ) SELECT p.installation_id,jsonb_build_object('repositoryId',p.repository_id,'repository',p.repository,'pullRequests',jsonb_build_array(p.value),
   'reviews',coalesce((SELECT jsonb_agg(r.value) FROM (
    SELECT DISTINCT ON(lower(s.value->>'reviewer')) s.value FROM ship_live_wall_signals s
    WHERE s.installation_id=p.installation_id AND s.repository_id=p.repository_id AND s.kind='review' AND s.value->>'pullRequestNumber'=p.signal_key
    ORDER BY lower(s.value->>'reviewer'),(s.value->>'submittedAt')::timestamptz DESC,s.signal_key DESC LIMIT 101)r),'[]'::jsonb),
   'pipelines',coalesce((SELECT jsonb_agg(c.value) FROM (
    SELECT DISTINCT ON(s.value->>'provider',s.value->>'name') s.value FROM ship_live_wall_signals s
    WHERE s.installation_id=p.installation_id AND s.repository_id=p.repository_id AND s.kind='pipeline' AND s.value->>'headSha'=p.value->>'headSha'
    ORDER BY s.value->>'provider',s.value->>'name',(s.value->>'updatedAt')::timestamptz DESC,s.signal_key DESC LIMIT 101)c),'[]'::jsonb),'deployments','[]'::jsonb) AS repository FROM pulls p LIMIT 501`,
      [JSON.stringify(pairs), JSON.stringify(targets), scope.author ?? null],
    );
    // Incomplete upstream context must never authorize a claim or snooze.
    if (rows.rows.length > 500)
      throw new AuthError(
        409,
        "Review context is too large. Narrow your sources.",
      );
    const blocked = new Set(
      rows.rows
        .filter(
          (r) =>
            r.repository.reviews.length > 100 ||
            r.repository.pipelines.length > 100,
        )
        .flatMap((r) =>
          r.repository.pullRequests.map(
            (pull) => `${r.repository.repositoryId}:${pull.number}`,
          ),
        ),
    );
    const merged = combineWallSnapshots(
      rows.rows.map((r) => ({
        repositories: [r.repository],
        updatedAt: new Date().toISOString(),
      })),
    );
    const result: ReviewFollowthroughItem[] = [];
    for (const target of targets) {
      const repo = merged.repositories.find(
        (r) => r.repositoryId === target.repositoryId,
      );
      if (!repo || blocked.has(`${repo.repositoryId}:${target.number}`))
        continue;
      const item = reviewFollowthrough(repo, target.number);
      if (!item) continue;
      const sources = rows.rows
        .filter(
          (r) =>
            r.repository.repositoryId === repo.repositoryId &&
            r.repository.pullRequests.some((p) => p.number === target.number),
        )
        .map((r) => r.installation_id)
        .sort();
      item.fingerprint = createHash("sha256")
        .update(JSON.stringify([item.fingerprint, [...new Set(sources)]]))
        .digest("hex");
      result.push(item);
    }
    return result;
  }
  async states(
    workspace: string,
    user: string,
    items: ReviewFollowthroughItem[],
  ) {
    if (!items.length) return items;
    const rows = await this.pool.query<{
      repository_id: string;
      pull_number: number;
      fingerprint: string;
      user_id: string;
      name: string;
      expires_at: Date;
      kind: string;
    }>(
      `WITH wanted AS(SELECT * FROM jsonb_to_recordset($3::jsonb) AS t("repositoryId" bigint,number integer,fingerprint text))
   SELECT c.repository_id,c.pull_number,c.fingerprint,c.user_id,u.name,c.expires_at,'claim' AS kind FROM ship_live_review_claims c JOIN wanted w ON w."repositoryId"=c.repository_id AND w.number=c.pull_number AND w.fingerprint=c.fingerprint JOIN ship_live_auth_users u ON u.id=c.user_id WHERE c.workspace_id=$1 AND c.expires_at>now()
   UNION ALL SELECT s.repository_id,s.pull_number,s.fingerprint,s.user_id,'' AS name,s.expires_at,'snooze' AS kind FROM ship_live_review_snoozes s JOIN wanted w ON w."repositoryId"=s.repository_id AND w.number=s.pull_number AND w.fingerprint=s.fingerprint WHERE s.workspace_id=$1 AND s.user_id=$2 AND s.expires_at>now() LIMIT 100`,
      [workspace, user, JSON.stringify(items)],
    );
    return items.map((item) => {
      if (!item.actionable) return item;
      const matches = rows.rows.filter(
        (r) =>
          Number(r.repository_id) === item.repositoryId &&
          r.pull_number === item.number,
      );
      const claim = matches.find((r) => r.kind === "claim"),
        snooze = matches.find((r) => r.kind === "snooze");
      return {
        ...item,
        ...(claim
          ? {
              claim: {
                userId: claim.user_id,
                name: claim.name,
                expiresAt: claim.expires_at.toISOString(),
              },
            }
          : {}),
        ...(snooze ? { snoozedUntil: snooze.expires_at.toISOString() } : {}),
      };
    });
  }
  async mutate(
    workspace: string,
    user: string,
    item: ReviewFollowthroughItem,
    action: ReviewAction,
    hours: number | undefined,
    scope: ReviewScope,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize with wall signal ingestion: an old snapshot cannot replace a
      // teammate's claim on a newer head while its own request is still running.
      const installations = [
        ...new Set(
          scope.sources
            .filter((source) =>
              source.repositories.some((repo) => repo.id === item.repositoryId),
            )
            .map((source) => source.installationId),
        ),
      ].sort((a, b) => a - b);
      for (const installation of installations)
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`wall:${installation}:${item.repositoryId}`],
        );
      const latest = (await this.current(scope, [item], client))[0];
      if (
        !latest ||
        !latest.actionable ||
        latest.fingerprint !== item.fingerprint
      )
        throw new AuthError(
          409,
          "This pull request changed. Refresh its current status.",
        );
      const args = [
        workspace,
        item.repositoryId,
        item.number,
        user,
        item.fingerprint,
      ];
      if (action === "claim") {
        const result = await client.query(
          `INSERT INTO ship_live_review_claims(workspace_id,repository_id,pull_number,user_id,fingerprint,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '24 hours') ON CONFLICT(workspace_id,repository_id,pull_number) DO UPDATE SET user_id=EXCLUDED.user_id,fingerprint=EXCLUDED.fingerprint,expires_at=EXCLUDED.expires_at WHERE ship_live_review_claims.user_id=$4 OR ship_live_review_claims.fingerprint<>$5 OR ship_live_review_claims.expires_at<=now() RETURNING 1`,
          args,
        );
        if (!result.rowCount)
          throw new AuthError(
            409,
            "A teammate is already looking at this pull request.",
          );
      } else if (action === "release") {
        const result = await client.query(
          "DELETE FROM ship_live_review_claims WHERE workspace_id=$1 AND repository_id=$2 AND pull_number=$3 AND user_id=$4 AND fingerprint=$5 RETURNING 1",
          args,
        );
        if (!result.rowCount)
          throw new AuthError(
            409,
            "Only your own current claim can be released.",
          );
      } else if (action === "snooze") {
        await client.query(
          `INSERT INTO ship_live_review_snoozes(workspace_id,repository_id,pull_number,user_id,fingerprint,expires_at) VALUES($1,$2,$3,$4,$5,now()+$6*interval '1 hour') ON CONFLICT(workspace_id,repository_id,pull_number,user_id) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,expires_at=EXCLUDED.expires_at`,
          [...args, hours],
        );
      } else
        await client.query(
          "DELETE FROM ship_live_review_snoozes WHERE workspace_id=$1 AND repository_id=$2 AND pull_number=$3 AND user_id=$4 AND fingerprint=$5",
          args,
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
