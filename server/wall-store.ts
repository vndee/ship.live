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
      const accepted = await client.query(
        "INSERT INTO ship_live_wall_deliveries(delivery_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING delivery_id",
        [deliveryId],
      );
      if (!accepted.rowCount) {
        await client.query("ROLLBACK");
        return false;
      }
      for (const update of updates)
        await client.query(
          `INSERT INTO ship_live_wall_signals
             (installation_id,repository_id,repository,kind,signal_key,observed_at,value)
           VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (installation_id,repository_id,kind,signal_key) DO UPDATE SET
             repository=EXCLUDED.repository,
             observed_at=EXCLUDED.observed_at,
             value=EXCLUDED.value
           WHERE ship_live_wall_signals.observed_at <= EXCLUDED.observed_at`,
          [
            installationId,
            repositoryId,
            repository,
            update.kind,
            signalKey(update),
            update.observedAt,
            update.value,
          ],
        );
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
