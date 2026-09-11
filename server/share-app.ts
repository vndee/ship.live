import { HealthStore } from "./health-store.js";
import type { SharedHealthSnapshot } from "../shared/health.js";
import { Router } from "express";
import { SHARE_DURATIONS, type SharedFeedResponse } from "../shared/shares.js";
import type { Workspace } from "../shared/workspaces.js";
import { AuthError, type AuthService, type Principal } from "./auth.js";
import type { GitHubApp, Repo } from "./github-app.js";
import type { PostgresEventStore } from "./postgres-store.js";
import type { SecretBox } from "./secret-box.js";
import { DashboardShareStore, unavailableShare } from "./share-store.js";
import type { WorkspaceStore } from "./workspace-store.js";
import { WallStore } from "./wall-store.js";
import { liveConnections } from "./metrics.js";

function workspaceShareRouter(
  {
    auth,
    store,
    workspaces,
    github,
    viewer,
    secrets,
  }: {
    auth: AuthService;
    store: PostgresEventStore;
    workspaces: WorkspaceStore;
    github?: GitHubApp;
    /** Keeps an encrypted copy of each link, so its creator can copy it again. */
    secrets?: SecretBox;
    viewer: (
      principal: Principal,
      id: string,
    ) => Promise<{ workspace: Workspace; repositories: Repo[] }>;
  },
  kind: "dashboard" | "health",
) {
  const router = Router();
  const shares = new DashboardShareStore(workspaces.pool, kind, secrets);
  const health = new HealthStore(store.pool);
  const wall = new WallStore(store.pool);
  let connections = 0;
  const base =
    kind === "health"
      ? "/api/workspaces/:id/health/share"
      : "/api/workspaces/:id/share";
  const publicPath =
    kind === "health" ? "/api/shared/health" : "/api/shared/feed";
  const eventsPath =
    kind === "health" ? "/api/shared/health/events" : "/api/shared/events";
  const tokenHeader =
    kind === "health" ? "x-health-share" : "x-dashboard-share";

  router.get(base, async (request, response) => {
    const principal = await auth.authenticate(request, response);
    await workspaces.get(principal.user.id, request.params.id);
    const share = await shares.current(principal.user.id, request.params.id);
    await auth.assertActive(principal);
    response.json({ share });
  });
  for (const rotate of [false, true]) {
    router.post(
      `${base}${rotate ? "/rotate" : ""}`,
      async (request, response) => {
        const principal = await auth.requireMutation(request, response);
        // A rotation may keep the current link's expiry instead of a new lifetime.
        const keepExpiry = rotate && request.body?.keepExpiry === true;
        const expiresIn: unknown = request.body?.expiresIn;
        if (
          !keepExpiry &&
          !SHARE_DURATIONS.some((duration) => duration.seconds === expiresIn)
        )
          throw new AuthError(400, "Choose a valid link expiration.");
        const workspace = await workspaces.get(
          principal.user.id,
          request.params.id,
        );
        if (workspace.kind !== "team")
          throw new AuthError(
            400,
            "Only team dashboards can be shared. Personal journals stay private.",
          );
        const connection = await workspaces.connection(principal.user.id);
        const current = await viewer(principal, workspace.id);
        if (!connection || !current.repositories.length)
          throw new AuthError(
            403,
            "Connect accessible team repositories before sharing.",
          );
        let lifetime = expiresIn as number;
        if (keepExpiry) {
          const active = await shares.current(principal.user.id, workspace.id);
          const remaining = active
            ? Math.round((Date.parse(active.expiresAt) - Date.now()) / 1000)
            : 0;
          if (remaining <= 0)
            throw new AuthError(
              409,
              "Your link has expired. Choose a lifetime for the new one.",
            );
          lifetime = remaining;
        }
        const link = await shares.create(
          principal.user.id,
          current.workspace,
          connection.generation,
          current.repositories.map((repo) => repo.id),
          lifetime,
          rotate,
        );
        await auth.assertActive(principal);
        response.status(rotate ? 200 : 201).json(link);
      },
    );
  }
  router.delete(base, async (request, response) => {
    const principal = await auth.requireMutation(request, response);
    await workspaces.get(principal.user.id, request.params.id);
    await shares.revoke(principal.user.id, request.params.id);
    response.sendStatus(204);
  });

  async function authorize(token: string | undefined) {
    const share = await shares.resolve(token);
    if (!github) throw unavailableShare();
    // The creator's synced access, bound to the authorization the link pinned.
    const repositories = await workspaces.repositoryAccess(
      share.creator_user_id,
      Number(share.installation_id),
    );
    if (!repositories) throw unavailableShare();
    const current = await shares.resolve(token);
    const pinned = new Set(current.repository_ids.map(Number));
    const visible = repositories.filter((repo) => pinned.has(repo.id));
    if (kind === "health" && !visible.length) throw unavailableShare();
    return { share: current, repositories: visible };
  }

  router.get(publicPath, async (request, response) => {
    const token = request.get(tokenHeader);
    const initial = await authorize(token);
    const workspace = await workspaces.get(
      initial.share.creator_user_id,
      initial.share.workspace_id,
    );
    if (kind === "health") {
      const snapshot = await health.snapshot(workspace.id);
      const current = await authorize(token);
      const result: SharedHealthSnapshot = {
        organization: workspace.name,
        updatedAt: snapshot.updatedAt,
        expiresAt: current.share.expires_at.toISOString(),
        services: snapshot.services.map((service) => ({
          id: service.id,
          name: service.name,
          status: service.status,
          probes: service.probes.map((probe) => ({
            id: probe.id,
            name: probe.name,
            status: probe.status,
            enabled: probe.enabled,
            intervalSeconds: probe.intervalSeconds,
            timeoutMs: probe.timeoutMs,
            lastCheck: probe.lastCheck,
            successRate24h: probe.successRate24h,
            checks24h: probe.checks24h,
            history: probe.history,
            latencyHistory: probe.latencyHistory,
            uptime90d: probe.uptime90d,
            latency24h: probe.latency24h,
            latencyStats24h: probe.latencyStats24h,
          })),
        })),
      };
      response.json(result);
      return;
    }
    // A link reads only its pinned installation.
    const events = (
      await workspaces.feed(initial.share.creator_user_id, workspace, [
        {
          installationId: Number(initial.share.installation_id),
          repositoryIds: initial.repositories.map((repo) => repo.id),
        },
      ])
    ).map(({ event }) => event);
    const wallSnapshot = await wall.snapshot(
      Number(initial.share.installation_id),
      initial.repositories.map((repo) => repo.id),
    );
    // Remote checks and storage reads can overlap a revoke on another replica.
    const current = await authorize(token);
    const allowed = new Set(current.repositories.map((repo) => repo.id));
    const result: SharedFeedResponse = {
      events: events
        .filter(
          (event) => event.type !== "note" && allowed.has(event.repositoryId!),
        )
        .map(({ body: _body, ...event }) => event),
      organization: workspace.name,
      source: "workspace",
      ...(workspace.pulseTitle ? { pulseTitle: workspace.pulseTitle } : {}),
      ...(workspace.pulseSubtitle
        ? { pulseSubtitle: workspace.pulseSubtitle }
        : {}),
      updatedAt: new Date().toISOString(),
      expiresAt: current.share.expires_at.toISOString(),
      wall: {
        ...wallSnapshot,
        repositories: wallSnapshot.repositories.filter((repository) =>
          allowed.has(repository.repositoryId),
        ),
      },
    };
    response.json(result);
  });

  router.get(eventsPath, async (request, response) => {
    const token = request.get(tokenHeader);
    const { share } = await authorize(token);
    if (request.destroyed) return;
    if (connections >= 100)
      throw new AuthError(
        503,
        "Live connection limit reached. Try again shortly.",
      );
    connections++;
    liveConnections.inc({ kind: "share" });
    let closed = false;
    let pending = false;
    let dirty = false;
    let unsubscribe = () => {};
    let heartbeat: ReturnType<typeof setInterval>;
    let expiry: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(expiry);
      unsubscribe();
      connections--;
      liveConnections.dec({ kind: "share" });
    };
    const write = (frame: string) => {
      if (closed || response.writableEnded) return;
      if (response.writableLength > 1_048_576 || !response.write(frame)) {
        cleanup();
        response.end();
      }
    };
    const revoke = () => {
      write("event: access-revoked\ndata: {}\n\n");
      cleanup();
      response.end();
    };
    const refresh = async () => {
      if (closed) return;
      if (pending) {
        dirty = true;
        return;
      }
      pending = true;
      try {
        await authorize(token);
        write("event: refresh\ndata: {}\n\n");
      } catch {
        revoke();
      } finally {
        pending = false;
        if (dirty && !closed) {
          dirty = false;
          void refresh();
        }
      }
    };
    const scheduleExpiry = () => {
      const remaining = share.expires_at.getTime() - Date.now();
      if (remaining <= 0) {
        revoke();
        return;
      }
      expiry = setTimeout(scheduleExpiry, Math.min(remaining, 2_147_483_647));
      expiry.unref();
    };
    response.once("close", cleanup);
    response.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    unsubscribe = store.subscribe((scope) => {
      if (kind === "health" && scope === `health-${share.workspace_id}`) {
        // Empty invalidation only; the subsequent snapshot authorizes its data.
        write("event: refresh\ndata: {}\n\n");
        return;
      }
      if (
        [
          `workspace-${share.workspace_id}`,
          `account-${share.creator_user_id}`,
          `installation-${share.installation_id}`,
          `wall-installation-${share.installation_id}`,
        ].includes(scope)
      )
        void refresh();
    });
    heartbeat = setInterval(() => void refresh(), 25_000);
    heartbeat.unref();
    response.flushHeaders();
    write("event: connected\ndata: {}\n\n");
    scheduleExpiry();
    // Close the race between initial authorization and subscribing to changes.
    void refresh();
  });
  return router;
}

/** Independent token namespaces prevent dashboard links from authorizing health data. */
export function dashboardShareRouter(
  options: Parameters<typeof workspaceShareRouter>[0],
) {
  return workspaceShareRouter(options, "dashboard");
}
export function healthShareRouter(
  options: Parameters<typeof workspaceShareRouter>[0],
) {
  return workspaceShareRouter(options, "health");
}
