import type { Pool } from "pg";
import type {
  DeploymentState,
  EngineeringWallSnapshot,
  PipelineState,
  PullRequestState,
  ReviewState,
  WallRepositorySnapshot,
  WallSignalUpdate,
} from "../shared/wall.js";
import { ACTIVITY_CHANNEL } from "./postgres-notifications.js";
import {
  deploymentOutboxEvent,
  pipelineOutboxEvent,
} from "./webhook-events.js";
import { recordInstallationEvent } from "./webhook-outbox.js";

/** A pipeline's last finished result: its own, or one carried from before. */
function settledOf(value: PipelineState): "passing" | "failing" | undefined {
  return value.status === "passing" || value.status === "failing"
    ? value.status
    : value.settled;
}

function signalKey(update: WallSignalUpdate): string {
  if (update.kind === "pull_request") return String(update.value.number);
  return String(update.value.id);
}

export class WallStore {
  constructor(private readonly pool: Pool) {}

  async apply(
    installationId: number,
    repositoryId: number,
    repository: string,
    deliveryId: string,
    updates: WallSignalUpdate[],
  ): Promise<boolean> {
    if (!updates.length) return true;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // One delivery at a time per repository: FOR UPDATE below cannot lock a
      // signal's first row, which does not exist yet.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`wall:${installationId}:${repositoryId}`],
      );
      const accepted = await client.query(
        "INSERT INTO ship_live_wall_deliveries(delivery_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING delivery_id",
        [deliveryId],
      );
      if (!accepted.rowCount) {
        await client.query("ROLLBACK");
        return false;
      }
      for (const update of updates) {
        // CI and deployment changes become webhook events, so their previous
        // state is read under the repository lock. A pipeline compares with
        // the latest run of the same check on the same branch, so reruns and
        // later commits, which get new IDs, still count as one pipeline.
        let previous: PipelineState | DeploymentState | undefined;
        let value: WallSignalUpdate["value"] = update.value;
        let superseded = false;
        if (update.kind === "pipeline") {
          const last = (
            await client.query<{ value: PipelineState; observed_at: Date }>(
              `SELECT value, observed_at FROM ship_live_wall_signals
               WHERE installation_id=$1 AND repository_id=$2 AND kind='pipeline'
                 AND value->>'name'=$3 AND value->>'provider'=$4
                 AND coalesce(value->>'branch','')=$5
               ORDER BY observed_at DESC LIMIT 1`,
              [
                installationId,
                repositoryId,
                update.value.name,
                update.value.provider,
                update.value.branch ?? "",
              ],
            )
          ).rows[0];
          // A late result from an older run announces nothing.
          superseded = Boolean(
            last && last.observed_at.getTime() > Date.parse(update.observedAt),
          );
          const settled =
            last && !superseded ? settledOf(last.value) : undefined;
          if (settled) previous = { ...last!.value, status: settled };
          const carried = settledOf(update.value) ?? settled;
          if (carried) value = { ...update.value, settled: carried };
        } else if (update.kind === "deployment") {
          const earlier = (
            await client.query<{ value: DeploymentState }>(
              `SELECT value FROM ship_live_wall_signals
               WHERE installation_id=$1 AND repository_id=$2 AND kind=$3 AND signal_key=$4
               FOR UPDATE`,
              [installationId, repositoryId, update.kind, signalKey(update)],
            )
          ).rows[0]?.value;
          previous = earlier;
          // GitHub marks earlier successful deployments inactive; keep when
          // each one succeeded, for delivery figures.
          if (update.value.status === "inactive")
            value = {
              ...update.value,
              succeededAt:
                earlier?.status === "successful"
                  ? earlier.updatedAt
                  : earlier?.succeededAt,
            };
        }
        const written = await client.query(
          `INSERT INTO ship_live_wall_signals
             (installation_id,repository_id,repository,kind,signal_key,observed_at,value)
           VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (installation_id,repository_id,kind,signal_key) DO UPDATE SET
             repository=EXCLUDED.repository,
             observed_at=EXCLUDED.observed_at,
             value=EXCLUDED.value
           WHERE ship_live_wall_signals.observed_at <= EXCLUDED.observed_at
           RETURNING 1`,
          [
            installationId,
            repositoryId,
            repository,
            update.kind,
            signalKey(update),
            update.observedAt,
            value,
          ],
        );
        // A stale update changes nothing and announces nothing.
        if (!written.rowCount || superseded) continue;
        const event =
          update.kind === "pipeline"
            ? pipelineOutboxEvent(
                repository,
                repositoryId,
                previous as PipelineState | undefined,
                update.value,
              )
            : update.kind === "deployment"
              ? deploymentOutboxEvent(
                  repository,
                  repositoryId,
                  previous as DeploymentState | undefined,
                  update.value,
                )
              : undefined;
        if (event) await recordInstallationEvent(client, installationId, event);
      }
      await client.query("SELECT pg_notify($1,$2)", [
        ACTIVITY_CHANNEL,
        JSON.stringify({
          organization: `wall-installation-${installationId}`,
          eventId: "refresh",
        }),
      ]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async snapshot(
    installationId: number,
    repositoryIds: number[],
  ): Promise<EngineeringWallSnapshot> {
    if (!repositoryIds.length)
      return { repositories: [], updatedAt: new Date().toISOString() };
    const result = await this.pool.query<{
      repository_id: string;
      repository: string;
      kind: WallSignalUpdate["kind"];
      value: PullRequestState | ReviewState | PipelineState | DeploymentState;
    }>(
      `SELECT repository_id,repository,kind,value
       FROM (
         SELECT repository_id,repository,kind,value,observed_at,
                row_number() OVER (
                  PARTITION BY repository_id,kind ORDER BY observed_at DESC
                ) AS signal_rank
         FROM ship_live_wall_signals
         WHERE installation_id=$1 AND repository_id=ANY($2::bigint[])
       ) scoped
       WHERE signal_rank <= 300
       ORDER BY repository,kind,observed_at DESC`,
      [installationId, repositoryIds],
    );
    const grouped = new Map<number, WallRepositorySnapshot>();
    for (const row of result.rows) {
      const id = Number(row.repository_id);
      const current = grouped.get(id) ?? {
        repositoryId: id,
        repository: row.repository,
        pullRequests: [],
        reviews: [],
        pipelines: [],
        deployments: [],
      };
      if (row.kind === "pull_request")
        current.pullRequests.push(row.value as PullRequestState);
      if (row.kind === "review") current.reviews.push(row.value as ReviewState);
      if (row.kind === "pipeline")
        current.pipelines.push(row.value as PipelineState);
      if (row.kind === "deployment")
        current.deployments.push(row.value as DeploymentState);
      grouped.set(id, current);
    }
    return {
      repositories: [...grouped.values()],
      updatedAt: new Date().toISOString(),
    };
  }
}
