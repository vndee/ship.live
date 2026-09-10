import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AuthUser } from "../shared/auth.js";
import type { ActivityEvent } from "../shared/types.js";
import type {
  ShipNoteInput,
  SyncRun,
  Workspace,
} from "../shared/workspaces.js";
import { AuthError } from "./auth.js";
import type { GitHubGrant, InstallationInfo, Repo } from "./github-app.js";
import { ACTIVITY_CHANNEL } from "./postgres-notifications.js";
import { combineEvents, FEED_LIMIT } from "./store.js";

export interface AccessibleInstallation extends InstallationInfo {
  repositories: Repo[];
}

interface SyncRunRow {
  id: string;
  status: SyncRun["status"];
  started_at: Date;
  finished_at: Date | null;
  synced: number | null;
  message: string | null;
}
// A run whose process stopped never finishes; report it rather than poll forever.
const SYNC_INTERRUPTED_AFTER = 60 * 60_000;
function syncRun(row: SyncRunRow): SyncRun {
  const interrupted =
    row.status === "running" &&
    Date.now() - row.started_at.getTime() > SYNC_INTERRUPTED_AFTER;
  return {
    id: row.id,
    status: interrupted ? "failed" : row.status,
    startedAt: row.started_at.toISOString(),
    ...(row.finished_at ? { finishedAt: row.finished_at.toISOString() } : {}),
    ...(row.synced === null ? {} : { synced: row.synced }),
    ...(interrupted
      ? { message: "The sync was interrupted. Start it again." }
      : row.message
        ? { message: row.message }
        : {}),
  };
}

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
interface WorkspaceRow {
  id: string;
  name: string;
  kind: "personal" | "team";
  owner_user_id: string | null;
  installation_id: string | null;
  github_account: string | null;
}
interface NoteRow {
  id: string;
  title: string;
  body: string;
  created_at: Date;
  name: string;
}
function workspace(row: WorkspaceRow, userId: string): Workspace {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    owner: row.owner_user_id === userId,
    ...(row.installation_id
      ? {
          installationId: Number(row.installation_id),
          githubAccount: row.github_account ?? undefined,
        }
      : {}),
  };
}
function note(row: NoteRow): ActivityEvent {
  return {
    id: `note-${row.id}`,
    type: "note",
    actor: { login: row.name },
    repo: "journal/notes",
    title: row.title,
    body: row.body,
    occurredAt: row.created_at.toISOString(),
  };
}
function grantError(error: unknown): never {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "23505"
  )
    throw new AuthError(
      409,
      "This GitHub account is already connected to another ship.live account.",
    );
  throw error;
}

/** Server-only storage. Callers pass feed() repository IDs from the viewer's synced access. */
export class WorkspaceStore {
  private readonly key?: Buffer;
  constructor(
    readonly pool: Pool,
    encryptionKey = "",
  ) {
    if (encryptionKey && !/^[a-f\d]{64}$/i.test(encryptionKey))
      throw new Error(
        "TOKEN_ENCRYPTION_KEY must contain 32 bytes as 64 hexadecimal characters.",
      );
    if (encryptionKey) this.key = Buffer.from(encryptionKey, "hex");
  }
  private seal(value: string, context: string): string {
    if (!this.key)
      throw new AuthError(503, "GitHub App token storage is not configured.");
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [
      "v1",
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      data.toString("base64url"),
    ].join(".");
  }
  private unseal(value: string, context: string): string {
    if (!this.key)
      throw new AuthError(503, "GitHub App token storage is not configured.");
    try {
      const [version, iv, tag, data, ...extra] = value.split(".");
      if (version !== "v1" || extra.length || !iv || !tag || !data)
        throw new Error();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(iv, "base64url"),
      );
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(data, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new AuthError(401, "Reconnect your GitHub App connection.");
    }
  }
  private async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  private async notify(
    client: Pool | PoolClient,
    scope: string,
  ): Promise<void> {
    await client.query("SELECT pg_notify($1,$2)", [
      ACTIVITY_CHANNEL,
      JSON.stringify({ organization: scope, eventId: "refresh" }),
    ]);
  }
  private async lockUser(client: PoolClient, userId: string): Promise<void> {
    const result = await client.query(
      "SELECT id FROM ship_live_auth_users WHERE id=$1 FOR UPDATE",
      [userId],
    );
    if (!result.rowCount)
      throw new AuthError(401, "Sign in again to connect GitHub.");
  }
  async ensurePersonal(user: AuthUser): Promise<Workspace> {
    const result = await this.pool.query<WorkspaceRow>(
      `INSERT INTO ship_live_workspaces(id,name,kind,owner_user_id)
      VALUES($1,$2,'personal',$3) ON CONFLICT(owner_user_id) DO UPDATE SET owner_user_id=EXCLUDED.owner_user_id RETURNING *`,
      [randomUUID(), `${user.name}'s journal`, user.id],
    );
    return workspace(result.rows[0], user.id);
  }
  async list(userId: string): Promise<Workspace[]> {
    const result = await this.pool.query<WorkspaceRow>(
      `SELECT w.* FROM ship_live_workspaces w WHERE owner_user_id=$1
      OR EXISTS(SELECT 1 FROM ship_live_workspace_members m WHERE m.workspace_id=w.id AND m.user_id=$1)
      ORDER BY kind,name,id`,
      [userId],
    );
    return result.rows.map((row) => workspace(row, userId));
  }
  async get(userId: string, id: string): Promise<Workspace> {
    if (!uuid.test(id)) throw new AuthError(404, "Workspace not found.");
    const result = await this.pool.query<WorkspaceRow>(
      `SELECT w.* FROM ship_live_workspaces w WHERE id=$2 AND (owner_user_id=$1
      OR EXISTS(SELECT 1 FROM ship_live_workspace_members m WHERE m.workspace_id=w.id AND m.user_id=$1))`,
      [userId, id],
    );
    if (!result.rows[0]) throw new AuthError(404, "Workspace not found.");
    return workspace(result.rows[0], userId);
  }
  private async personal(userId: string, id: string): Promise<Workspace> {
    const result = await this.get(userId, id);
    if (result.kind !== "personal" || !result.owner)
      throw new AuthError(404, "Journal not found.");
    return result;
  }
  async notes(userId: string, workspaceId: string): Promise<ActivityEvent[]> {
    await this.personal(userId, workspaceId);
    const rows = await this.pool.query<NoteRow>(
      `SELECT n.*,u.name FROM ship_live_notes n JOIN ship_live_auth_users u ON u.id=n.user_id
      WHERE n.workspace_id=$1 AND n.user_id=$2 ORDER BY n.created_at DESC,n.id LIMIT $3`,
      [workspaceId, userId, FEED_LIMIT],
    );
    return rows.rows.map(note);
  }
  async addNote(
    user: AuthUser,
    workspaceId: string,
    input: ShipNoteInput,
  ): Promise<ActivityEvent> {
    await this.personal(user.id, workspaceId);
    if (
      !input ||
      typeof input.title !== "string" ||
      !input.title.trim() ||
      input.title.trim().length > 200 ||
      typeof input.body !== "string" ||
      input.body.length > 10000 ||
      /\0/.test(input.title + input.body)
    )
      throw new AuthError(
        400,
        "Use a title up to 200 characters and a note up to 10,000 characters.",
      );
    return this.transaction(async (client) => {
      const rows = await client.query<NoteRow>(
        "INSERT INTO ship_live_notes(id,workspace_id,user_id,title,body) VALUES($1,$2,$3,$4,$5) RETURNING *, $6::text AS name",
        [
          randomUUID(),
          workspaceId,
          user.id,
          input.title.trim(),
          input.body,
          user.name,
        ],
      );
      await this.notify(client, `workspace-${workspaceId}`);
      return note(rows.rows[0]);
    });
  }
  async deleteNote(
    userId: string,
    workspaceId: string,
    noteId: string,
  ): Promise<void> {
    await this.personal(userId, workspaceId);
    const id = noteId.replace(/^note-/, "");
    if (!uuid.test(id)) throw new AuthError(404, "Note not found.");
    await this.transaction(async (client) => {
      const result = await client.query(
        "DELETE FROM ship_live_notes WHERE id=$1 AND workspace_id=$2 AND user_id=$3",
        [id, workspaceId, userId],
      );
      if (!result.rowCount) throw new AuthError(404, "Note not found.");
      await this.notify(client, `workspace-${workspaceId}`);
    });
  }
  async connection(userId: string): Promise<
    | {
        githubUserId: number;
        login: string;
        generation: string;
        /** Pass to replaceAccess to reject listings read before a narrowing. */
        accessVersion: string;
      }
    | undefined
  > {
    const result = await this.pool.query<{
      github_user_id: string;
      login: string;
      generation: string;
      access_version: string;
    }>(
      "SELECT github_user_id,login,generation,access_version FROM ship_live_github_connections WHERE user_id=$1",
      [userId],
    );
    const row = result.rows[0];
    return row
      ? {
          githubUserId: Number(row.github_user_id),
          login: row.login,
          generation: row.generation,
          accessVersion: row.access_version,
        }
      : undefined;
  }
  private async writeGrant(
    client: PoolClient,
    userId: string,
    user: { id: number; login: string },
    grant: GitHubGrant,
  ): Promise<void> {
    const previous = await client.query<{ github_user_id: string }>(
      "SELECT github_user_id FROM ship_live_github_connections WHERE user_id=$1 FOR UPDATE",
      [userId],
    );
    if (
      previous.rows[0] &&
      Number(previous.rows[0].github_user_id) !== user.id
    ) {
      await client.query(
        "DELETE FROM ship_live_workspace_members WHERE user_id=$1",
        [userId],
      );
      await client.query(
        "UPDATE ship_live_workspaces SET installation_id=NULL,github_account=NULL WHERE owner_user_id=$1",
        [userId],
      );
    }
    // A new authorization starts without synced repository access.
    await client.query("DELETE FROM ship_live_github_access WHERE user_id=$1", [
      userId,
    ]);
    await client.query(
      `INSERT INTO ship_live_github_connections(user_id,github_user_id,login,encrypted_grant,generation) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(user_id) DO UPDATE SET github_user_id=EXCLUDED.github_user_id,login=EXCLUDED.login,encrypted_grant=EXCLUDED.encrypted_grant,generation=EXCLUDED.generation,access_synced_at=NULL,updated_at=now()`,
      [
        userId,
        user.id,
        user.login,
        this.seal(JSON.stringify(grant), `github:${userId}`),
        randomUUID(),
      ],
    );
    await this.notify(client, `account-${userId}`);
  }
  /** Storage fixture/import helper. OAuth callbacks must use completeConnection. */
  async saveGrant(
    userId: string,
    user: { id: number; login: string },
    grant: GitHubGrant,
  ): Promise<void> {
    try {
      await this.transaction(async (client) => {
        await this.lockUser(client, userId);
        await this.writeGrant(client, userId, user, grant);
      });
    } catch (error) {
      grantError(error);
    }
  }
  async withGrant(
    userId: string,
    refresh: (token: string) => Promise<GitHubGrant>,
  ): Promise<GitHubGrant> {
    // Row locking serializes rotating refresh credentials across all replicas.
    const result = await this.transaction(async (client) => {
      // All GitHub mutations lock the stable user row before a connection row;
      // disconnect/reconnect is serialized even when no connection row exists.
      await this.lockUser(client, userId);
      const rows = await client.query<{ encrypted_grant: string }>(
        "SELECT encrypted_grant FROM ship_live_github_connections WHERE user_id=$1 FOR UPDATE",
        [userId],
      );
      if (!rows.rows[0])
        throw new AuthError(
          401,
          "Connect your GitHub App to read repository activity.",
        );
      const grant = JSON.parse(
        this.unseal(rows.rows[0].encrypted_grant, `github:${userId}`),
      ) as GitHubGrant;
      if (grant.expiresAt > Date.now() + 60000) return { grant };
      try {
        if (
          !grant.refreshToken ||
          (grant.refreshExpiresAt && grant.refreshExpiresAt <= Date.now())
        )
          throw new Error();
        const next = await refresh(grant.refreshToken);
        await client.query(
          "UPDATE ship_live_github_connections SET encrypted_grant=$2,updated_at=now() WHERE user_id=$1",
          [userId, this.seal(JSON.stringify(next), `github:${userId}`)],
        );
        return { grant: next };
      } catch {
        // An uncertain refresh may have rotated the token. Never reuse its old pair.
        await this.disconnectWith(client, userId);
        return { grant: undefined };
      }
    });
    if (!result.grant)
      throw new AuthError(
        401,
        "Your GitHub connection expired. Connect it again.",
      );
    return result.grant;
  }
  async beginConnection(
    userId: string,
    sessionId: string,
  ): Promise<{ state: string; challenge: string }> {
    const state = randomBytes(32).toString("base64url"),
      verifier = randomBytes(48).toString("base64url");
    await this.transaction(async (client) => {
      await this.lockUser(client, userId);
      await client.query(
        "DELETE FROM ship_live_github_flows WHERE user_id=$1",
        [userId],
      );
      await client.query(
        "INSERT INTO ship_live_github_flows(state_hash,user_id,session_id,encrypted_verifier,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')",
        [
          hash(state),
          userId,
          sessionId,
          this.seal(verifier, `flow:${userId}:${hash(state)}`),
        ],
      );
    });
    return {
      state,
      challenge: createHash("sha256").update(verifier).digest("base64url"),
    };
  }
  async consumeConnection(
    userId: string,
    sessionId: string,
    state: string,
  ): Promise<string> {
    if (!/^[\w-]{43}$/.test(state))
      throw new AuthError(400, "GitHub connection expired. Start again.");
    return this.transaction(async (client) => {
      await this.lockUser(client, userId);
      const result = await client.query<{ encrypted_verifier: string }>(
        "UPDATE ship_live_github_flows SET consumed=true WHERE state_hash=$1 AND user_id=$2 AND session_id=$3 AND expires_at>now() AND consumed=false RETURNING encrypted_verifier",
        [hash(state), userId, sessionId],
      );
      if (!result.rows[0])
        throw new AuthError(400, "GitHub connection expired. Start again.");
      return this.unseal(
        result.rows[0].encrypted_verifier,
        `flow:${userId}:${hash(state)}`,
      );
    });
  }
  async completeConnection(
    userId: string,
    sessionId: string,
    state: string,
    user: { id: number; login: string },
    grant: GitHubGrant,
  ): Promise<void> {
    if (!/^[\w-]{43}$/.test(state))
      throw new AuthError(400, "GitHub connection expired. Start again.");
    try {
      await this.transaction(async (client) => {
        await this.lockUser(client, userId);
        const claimed = await client.query(
          "DELETE FROM ship_live_github_flows WHERE state_hash=$1 AND user_id=$2 AND session_id=$3 AND expires_at>now() AND consumed=true RETURNING state_hash",
          [hash(state), userId, sessionId],
        );
        if (!claimed.rowCount)
          throw new AuthError(400, "GitHub connection expired. Start again.");
        // Share lock makes local logout linearize before or after this commit.
        const session = await client.query(
          "SELECT token_hash FROM ship_live_auth_sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now() FOR SHARE",
          [sessionId, userId],
        );
        if (!session.rowCount)
          throw new AuthError(401, "Sign in again to connect GitHub.");
        await this.writeGrant(client, userId, user, grant);
      });
    } catch (error) {
      grantError(error);
    }
  }
  async disconnect(userId: string): Promise<void> {
    await this.transaction(async (client) => {
      await this.lockUser(client, userId);
      await this.disconnectWith(client, userId);
    });
  }
  private async disconnectWith(
    client: PoolClient,
    userId: string,
  ): Promise<void> {
    await client.query(
      "DELETE FROM ship_live_github_connections WHERE user_id=$1",
      [userId],
    );
    await client.query("DELETE FROM ship_live_github_flows WHERE user_id=$1", [
      userId,
    ]);
    await client.query(
      "DELETE FROM ship_live_workspace_members WHERE user_id=$1",
      [userId],
    );
    await client.query(
      "UPDATE ship_live_workspaces SET installation_id=NULL,github_account=NULL WHERE owner_user_id=$1",
      [userId],
    );
    await this.notify(client, `account-${userId}`);
  }
  async revokeGithubUser(githubUserId: number): Promise<void> {
    await this.transaction((client) => this.revokeWith(client, githubUserId));
  }
  private async revokeWith(
    client: PoolClient,
    githubUserId: number,
  ): Promise<void> {
    const rows = await client.query<{ user_id: string }>(
      "SELECT user_id FROM ship_live_github_connections WHERE github_user_id=$1",
      [githubUserId],
    );
    for (const row of rows.rows) {
      await this.lockUser(client, row.user_id);
      const current = await client.query(
        "SELECT user_id FROM ship_live_github_connections WHERE user_id=$1 AND github_user_id=$2 FOR UPDATE",
        [row.user_id, githubUserId],
      );
      if (current.rowCount) await this.disconnectWith(client, row.user_id);
    }
  }
  async applyLifecycle(
    deliveryId: string,
    change:
      | { kind: "installation"; installationId: number; active: boolean }
      | { kind: "repositories"; installationId: number }
      | { kind: "authorization"; githubUserId: number },
  ): Promise<{ duplicate: boolean }> {
    return this.transaction(async (client) => {
      const accepted = await client.query(
        "INSERT INTO ship_live_deliveries(delivery_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING delivery_id",
        [deliveryId],
      );
      if (!accepted.rowCount) return { duplicate: true };
      if (change.kind === "authorization")
        await this.revokeWith(client, change.githubUserId);
      else {
        if (change.kind === "installation")
          await client.query(
            "UPDATE ship_live_installations SET active=$2,updated_at=now() WHERE id=$1",
            [change.installationId, change.active],
          );
        await this.notify(client, `installation-${change.installationId}`);
      }
      return { duplicate: false };
    });
  }
  async connectInstallation(
    user: AuthUser,
    installation: InstallationInfo,
    githubUserId: number,
    expectedGeneration: string,
  ): Promise<Workspace> {
    if (installation.suspended)
      throw new AuthError(403, "This GitHub App installation is suspended.");
    if (installation.kind === "User" && installation.accountId !== githubUserId)
      throw new AuthError(
        403,
        "A personal journal can connect only its owner's GitHub installation.",
      );
    if (installation.kind === "User") await this.ensurePersonal(user);
    return this.transaction(async (client) => {
      await this.lockUser(client, user.id);
      const current = await client.query(
        "SELECT user_id FROM ship_live_github_connections WHERE user_id=$1 AND github_user_id=$2 AND generation=$3 FOR UPDATE",
        [user.id, githubUserId, expectedGeneration],
      );
      if (!current.rowCount)
        throw new AuthError(
          403,
          "Your GitHub connection changed. Choose an installation again.",
        );
      await client.query(
        `INSERT INTO ship_live_installations(id,account_id,account_login,kind,active) VALUES($1,$2,$3,$4,true)
        ON CONFLICT(id) DO UPDATE SET account_id=EXCLUDED.account_id,account_login=EXCLUDED.account_login,kind=EXCLUDED.kind,active=true,updated_at=now()`,
        [
          installation.id,
          installation.accountId,
          installation.account,
          installation.kind,
        ],
      );
      let rows;
      if (installation.kind === "User") {
        const occupied = await client.query(
          "SELECT id FROM ship_live_workspaces WHERE installation_id=$1 AND owner_user_id<>$2",
          [installation.id, user.id],
        );
        if (occupied.rowCount)
          throw new AuthError(
            409,
            "This personal installation is connected to another journal.",
          );
        rows = await client.query<WorkspaceRow>(
          "UPDATE ship_live_workspaces SET installation_id=$2,github_account=$3 WHERE owner_user_id=$1 RETURNING *",
          [user.id, installation.id, installation.account],
        );
      } else {
        rows = await client.query<WorkspaceRow>(
          `INSERT INTO ship_live_workspaces(id,name,kind,installation_id,github_account) VALUES($1,$2,'team',$3,$2)
          ON CONFLICT(installation_id) DO UPDATE SET github_account=EXCLUDED.github_account,name=EXCLUDED.name RETURNING *`,
          [randomUUID(), installation.account, installation.id],
        );
        await client.query(
          "INSERT INTO ship_live_workspace_members(workspace_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [rows.rows[0].id, user.id],
        );
      }
      await this.notify(client, `workspace-${rows.rows[0].id}`);
      return workspace(rows.rows[0], user.id);
    });
  }
  async installationInfo(id: number): Promise<InstallationInfo | undefined> {
    const result = await this.pool.query<{
      id: string;
      account_id: string;
      account_login: string;
      kind: "User" | "Organization";
      active: boolean;
    }>("SELECT * FROM ship_live_installations WHERE id=$1", [id]);
    const row = result.rows[0];
    return row
      ? {
          id: Number(row.id),
          accountId: Number(row.account_id),
          account: row.account_login,
          kind: row.kind,
          suspended: !row.active,
        }
      : undefined;
  }
  async installationActive(id: number): Promise<boolean> {
    const installation = await this.installationInfo(id);
    return Boolean(installation && !installation.suspended);
  }
  async setInstallationActive(id: number, active: boolean): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        "UPDATE ship_live_installations SET active=$2,updated_at=now() WHERE id=$1",
        [id, active],
      );
      await this.notify(client, `installation-${id}`);
    });
  }
  async notifyInstallation(id: number): Promise<void> {
    await this.notify(this.pool, `installation-${id}`);
  }
  /**
   * Replace the viewer's snapshot with a fresh listing for their current
   * authorization. Returns false, writing nothing, when access was narrowed
   * after the listing began, because that listing may predate the removal.
   */
  async replaceAccess(
    userId: string,
    generation: string,
    accessVersion: string,
    installations: AccessibleInstallation[],
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      await this.lockUser(client, userId);
      const current = await client.query<{ access_version: string }>(
        "SELECT access_version FROM ship_live_github_connections WHERE user_id=$1 AND generation=$2 FOR UPDATE",
        [userId, generation],
      );
      if (!current.rows[0])
        throw new AuthError(
          403,
          "Your GitHub connection changed. Refresh GitHub access again.",
        );
      if (current.rows[0].access_version !== accessVersion) return false;
      await client.query(
        "DELETE FROM ship_live_github_access WHERE user_id=$1",
        [userId],
      );
      for (const item of installations)
        await client.query(
          `INSERT INTO ship_live_github_access(user_id,generation,installation_id,account_id,account_login,kind,repositories)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            userId,
            generation,
            item.id,
            item.accountId,
            item.account,
            item.kind,
            JSON.stringify(
              item.repositories.map((repo) => ({
                id: repo.id,
                name: repo.name,
                private: repo.private,
              })),
            ),
          ],
        );
      await client.query(
        "UPDATE ship_live_github_connections SET access_synced_at=now() WHERE user_id=$1",
        [userId],
      );
      await this.notify(client, `account-${userId}`);
      return true;
    });
  }
  /** Synced installations, or undefined when this authorization was never synced. */
  async access(userId: string): Promise<AccessibleInstallation[] | undefined> {
    const result = await this.pool.query<{
      access_synced_at: Date | null;
      installation_id: string | null;
      account_id: string;
      account_login: string;
      kind: "User" | "Organization";
      repositories: Repo[];
    }>(
      `SELECT c.access_synced_at,a.installation_id,a.account_id,a.account_login,a.kind,a.repositories
      FROM ship_live_github_connections c
      LEFT JOIN ship_live_github_access a ON a.user_id=c.user_id AND a.generation=c.generation
      WHERE c.user_id=$1 ORDER BY a.account_login,a.installation_id`,
      [userId],
    );
    if (!result.rows[0]?.access_synced_at) return undefined;
    return result.rows
      .filter((row) => row.installation_id)
      .map((row) => ({
        id: Number(row.installation_id),
        accountId: Number(row.account_id),
        account: row.account_login,
        kind: row.kind,
        suspended: false,
        repositories: row.repositories,
      }));
  }
  /** Repositories the viewer could access in an installation at their last sync. */
  async repositoryAccess(
    userId: string,
    installationId: number,
  ): Promise<Repo[] | undefined> {
    const result = await this.pool.query<{ repositories: Repo[] }>(
      `SELECT a.repositories FROM ship_live_github_access a
      JOIN ship_live_github_connections c ON c.user_id=a.user_id AND c.generation=a.generation
      WHERE a.user_id=$1 AND a.installation_id=$2`,
      [userId, installationId],
    );
    return result.rows[0]?.repositories;
  }
  /** Narrow every viewer's snapshot: keep only, or remove, the given repository IDs. */
  async restrictAccess(
    installationId: number,
    repositoryIds: number[],
    keep: boolean,
  ): Promise<void> {
    await this.narrow(
      installationId,
      repositoryIds,
      keep,
      `installation-${installationId}`,
    );
  }
  /** Fail closed for one viewer: drop one repository, or all, until access is recomputed. */
  async dropAccess(
    userId: string,
    installationId: number,
    repositoryId?: number,
  ): Promise<void> {
    // Keeping none of an empty list drops everything; removing one keeps the rest.
    await this.narrow(
      installationId,
      repositoryId === undefined ? [] : [repositoryId],
      repositoryId === undefined,
      `account-${userId}`,
      userId,
    );
  }
  // Rewrites stored repository lists and bumps access_version for the affected
  // viewers, so a refresh that read GitHub before this change cannot undo it.
  private async narrow(
    installationId: number,
    repositoryIds: number[],
    keep: boolean,
    scope: string,
    userId?: string,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const narrowed = await client.query<{ user_id: string }>(
        `UPDATE ship_live_github_access SET repositories=COALESCE((
          SELECT jsonb_agg(repo) FROM jsonb_array_elements(repositories) repo
          WHERE ((repo->>'id')::bigint = ANY($2::bigint[])) = $3
        ),'[]'::jsonb) WHERE installation_id=$1 AND ($4::uuid IS NULL OR user_id=$4)
        RETURNING user_id`,
        [installationId, repositoryIds, keep, userId ?? null],
      );
      await client.query(
        "UPDATE ship_live_github_connections SET access_version=access_version+1 WHERE user_id=ANY($1::uuid[]) OR user_id=$2",
        [narrowed.rows.map((row) => row.user_id), userId ?? null],
      );
      await this.notify(client, scope);
    });
  }
  async connectedUser(githubUserId: number): Promise<string | undefined> {
    const result = await this.pool.query<{ user_id: string }>(
      "SELECT user_id FROM ship_live_github_connections WHERE github_user_id=$1",
      [githubUserId],
    );
    return result.rows[0]?.user_id;
  }
  /** Viewers whose current authorization has synced access to an installation. */
  async accessUsers(installationId: number): Promise<string[]> {
    const result = await this.pool.query<{ user_id: string }>(
      `SELECT a.user_id FROM ship_live_github_access a
      JOIN ship_live_github_connections c ON c.user_id=a.user_id AND c.generation=a.generation
      WHERE a.installation_id=$1`,
      [installationId],
    );
    return result.rows.map((row) => row.user_id);
  }
  /** Start a background sync unless one is running; an interrupted run can be replaced. */
  async startSync(
    workspaceId: string,
    userId: string,
  ): Promise<{ run: SyncRun; started: boolean }> {
    const started = await this.pool.query<SyncRunRow>(
      `INSERT INTO ship_live_sync_runs(workspace_id,id,user_id,status) VALUES($1,$2,$3,'running')
      ON CONFLICT(workspace_id) DO UPDATE SET id=EXCLUDED.id,user_id=EXCLUDED.user_id,status='running',
        started_at=now(),finished_at=NULL,synced=NULL,message=NULL
      WHERE ship_live_sync_runs.status<>'running'
        OR ship_live_sync_runs.started_at<now()-make_interval(secs=>$4)
      RETURNING *`,
      [workspaceId, randomUUID(), userId, SYNC_INTERRUPTED_AFTER / 1000],
    );
    if (started.rows[0])
      return { run: syncRun(started.rows[0]), started: true };
    return { run: (await this.syncRun(workspaceId))!, started: false };
  }
  /** Only the run that is still current records its outcome. */
  async finishSync(
    workspaceId: string,
    runId: string,
    outcome: {
      status: "succeeded" | "failed";
      synced?: number;
      message: string;
    },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ship_live_sync_runs SET status=$3,finished_at=now(),synced=$4,message=$5
      WHERE workspace_id=$1 AND id=$2 AND status='running'`,
      [
        workspaceId,
        runId,
        outcome.status,
        outcome.synced ?? null,
        outcome.message,
      ],
    );
  }
  async syncRun(workspaceId: string): Promise<SyncRun | undefined> {
    const result = await this.pool.query<SyncRunRow>(
      "SELECT * FROM ship_live_sync_runs WHERE workspace_id=$1",
      [workspaceId],
    );
    return result.rows[0] && syncRun(result.rows[0]);
  }
  /** The database clock, shared by every replica. */
  async clock(): Promise<number> {
    const result = await this.pool.query<{ now: Date }>("SELECT now()");
    return result.rows[0].now.getTime();
  }
  /** When each repository's history was last imported, in epoch milliseconds. */
  async syncWatermarks(
    installationId: number,
    repositoryIds: number[],
  ): Promise<Map<number, number>> {
    const result = await this.pool.query<{
      repository_id: string;
      synced_at: Date;
    }>(
      "SELECT repository_id,synced_at FROM ship_live_repository_sync WHERE installation_id=$1 AND repository_id=ANY($2::bigint[])",
      [installationId, repositoryIds],
    );
    return new Map(
      result.rows.map((row) => [
        Number(row.repository_id),
        row.synced_at.getTime(),
      ]),
    );
  }
  /** Watermarks only move forward, even when overlapping syncs finish out of order. */
  async markSynced(
    installationId: number,
    repositoryId: number,
    syncedAt: number,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO ship_live_repository_sync(installation_id,repository_id,synced_at) VALUES($1,$2,$3)
      ON CONFLICT(installation_id,repository_id) DO UPDATE SET synced_at=GREATEST(ship_live_repository_sync.synced_at,EXCLUDED.synced_at)`,
      [installationId, repositoryId, new Date(syncedAt)],
    );
  }
  async feed(
    userId: string,
    selected: Workspace,
    allowedRepoIds: number[],
  ): Promise<ActivityEvent[]> {
    const current = await this.get(userId, selected.id);
    const personalNotes =
      current.kind === "personal" ? await this.notes(userId, current.id) : [];
    if (!current.installationId || !allowedRepoIds.length) return personalNotes;
    if (!(await this.installationActive(current.installationId)))
      throw new AuthError(
        403,
        "This GitHub App installation is no longer available.",
      );
    const rows = await this.pool.query<{ event: ActivityEvent }>(
      `SELECT event FROM ship_live_events WHERE organization=$1
      AND event->>'repositoryId'=ANY($2::text[]) ORDER BY occurred_at DESC,event_id LIMIT $3`,
      [
        `installation-${current.installationId}`,
        allowedRepoIds.map(String),
        FEED_LIMIT,
      ],
    );
    return combineEvents(
      personalNotes,
      rows.rows.map((row) => row.event),
    );
  }
}
