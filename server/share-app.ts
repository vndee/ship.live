import { Router } from "express";
import { SHARE_DURATIONS, type SharedFeedResponse } from "../shared/shares.js";
import type { Workspace } from "../shared/workspaces.js";
import { AuthError, type AuthService, type Principal } from "./auth.js";
import type { GitHubApp, Repo } from "./github-app.js";
import type { PostgresEventStore } from "./postgres-store.js";
import { DashboardShareStore, unavailableShare } from "./share-store.js";
import type { WorkspaceStore } from "./workspace-store.js";

export function dashboardShareRouter({
  auth,
  store,
  workspaces,
  github,
  viewer,
}: {
  auth: AuthService;
  store: PostgresEventStore;
  workspaces: WorkspaceStore;
  github?: GitHubApp;
  viewer: (
    principal: Principal,
    id: string,
  ) => Promise<{ workspace: Workspace; repositories: Repo[] }>;
}) {
  const router = Router();
  const shares = new DashboardShareStore(workspaces.pool);
  let connections = 0;
  const base = "/api/workspaces/:id/share";

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
        const expiresIn: unknown = request.body?.expiresIn;
        if (!SHARE_DURATIONS.some((duration) => duration.seconds === expiresIn))
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
        const link = await shares.create(
          principal.user.id,
          current.workspace,
          connection.generation,
          current.repositories.map((repo) => repo.id),
          expiresIn as number,
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
    let repositories: Repo[];
    try {
      const grant = await workspaces.withGrant(share.creator_user_id, (grant) =>
        github.refresh(grant),
      );
      repositories = await github.repositories(
        grant.accessToken,
        Number(share.installation_id),
      );
    } catch {
      throw unavailableShare();
    }
    const current = await shares.resolve(token);
    const pinned = new Set(current.repository_ids.map(Number));
    return {
      share: current,
      repositories: repositories.filter((repo) => pinned.has(repo.id)),
    };
  }

  router.get("/api/shared/feed", async (request, response) => {
    const token = request.get("x-dashboard-share");
    const initial = await authorize(token);
    const workspace = await workspaces.get(
      initial.share.creator_user_id,
      initial.share.workspace_id,
    );
    const events = await workspaces.feed(
      initial.share.creator_user_id,
      workspace,
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
      updatedAt: new Date().toISOString(),
      expiresAt: current.share.expires_at.toISOString(),
    };
    response.json(result);
  });

  router.get("/api/shared/events", async (request, response) => {
    const token = request.get("x-dashboard-share");
    const { share } = await authorize(token);
    if (request.destroyed) return;
    if (connections >= 100)
      throw new AuthError(
        503,
        "Live connection limit reached. Try again shortly.",
      );
    connections++;
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
      if (
        [
          `workspace-${share.workspace_id}`,
          `account-${share.creator_user_id}`,
          `installation-${share.installation_id}`,
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
