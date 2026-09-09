import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  DashboardShare,
  CreatedDashboardShare,
} from "../shared/shares.js";
import type { Workspace } from "../shared/workspaces.js";
import { AuthError } from "./auth.js";
import { ACTIVITY_CHANNEL } from "./postgres-notifications.js";

interface ShareRow {
  id: string;
  workspace_id: string;
  creator_user_id: string;
  installation_id: string;
  connection_generation: string;
  repository_ids: string[];
  created_at: Date;
  expires_at: Date;
}
export const unavailableShare = () =>
  new AuthError(
    410,
    "This share link has expired or is no longer available. Ask its creator for a new link.",
  );
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const metadata = (row: ShareRow): DashboardShare => ({
  id: row.id,
  createdAt: row.created_at.toISOString(),
  expiresAt: row.expires_at.toISOString(),
  repositoryCount: row.repository_ids.length,
});

export class DashboardShareStore {
  constructor(private readonly pool: Pool) {}

  async current(
    userId: string,
    workspaceId: string,
  ): Promise<DashboardShare | null> {
    const result = await this.pool.query<ShareRow>(
      "SELECT * FROM ship_live_dashboard_shares WHERE creator_user_id=$1 AND workspace_id=$2",
      [userId, workspaceId],
    );
    return result.rows[0] ? metadata(result.rows[0]) : null;
  }

  async create(
    userId: string,
    workspace: Workspace,
    generation: string,
    repositories: number[],
    expiresIn: number,
    rotate: boolean,
  ): Promise<CreatedDashboardShare> {
    const token = randomBytes(32).toString("base64url");
    // The write rechecks membership and the exact GitHub grant observed during
    // authorization. Conflict handling makes simultaneous creations/rotations atomic.
    const result = await this.pool.query<ShareRow>(
      `WITH changed AS (
        INSERT INTO ship_live_dashboard_shares(id,workspace_id,creator_user_id,connection_generation,installation_id,repository_ids,token_hash,expires_at)
        SELECT $1,w.id,$3,c.generation,w.installation_id,$6,$7,now()+($8 * interval '1 second')
        FROM ship_live_workspaces w
        JOIN ship_live_workspace_members m ON m.workspace_id=w.id AND m.user_id=$3
        JOIN ship_live_github_connections c ON c.user_id=m.user_id AND c.generation=$4
        JOIN ship_live_installations i ON i.id=w.installation_id AND i.active
        WHERE w.id=$2 AND w.kind='team' AND w.installation_id=$5
        ON CONFLICT(workspace_id,creator_user_id) DO UPDATE SET
          id=EXCLUDED.id,connection_generation=EXCLUDED.connection_generation,
          installation_id=EXCLUDED.installation_id,repository_ids=EXCLUDED.repository_ids,
          token_hash=EXCLUDED.token_hash,created_at=now(),expires_at=EXCLUDED.expires_at
        WHERE $9 OR ship_live_dashboard_shares.expires_at<=now()
        RETURNING *
      ) SELECT changed.*,pg_notify($10,$11) FROM changed`,
      [
        randomUUID(),
        workspace.id,
        userId,
        generation,
        workspace.installationId,
        repositories,
        hash(token),
        expiresIn,
        rotate,
        ACTIVITY_CHANNEL,
        JSON.stringify({
          organization: `workspace-${workspace.id}`,
          eventId: "refresh",
        }),
      ],
    );
    if (!result.rows[0])
      throw new AuthError(
        409,
        "A link already exists or your access changed. Refresh and rotate your current link.",
      );
    return { ...metadata(result.rows[0]), token };
  }

  async revoke(userId: string, workspaceId: string): Promise<void> {
    await this.pool.query(
      `WITH removed AS (DELETE FROM ship_live_dashboard_shares WHERE creator_user_id=$1 AND workspace_id=$2 RETURNING id)
       SELECT pg_notify($3,$4) FROM removed`,
      [
        userId,
        workspaceId,
        ACTIVITY_CHANNEL,
        JSON.stringify({
          organization: `workspace-${workspaceId}`,
          eventId: "refresh",
        }),
      ],
    );
  }

  async resolve(token: string | undefined): Promise<ShareRow> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw unavailableShare();
    const result = await this.pool.query<ShareRow>(
      `SELECT s.* FROM ship_live_dashboard_shares s
       JOIN ship_live_workspaces w ON w.id=s.workspace_id AND w.kind='team' AND w.installation_id=s.installation_id
       JOIN ship_live_workspace_members m ON m.workspace_id=w.id AND m.user_id=s.creator_user_id
       JOIN ship_live_github_connections c ON c.user_id=s.creator_user_id AND c.generation=s.connection_generation
       JOIN ship_live_installations i ON i.id=s.installation_id AND i.active
       WHERE s.token_hash=$1 AND s.expires_at>now()`,
      [hash(token)],
    );
    if (!result.rows[0]) throw unavailableShare();
    return result.rows[0];
  }
}
