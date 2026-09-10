import express, { type ErrorRequestHandler, type Express } from "express";
import type { ActivityEvent, FeedResponse } from "../shared/types.js";
import type { Workspace } from "../shared/workspaces.js";
import { AuthError, type AuthService, type Principal } from "./auth.js";
import type { GitHubApp, Repo } from "./github-app.js";
import { FeedError } from "./github.js";
import { normalizeWebhook, object } from "./normalize.js";
import type { PostgresEventStore } from "./postgres-store.js";
import { verifyWebhookSignature } from "./security.js";
import type { WorkspaceStore } from "./workspace-store.js";
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
  async function grant(principal: Principal) {
    const client = githubApp();
    return workspaces.withGrant(principal.user.id, (token) =>
      client.refresh(token),
    );
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
      "GitHub access could not be verified. Showing private notes only.",
    );
  }
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
    const connection = await workspaces.connection(principal.user.id);
    if (!connection && workspace.kind === "personal") {
      return unavailable(principal, workspace);
    }
    if (
      !connection ||
      !github ||
      !(await workspaces.installationActive(workspace.installationId))
    )
      return unavailable(principal, workspace);
    let repositories: Repo[];
    try {
      const token = await grant(principal);
      // This endpoint checks complete user-visible installation/repository grants.
      // Installation tokens must never establish a viewer's repository access.
      repositories = await github.repositories(
        token.accessToken,
        workspace.installationId,
      );
    } catch {
      return unavailable(principal, workspace);
    }
    // GitHub calls can overlap a disconnect or installation suspension on any
    // replica. Membership and the connected GitHub account must still match.
    const current = await workspaces.get(principal.user.id, workspaceId);
    const currentConnection = await workspaces.connection(principal.user.id);
    if (
      current.installationId !== workspace.installationId ||
      currentConnection?.githubUserId !== connection.githubUserId ||
      currentConnection?.generation !== connection.generation ||
      !(await workspaces.installationActive(workspace.installationId))
    )
      return unavailable(principal, current);
    await auth.assertActive(principal);
    return { workspace: current, repositories };
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
  async function backfill(principal: Principal, workspaceId: string) {
    const client = githubApp();
    const initial = await viewer(principal, workspaceId);
    if (!initial.workspace.installationId)
      throw new AuthError(400, "Connect a GitHub installation before syncing.");
    const notices = new Set<string>();
    let synced = 0;
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
      const result = await client.backfill(
        initial.workspace.installationId,
        batch,
        async (events) => {
          await auth.assertActive(principal);
          await store.merge(
            `installation-${initial.workspace.installationId}`,
            events.filter(
              (event) =>
                positiveId(event.repositoryId) &&
                batchIds.has(event.repositoryId),
            ),
            { restricted: true, preferExisting: true },
          );
        },
      );
      synced += result.synced;
      notices.add(result.notice);
    }
    await viewer(principal, workspaceId);
    return {
      synced,
      notice:
        [...notices].join(" ") ||
        "No repositories are currently visible to your GitHub account.",
    };
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
        if (kind === "installation_repositories")
          await workspaces.applyLifecycle(deliveryId, {
            kind: "repositories",
            installationId: installation.id,
          });
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

  app.get("/api/workspaces", async (request, response) => {
    const principal = await auth.authenticate(request, response);
    await workspaces.ensurePersonal(principal.user);
    const connection = await workspaces.connection(principal.user.id);
    const allowed = new Set<number>();
    if (github && connection) {
      try {
        const token = await grant(principal);
        const installations = await github.installations(token.accessToken);
        await assertConnection(principal, connection);
        for (const installation of installations)
          if (!installation.suspended) allowed.add(installation.id);
      } catch {
        /* An unavailable GitHub grant must not reveal team metadata. */
      }
    }
    const items = [];
    for (const item of await workspaces.list(principal.user.id)) {
      if (item.kind === "personal" && item.owner) items.push(item);
      else if (
        item.installationId &&
        allowed.has(item.installationId) &&
        (await workspaces.installationActive(item.installationId))
      )
        items.push(item);
    }
    const currentConnection = await workspaces.connection(principal.user.id);
    const sameConnection =
      connection && currentConnection?.generation === connection.generation;
    await auth.assertActive(principal);
    response.json({
      workspaces: sameConnection
        ? items
        : items.filter((item) => item.kind === "personal" && item.owner),
      githubConnected: Boolean(currentConnection),
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
    response.redirect(new URL("/?github=connected", auth.config.appUrl).href);
  });
  app.get("/api/github/installations", async (request, response) => {
    const principal = await auth.authenticate(request, response);
    const client = githubApp();
    const connection = await workspaces.connection(principal.user.id);
    if (!connection) throw accessDenied();
    const token = await grant(principal);
    const installations = [];
    for (const item of await client.installations(token.accessToken)) {
      if (item.suspended) continue;
      const repositories = await client.repositories(
        token.accessToken,
        item.id,
      );
      installations.push({
        id: item.id,
        account: item.account,
        kind: item.kind,
        repositories,
      });
    }
    await assertConnection(principal, connection);
    await auth.assertActive(principal);
    response.json({ installations, installUrl: client.installUrl() });
  });
  app.post(
    "/api/github/installations/:id/connect",
    async (request, response) => {
      const principal = await auth.requireMutation(request, response);
      const id = installationId(request.params.id);
      const client = githubApp();
      const connection = await workspaces.connection(principal.user.id);
      if (!connection) throw accessDenied();
      const token = await grant(principal);
      const available = (await client.installations(token.accessToken)).find(
        (item) => item.id === id && !item.suspended,
      );
      if (!available || !connection) throw accessDenied();
      await client.repositories(token.accessToken, id);
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
      const result = await backfill(principal, workspace.id);
      response.json({ workspace, notice: result.notice });
    },
  );
  app.post("/api/github/disconnect", async (request, response) => {
    const principal = await auth.requireMutation(request, response);
    await workspaces.disconnect(principal.user.id);
    response.sendStatus(204);
  });
  app.post("/api/workspaces/:id/sync", async (request, response) => {
    const principal = await auth.requireMutation(request, response);
    response.json(await backfill(principal, request.params.id));
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
