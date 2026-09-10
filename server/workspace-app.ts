import express, { type ErrorRequestHandler, type Express } from "express";
import type { ActivityEvent, FeedResponse } from "../shared/types.js";
import type { Workspace } from "../shared/workspaces.js";
import { AuthError, type AuthService, type Principal } from "./auth.js";
import {
  backfillNotice,
  type BackfillResult,
  type GitHubApp,
  type Repo,
} from "./github-app.js";
import { FeedError } from "./github.js";
import {
  normalizeAccessWebhook,
  type AccessChange,
} from "./access-normalize.js";
import { normalizeWebhook, object } from "./normalize.js";
import type { PostgresEventStore } from "./postgres-store.js";
import { verifyWebhookSignature } from "./security.js";
import type {
  AccessibleInstallation,
  WorkspaceStore,
} from "./workspace-store.js";
import { healthRouter } from "./health-app.js";
import { dashboardShareRouter, healthShareRouter } from "./share-app.js";
import { normalizeWallWebhook } from "./wall-normalize.js";
import { WallStore } from "./wall-store.js";

interface WorkspaceAppOptions {
  store: PostgresEventStore;
  auth: AuthService;
  workspaces: WorkspaceStore;
  github?: GitHubApp;
  webhookSecret?: string;
  trustProxyHops?: number;
}
interface Viewer {
  workspace: Workspace;
  repositories: Repo[];
  notice?: string;
}
const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const accessDenied = () =>
  new AuthError(
    403,
    "GitHub repository access could not be verified. Reconnect GitHub and try again.",
  );
function installationId(value: string): number {
  if (!/^[1-9]\d{0,15}$/.test(value) || !positiveId(Number(value)))
    throw new AuthError(400, "Invalid installation.");
  return Number(value);
}

// Operational logs carry messages only: GitHub and database errors never embed tokens.
const failure = (error: unknown) =>
  error instanceof Error ? error.message : "Unknown error";

/** Private workspace API. No organization/key-based feed routes are mounted here. */
export function createWorkspaceApp({
  store,
  auth,
  workspaces,
  github,
  webhookSecret,
  trustProxyHops = 0,
}: WorkspaceAppOptions): Express {
  if (
    !Number.isSafeInteger(trustProxyHops) ||
    trustProxyHops < 0 ||
    trustProxyHops > 5
  )
    throw new Error("TRUST_PROXY_HOPS must be an integer from 0 to 5.");
  const app = express();
  const wall = new WallStore(store.pool);
  app.disable("x-powered-by");
  if (trustProxyHops > 0) app.set("trust proxy", trustProxyHops);
  let connections = 0;
  const attempts = new Map<string, { count: number; reset: number }>();
  function githubApp(): GitHubApp {
    if (!github)
      throw new AuthError(503, "GitHub App connection is not configured.");
    return github;
  }
  async function assertConnection(
    principal: Principal,
    expected: NonNullable<Awaited<ReturnType<WorkspaceStore["connection"]>>>,
  ) {
    const current = await workspaces.connection(principal.user.id);
    if (
      current?.githubUserId !== expected.githubUserId ||
      current.generation !== expected.generation
    )
      throw accessDenied();
  }
  async function notesOnly(
    principal: Principal,
    workspaceId: string,
    notice?: string,
  ): Promise<Viewer> {
    const workspace = await workspaces.get(principal.user.id, workspaceId);
    if (workspace.kind !== "personal" || !workspace.owner) throw accessDenied();
    await auth.assertActive(principal);
    return { workspace, repositories: [], ...(notice ? { notice } : {}) };
  }
  function unavailable(
    principal: Principal,
    workspace: Workspace,
  ): Promise<Viewer> {
    if (workspace.kind !== "personal") throw accessDenied();
    return notesOnly(
      principal,
      workspace.id,
      "Sync GitHub activity to load repository access. Showing private notes only.",
    );
  }
  // Reads authorize from the viewer's synced access snapshot and never call
  // GitHub. Connect, refresh, sync, and access webhooks keep it current.
  async function viewer(
    principal: Principal,
    workspaceId: string,
    sessionAlreadyVerified = false,
  ): Promise<Viewer> {
    if (!sessionAlreadyVerified) await auth.assertActive(principal);
    const workspace = await workspaces.get(principal.user.id, workspaceId);
    if (!workspace.installationId) {
      return notesOnly(principal, workspaceId);
    }
    const repositories =
      github && (await workspaces.installationActive(workspace.installationId))
        ? await workspaces.repositoryAccess(
            principal.user.id,
            workspace.installationId,
          )
        : undefined;
    if (!repositories) return unavailable(principal, workspace);
    await auth.assertActive(principal);
    return { workspace, repositories };
  }
  /**
   * The only read of repository access from GitHub: connect, refresh, sync, and
   * membership webhooks. Background refreshes have no session, so no beforeSave.
   */
  async function syncAccess(userId: string, beforeSave?: () => Promise<void>) {
    const client = githubApp();
    // A webhook narrowing that commits during the GitHub reads makes this listing
    // stale; replaceAccess rejects it and the next attempt reads GitHub again.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const connection = await workspaces.connection(userId);
      if (!connection) throw accessDenied();
      const token = await workspaces.withGrant(userId, (refresh) =>
        client.refresh(refresh),
      );
      const listed = await client.installations(token.accessToken);
      const installations = [];
      for (const item of listed) {
        if (item.suspended) continue;
        // User tokens establish viewer access; installation tokens never do.
        installations.push({
          ...item,
          repositories: await client.repositories(
            token.accessToken,
            item.id,
            listed,
          ),
        });
      }
      await beforeSave?.();
      // Throws when a disconnect or reconnect committed during the GitHub reads.
      if (
        await workspaces.replaceAccess(
          userId,
          connection.generation,
          connection.accessVersion,
          installations,
        )
      )
        return installations;
    }
    throw new AuthError(
      409,
      "GitHub access changed while refreshing. Try again.",
    );
  }
  function refreshAccess(principal: Principal) {
    return syncAccess(principal.user.id, () => auth.assertActive(principal));
  }
  function visible(
    events: ActivityEvent[],
    current: Viewer,
    previous: Workspace,
  ): ActivityEvent[] {
    const allowed = new Set(current.repositories.map((repo) => repo.id));
    return events.filter((event) =>
      event.type === "note"
        ? current.workspace.kind === "personal" && current.workspace.owner
        : current.workspace.installationId === previous.installationId &&
          positiveId(event.repositoryId) &&
          allowed.has(event.repositoryId),
    );
  }
  // Removed repositories leave every viewer's snapshot at once. GitHub's removed
  // list can be empty when a selection changes, so prefer the installation's
  // current selection, read with its own token rather than any user's.
  async function narrowAccess(
    installationId: number,
    payload: Record<string, unknown>,
  ) {
    let current: Repo[] | undefined;
    try {
      current = await githubApp().installationRepositories(installationId);
    } catch (error) {
      console.error(
        "Could not read an installation's repository selection; narrowing from the delivery.",
        failure(error),
      );
    }
    if (current) {
      await workspaces.restrictAccess(
        installationId,
        current.map((repo) => repo.id),
        true,
      );
      return;
    }
    const removed = (
      Array.isArray(payload.repositories_removed)
        ? payload.repositories_removed
        : []
    )
      .map((repo) => object(repo).id)
      .filter(positiveId);
    if (removed.length) {
      await workspaces.restrictAccess(installationId, removed, false);
      return;
    }
    // Nothing names what was removed: fail closed for everyone with access to
    // this installation, then recompute each viewer with their own token.
    const users = await workspaces.accessUsers(installationId);
    await workspaces.restrictAccess(installationId, [], true);
    for (const userId of users) scheduleRefresh(userId);
  }
  // Membership webhooks fail closed for the affected viewers at once, then
  // recompute their access from GitHub after the webhook response is sent.
  async function applyAccessChange(
    installationId: number,
    change: AccessChange,
  ) {
    const users =
      change.githubUserId === undefined
        ? await workspaces.accessUsers(installationId)
        : [await workspaces.connectedUser(change.githubUserId)].filter(
            (user): user is string => Boolean(user),
          );
    if (change.removal) {
      if (change.githubUserId !== undefined)
        for (const userId of users)
          await workspaces.dropAccess(
            userId,
            installationId,
            change.repositoryId,
          );
      else if (change.repositoryId !== undefined)
        await workspaces.restrictAccess(
          installationId,
          [change.repositoryId],
          false,
        );
    }
    for (const userId of users) scheduleRefresh(userId);
  }
  // Background refreshes run a few at a time per process, so one organization's
  // burst cannot stall every other installation. Each user is queued at most once.
  const REFRESH_WORKERS = 4;
  const queuedRefreshes = new Set<string>();
  const refreshBacklog: string[] = [];
  let activeRefreshes = 0;
  function scheduleRefresh(userId: string) {
    if (queuedRefreshes.has(userId)) return;
    queuedRefreshes.add(userId);
    refreshBacklog.push(userId);
    drainRefreshes();
  }
  function drainRefreshes() {
    while (activeRefreshes < REFRESH_WORKERS && refreshBacklog.length) {
      const userId = refreshBacklog.shift()!;
      queuedRefreshes.delete(userId);
      activeRefreshes += 1;
      void syncAccess(userId)
        .then(() => {})
        .catch((error: unknown) => {
          // The viewer keeps the fail-closed snapshot until their next sync.
          console.error(
            "Background GitHub access refresh failed.",
            failure(error),
          );
        })
        .finally(() => {
          activeRefreshes -= 1;
          drainRefreshes();
        });
    }
  }
  // Sync continues after its request returns, so it can outlast browser and
  // proxy timeouts. Its outcome is stored for clients to poll.
  async function runSync(
    principal: Principal,
    workspaceId: string,
    runId: string,
    refresh: boolean,
  ) {
    try {
      // Sync is the explicit moment to re-read repository access from GitHub.
      if (refresh) await refreshAccess(principal);
      const result = await backfill(principal, workspaceId);
      await workspaces.finishSync(workspaceId, runId, {
        status: "succeeded",
        synced: result.synced,
        message: result.notice,
      });
    } catch (error) {
      const known = error instanceof AuthError || error instanceof FeedError;
      if (!known)
        console.error("Background GitHub sync failed.", failure(error));
      await workspaces
        .finishSync(workspaceId, runId, {
          status: "failed",
          message:
            error instanceof AuthError || error instanceof FeedError
              ? error.message
              : "The sync could not be completed. Try again.",
        })
        .catch((recordError: unknown) =>
          console.error(
            "Could not record a sync result.",
            failure(recordError),
          ),
        );
    }
  }
  /** Starts a background sync, or returns the one already running. */
  async function startSync(
    principal: Principal,
    workspaceId: string,
    refresh: boolean,
  ) {
    const { run, started } = await workspaces.startSync(
      workspaceId,
      principal.user.id,
    );
    if (started) void runSync(principal, workspaceId, run.id, refresh);
    return run;
  }
  async function backfill(principal: Principal, workspaceId: string) {
    const client = githubApp();
    const initial = await viewer(principal, workspaceId);
    if (!initial.workspace.installationId)
      throw new AuthError(400, "Connect a GitHub installation before syncing.");
    const totals: BackfillResult = {
      synced: 0,
      scanned: 0,
      resumed: 0,
      failed: 0,
      skipped: 0,
    };
    // The GitHub client bounds each batch to 20; all selected repositories get a turn.
    for (let offset = 0; offset < initial.repositories.length; offset += 20) {
      const current = await viewer(principal, workspaceId);
      if (current.workspace.installationId !== initial.workspace.installationId)
        throw accessDenied();
      const allowed = new Set(current.repositories.map((repo) => repo.id));
      const batch = initial.repositories
        .slice(offset, offset + 20)
        .filter((repo) => allowed.has(repo.id));
      if (!batch.length) continue;
      const batchIds = new Set(batch.map((repo) => repo.id));
      const installation = initial.workspace.installationId;
      const result = await client.backfill(
        installation,
        batch,
        async (events) => {
          await auth.assertActive(principal);
          // Canonical event IDs deduplicate the resume overlap and webhook deliveries.
          await store.merge(
            `installation-${installation}`,
            events.filter(
              (event) =>
                positiveId(event.repositoryId) &&
                batchIds.has(event.repositoryId),
            ),
            { restricted: true, preferExisting: true },
          );
        },
        {
          // Watermarks use the database clock so every replica agrees.
          startedAt: await workspaces.clock(),
          since: await workspaces.syncWatermarks(installation, [...batchIds]),
          onSynced: (repositoryId, syncedAt) =>
            workspaces.markSynced(installation, repositoryId, syncedAt),
        },
      );
      for (const key of Object.keys(totals) as (keyof BackfillResult)[])
        totals[key] += result[key];
    }
    await viewer(principal, workspaceId);
    return { synced: totals.synced, notice: backfillNotice(totals) };
  }

  app.use("/api", (request, response, next) => {
    response.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    if (request.path === "/health") {
      next();
      return;
    }
    const webhook = request.path === "/webhooks/github";
    const key = `${webhook ? "webhook" : "api"}:${request.ip || "unknown"}`;
    const previous = attempts.get(key);
    const current =
      previous && previous.reset > Date.now()
        ? previous
        : { count: 0, reset: Date.now() + 60_000 };
    current.count += 1;
    attempts.set(key, current);
    if (attempts.size > 2000) attempts.delete(attempts.keys().next().value!);
    if (current.count > (webhook ? 600 : 120)) {
      response
        .set("Retry-After", "60")
        .status(429)
        .json({ error: "Too many requests. Try again in a minute." });
      return;
    }
    next();
  });

  app.get("/api/health", async (_request, response) => {
    await store.ping();
    response.json({ status: "ok" });
  });

  // Preserve raw bytes for HMAC verification before any JSON middleware runs.
  app.post(
    "/api/webhooks/github",
    express.raw({ type: "application/json", limit: "2mb" }),
    async (request, response) => {
      if (!webhookSecret)
        throw new AuthError(503, "GitHub webhooks are not configured.");
      if (
        !Buffer.isBuffer(request.body) ||
        !verifyWebhookSignature(
          request.body,
          request.get("x-hub-signature-256"),
          webhookSecret,
        )
      )
        throw new AuthError(401, "Invalid webhook signature.");
      const deliveryId = request.get("x-github-delivery");
      if (!deliveryId || !/^[a-z\d-]{1,100}$/i.test(deliveryId))
        throw new AuthError(400, "Invalid webhook delivery.");
      let payload: Record<string, unknown>;
      try {
        payload = object(JSON.parse(request.body.toString("utf8")));
      } catch {
        throw new AuthError(400, "Invalid webhook JSON.");
      }
      const kind = request.get("x-github-event") || "";
      const action = payload.action;
      if (kind === "github_app_authorization" && action === "revoked") {
        const userId = object(payload.sender).id;
        if (positiveId(userId)) {
          await workspaces.applyLifecycle(deliveryId, {
            kind: "authorization",
            githubUserId: userId,
          });
        }
        response.status(202).json({ accepted: true });
        return;
      }
      const id = object(payload.installation).id;
      const installation = positiveId(id)
        ? await workspaces.installationInfo(id)
        : undefined;
      if (!installation) {
        response.status(202).json({ accepted: true, ignored: true });
        return;
      }
      if (kind === "installation" || kind === "installation_repositories") {
        if (
          kind === "installation" &&
          ["deleted", "suspend", "unsuspend"].includes(String(action))
        )
          await workspaces.applyLifecycle(deliveryId, {
            kind: "installation",
            installationId: installation.id,
            active: action === "unsuspend",
          });
        if (kind === "installation_repositories") {
          const { duplicate } = await workspaces.applyLifecycle(deliveryId, {
            kind: "repositories",
            installationId: installation.id,
          });
          if (!duplicate) await narrowAccess(installation.id, payload);
        }
        response.status(202).json({ accepted: true });
        return;
      }
      const change = normalizeAccessWebhook(kind, payload);
      if (change) {
        if (
          !installation.suspended &&
          change.accountId === installation.accountId
        ) {
          // Records the delivery once, so redeliveries do not repeat the change.
          const { duplicate } = await workspaces.applyLifecycle(deliveryId, {
            kind: "repositories",
            installationId: installation.id,
          });
          if (!duplicate) await applyAccessChange(installation.id, change);
        }
        response.status(202).json({ accepted: true });
        return;
      }
      const repository = object(payload.repository);
      const owner = object(repository.owner);
      const name =
        typeof repository.full_name === "string"
          ? repository.full_name.split("/")
          : [];
      if (
        installation.suspended ||
        !positiveId(repository.id) ||
        owner.id !== installation.accountId ||
        name.length !== 2 ||
        name[0].toLowerCase() !== installation.account.toLowerCase()
      ) {
        response.status(202).json({ accepted: true, ignored: true });
        return;
      }
      const normalized = normalizeWebhook(kind, payload, deliveryId);
      const wallUpdates = normalizeWallWebhook(
        kind,
        payload,
        new Date().toISOString(),
      );
      const events = normalized
        ? [{ ...normalized, repositoryId: repository.id }]
        : [];
      const result = await store.merge(
        `installation-${installation.id}`,
        events,
        { restricted: true, deliveryId },
      );
      // Wall deliveries have their own transaction and deduplication table. Apply
      // on retries too so a transient wall write failure can repair itself even
      // when the activity delivery was already committed.
      if (wallUpdates.length)
        await wall.apply(
          installation.id,
          repository.id,
          name.join("/"),
          deliveryId,
          wallUpdates,
        );
      response
        .status(202)
        .json({ accepted: true, duplicate: result.duplicate });
    },
  );

  app.use(express.json({ limit: "64kb" }));
  app.use(auth.router);
  app.use(dashboardShareRouter({ auth, store, workspaces, github, viewer }));
  app.use(healthRouter({ auth, store, workspaces, viewer }));
  app.use(healthShareRouter({ auth, store, workspaces, github, viewer }));

  // Authorizations that predate stored access, or whose first sync failed, get
  // one automatic snapshot. Failures back off so polling cannot hammer GitHub.
  const BOOTSTRAP_BACKOFF = 15 * 60_000;
  const bootstrapAttempts = new Map<string, number>();
  async function currentAccess(
    principal: Principal,
  ): Promise<AccessibleInstallation[] | undefined> {
    const userId = principal.user.id;
    const stored = await workspaces.access(userId);
    if (stored || !github || !(await workspaces.connection(userId)))
      return stored;
    if (Date.now() - (bootstrapAttempts.get(userId) ?? 0) < BOOTSTRAP_BACKOFF)
      return undefined;
    bootstrapAttempts.set(userId, Date.now());
    if (bootstrapAttempts.size > 2000)
      bootstrapAttempts.delete(bootstrapAttempts.keys().next().value!);
    try {
      const installations = await refreshAccess(principal);
      bootstrapAttempts.delete(userId);
      return installations;
    } catch (error) {
      console.error(
        "Automatic GitHub access snapshot failed; Refresh or Sync retries.",
        failure(error),
      );
      return undefined;
    }
  }
  const installationChoice = (item: AccessibleInstallation) => ({
    id: item.id,
    account: item.account,
    kind: item.kind,
    repositories: item.repositories,
  });

  app.get("/api/workspaces", async (request, response) => {
    const principal = await auth.authenticate(request, response);
    await workspaces.ensurePersonal(principal.user);
    const allowed = new Set(
      ((await currentAccess(principal)) ?? []).map((item) => item.id),
    );
    const items = [];
    for (const item of await workspaces.list(principal.user.id)) {
      if (item.kind === "personal" && item.owner) items.push(item);
      else if (
        github &&
        item.installationId &&
        allowed.has(item.installationId) &&
        (await workspaces.installationActive(item.installationId))
      )
        items.push(item);
    }
    const connection = await workspaces.connection(principal.user.id);
    await auth.assertActive(principal);
    response.json({
      workspaces: items,
      githubConnected: Boolean(connection),
      githubAppConfigured: Boolean(github),
    });
  });
  app.post("/api/github/connect", async (request, response) => {
    const principal = await auth.requireMutation(request, response);
    const client = githubApp();
    const flow = await workspaces.beginConnection(
      principal.user.id,
      principal.sessionId,
    );
    response.json({ url: client.authorizationUrl(flow.state, flow.challenge) });
  });
  app.get("/api/github/callback", async (request, response) => {
    const principal = await auth.authenticate(request, response);
    if (
      typeof request.query.state !== "string" ||
      typeof request.query.code !== "string"
    )
      throw new AuthError(400, "GitHub connection expired. Start again.");
    const verifier = await workspaces.consumeConnection(
      principal.user.id,
      principal.sessionId,
      request.query.state,
    );
    const client = githubApp();
    const token = await client.exchange(request.query.code, verifier);
    const user = await client.user(token.accessToken);
    await auth.assertActive(principal);
    await workspaces.completeConnection(
      principal.user.id,
      principal.sessionId,
      request.query.state,
      user,
      token,
    );
    // The first access snapshot. Refresh or Sync retries if GitHub is unavailable.
    await refreshAccess(principal).catch((error: unknown) => {
      console.error(
        "First GitHub access snapshot failed; Refresh or Sync retries.",
        failure(error),
      );
    });
    response.redirect(new URL("/?github=connected", auth.config.appUrl).href);
  });
  app.get("/api/github/installations", async (request, response) => {
    const principal = await auth.authenticate(request, response);
    const client = githubApp();
    if (!(await workspaces.connection(principal.user.id))) throw accessDenied();
    const installations = (await currentAccess(principal)) ?? [];
    await auth.assertActive(principal);
    response.json({
      installations: installations.map(installationChoice),
      installUrl: client.installUrl(),
    });
  });
  app.post("/api/github/installations/refresh", async (request, response) => {
    const principal = await auth.requireMutation(request, response);
    const client = githubApp();
    const installations = await refreshAccess(principal);
    response.json({
      installations: installations.map(installationChoice),
      installUrl: client.installUrl(),
    });
  });
  app.post(
    "/api/github/installations/:id/connect",
    async (request, response) => {
      const principal = await auth.requireMutation(request, response);
      const id = installationId(request.params.id);
      const client = githubApp();
      const connection = await workspaces.connection(principal.user.id);
      if (!connection) throw accessDenied();
      // Connecting is an explicit sync of the user's access.
      const available = (await refreshAccess(principal)).find(
        (item) => item.id === id,
      );
      if (!available) throw accessDenied();
      const installation = await client.installation(id);
      if (
        installation.suspended ||
        installation.accountId !== available.accountId ||
        installation.kind !== available.kind
      )
        throw accessDenied();
      await assertConnection(principal, connection);
      await auth.assertActive(principal);
      const workspace = await workspaces.connectInstallation(
        principal.user,
        installation,
        connection.githubUserId,
        connection.generation,
      );
      // Access was just refreshed; history imports in the background.
      const run = await startSync(principal, workspace.id, false);
      response.json({ workspace, run });
    },
  );
  app.post("/api/github/disconnect", async (request, response) => {
    const principal = await auth.requireMutation(request, response);
    await workspaces.disconnect(principal.user.id);
    response.sendStatus(204);
  });
  app.post("/api/workspaces/:id/sync", async (request, response) => {
    const principal = await auth.requireMutation(request, response);
    const workspace = await workspaces.get(
      principal.user.id,
      request.params.id,
    );
    githubApp();
    if (!workspace.installationId)
      throw new AuthError(400, "Connect a GitHub installation before syncing.");
    response.status(202).json(await startSync(principal, workspace.id, true));
  });
  app.get("/api/workspaces/:id/sync", async (request, response) => {
    const principal = await auth.authenticate(request, response);
    await workspaces.get(principal.user.id, request.params.id);
    const run = await workspaces.syncRun(request.params.id);
    await auth.assertActive(principal);
    response.json({ run: run ?? null });
  });
  app.post("/api/workspaces/:id/notes", async (request, response) => {
    const principal = await auth.requireMutation(request, response);
    response
      .status(201)
      .json(
        await workspaces.addNote(
          principal.user,
          request.params.id,
          request.body,
        ),
      );
  });
  app.delete("/api/workspaces/:id/notes/:noteId", async (request, response) => {
    const principal = await auth.requireMutation(request, response);
    await workspaces.deleteNote(
      principal.user.id,
      request.params.id,
      request.params.noteId,
    );
    response.sendStatus(204);
  });
  app.get("/api/workspaces/:id/feed", async (request, response) => {
    const principal = await auth.authenticate(request, response);
    // authenticate just verified this session. Each viewer read still verifies
    // it again after resolving permissions, including the final response read.
    const initial = await viewer(principal, request.params.id, true);
    const saved = await workspaces.feed(
      principal.user.id,
      initial.workspace,
      initial.repositories.map((repo) => repo.id),
    );
    // An upstream read or database query can overlap logout, disconnect, or an
    // access change. Recheck the original session and filter against fresh IDs.
    const current = await viewer(principal, initial.workspace.id, true);
    const result: FeedResponse = {
      events: visible(saved, current, initial.workspace),
      organization: current.workspace.name,
      source: "workspace",
      updatedAt: new Date().toISOString(),
      notice:
        current.notice ||
        initial.notice ||
        "Visible repository activity and private journal notes. Historical synchronization covers a bounded part of the last 30 days; pushes arrive through future webhooks.",
    };
    response.json(result);
  });
  app.get("/api/workspaces/:id/wall", async (request, response) => {
    const principal = await auth.authenticate(request, response);
    const initial = await viewer(principal, request.params.id, true);
    const installation = initial.workspace.installationId;
    if (!installation) {
      response.json({ repositories: [], updatedAt: new Date().toISOString() });
      return;
    }
    const saved = await wall.snapshot(
      installation,
      initial.repositories.map((repository) => repository.id),
    );
    const current = await viewer(principal, initial.workspace.id, true);
    if (current.workspace.installationId !== installation) throw accessDenied();
    const allowed = new Set(
      current.repositories.map((repository) => repository.id),
    );
    response.json({
      ...saved,
      repositories: saved.repositories.filter((repository) =>
        allowed.has(repository.repositoryId),
      ),
    });
  });
  app.get("/api/workspaces/:id/events", async (request, response) => {
    const principal = await auth.authenticate(request, response);
    let current = await viewer(principal, request.params.id);
    if (request.destroyed) return;
    if (connections >= 100)
      throw new AuthError(
        503,
        "Live connection limit reached. Try again shortly.",
      );
    connections += 1;
    let closed = false;
    let queued = 0;
    let pending = Promise.resolve();
    let unsubscribe = () => {};
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    function cleanup() {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
      connections -= 1;
    }
    function write(frame: string) {
      if (closed || response.writableEnded) return;
      if (response.writableLength > 1_048_576 || !response.write(frame)) {
        cleanup();
        response.end();
      }
    }
    function revoke() {
      write("event: access-revoked\ndata: {}\n\n");
      cleanup();
      response.end();
    }
    async function revalidate() {
      const signature = (view: Viewer) =>
        `${view.workspace.installationId || ""}:${view.repositories
          .map((repo) => repo.id)
          .sort()
          .join(",")}:${view.notice || ""}`;
      const previous = signature(current);
      current = await viewer(principal, current.workspace.id);
      const changed = signature(current) !== previous;
      if (changed) write("event: refresh\ndata: {}\n\n");
      return changed;
    }
    function enqueue(operation: () => Promise<void>) {
      if (closed) return;
      if (++queued > 100) {
        cleanup();
        response.end();
        return;
      }
      pending = pending
        .then(async () => {
          if (!closed) await operation();
        })
        .catch(revoke)
        .finally(() => {
          queued -= 1;
        });
    }
    response.once("close", cleanup);
    response.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    unsubscribe = store.subscribe((scope, eventId) => {
      if (
        ![
          `workspace-${current.workspace.id}`,
          `account-${principal.user.id}`,
          ...(current.workspace.installationId
            ? [
                `installation-${current.workspace.installationId}`,
                `wall-installation-${current.workspace.installationId}`,
              ]
            : []),
        ].includes(scope)
      )
        return;
      enqueue(async () => {
        const changed = await revalidate();
        if (eventId === "refresh") {
          if (!changed)
            write(
              `${scope.startsWith("wall-installation-") ? "event: wall" : "event: refresh"}\ndata: {}\n\n`,
            );
          return;
        }
        if (scope !== `installation-${current.workspace.installationId}`)
          return;
        const previous = current.workspace;
        const event = await store.get(scope, eventId);
        await revalidate();
        if (
          event &&
          event.type !== "note" &&
          visible([event], current, previous).length
        )
          write(`event: activity\ndata: ${JSON.stringify(event)}\n\n`);
      });
    });
    heartbeat = setInterval(
      () =>
        enqueue(async () => {
          if (!(await revalidate())) write(": heartbeat\n\n");
        }),
      25_000,
    );
    heartbeat.unref();
    response.flushHeaders();
    write("retry: 5000\nevent: connected\ndata: {}\n\n");
  });

  app.use("/api", (_request, response) => {
    response.status(404).json({ error: "Not found." });
  });
  const errors: ErrorRequestHandler = (error, _request, response, _next) => {
    if (response.headersSent) {
      response.end();
      return;
    }
    if (error instanceof AuthError || error instanceof FeedError) {
      if (error instanceof FeedError && error.retryAfter)
        response.set("Retry-After", String(error.retryAfter));
      response.status(error.status).json({ error: error.message });
      return;
    }
    const status =
      error?.type === "entity.too.large"
        ? 413
        : error?.type === "entity.parse.failed"
          ? 400
          : 500;
    response.status(status).json({
      error:
        status === 413
          ? "Request is too large."
          : status === 400
            ? "Invalid JSON request."
            : "The request could not be completed. Please try again.",
    });
  };
  app.use(errors);
  return app;
}
