import { Router } from "express";
import type { AuthService, Principal } from "./auth.js";
import { AuthError } from "./auth.js";
import type { Workspace } from "../shared/workspaces.js";
import type { WorkspaceStore } from "./workspace-store.js";
import type { PostgresEventStore } from "./postgres-store.js";
import { HealthStore } from "./health-store.js";
import { validateHeaders, validateProbe } from "./health-probe.js";

export function healthRouter({
  auth,
  store,
  workspaces,
  viewer,
}: {
  auth: AuthService;
  store: PostgresEventStore;
  workspaces: WorkspaceStore;
  viewer: (
    principal: Principal,
    id: string,
  ) => Promise<{ workspace: Workspace }>;
}) {
  const router = Router();
  const health = new HealthStore(store.pool);
  const base = "/api/workspaces/:id/health";
  let streams = 0;
  async function access(principal: Principal, id: string) {
    const current = await viewer(principal, id);
    if (current.workspace.kind !== "team")
      throw new AuthError(
        403,
        "Service health is available in team workspaces.",
      );
  }
  router.get(base, async (req, res) => {
    const principal = await auth.authenticate(req, res);
    // Check local membership before reading, then fresh upstream access before
    // releasing private configuration. The database read can overlap revocation.
    const workspace = await workspaces.get(principal.user.id, req.params.id);
    if (workspace.kind !== "team")
      throw new AuthError(
        403,
        "Service health is available in team workspaces.",
      );
    const snapshot = await health.snapshot(req.params.id);
    await access(principal, req.params.id);
    res.json(snapshot);
  });
  router.post(`${base}/services`, async (req, res) => {
    const principal = await auth.requireMutation(req, res);
    await access(principal, req.params.id);
    const service = await health.createService(req.params.id, req.body?.name);
    await auth.assertActive(principal);
    res.status(201).json(service);
  });
  router.put(`${base}/services/order`, async (req, res) => {
    const principal = await auth.requireMutation(req, res);
    await access(principal, req.params.id);
    await health.reorderServices(req.params.id, req.body?.serviceIds);
    await auth.assertActive(principal);
    res.sendStatus(204);
  });
  router.patch(`${base}/services/:serviceId`, async (req, res) => {
    const principal = await auth.requireMutation(req, res);
    await access(principal, req.params.id);
    await health.renameService(
      req.params.id,
      req.params.serviceId,
      req.body?.name,
    );
    res.sendStatus(204);
  });
  router.delete(`${base}/services/:serviceId`, async (req, res) => {
    const principal = await auth.requireMutation(req, res);
    await access(principal, req.params.id);
    await health.deleteService(req.params.id, req.params.serviceId);
    res.sendStatus(204);
  });
  router.post(`${base}/services/:serviceId/probes`, async (req, res) => {
    const principal = await auth.requireMutation(req, res);
    await access(principal, req.params.id);
    const config = validateProbe(req.body);
    const headers =
      req.body?.headers === undefined
        ? undefined
        : validateHeaders(req.body.headers);
    const probe = await health.saveProbe(
      req.params.id,
      req.params.serviceId,
      null,
      config,
      headers,
    );
    res.status(201).json(probe);
  });
  router.put(`${base}/probes/:probeId`, async (req, res) => {
    const principal = await auth.requireMutation(req, res);
    await access(principal, req.params.id);
    const config = validateProbe(req.body);
    const headers =
      req.body?.headers === undefined
        ? undefined
        : validateHeaders(req.body.headers);
    const serviceId = await health.probeService(
      req.params.id,
      req.params.probeId,
    );
    const probe = await health.saveProbe(
      req.params.id,
      serviceId,
      req.params.probeId,
      config,
      headers,
    );
    res.json(probe);
  });
  router.delete(`${base}/probes/:probeId`, async (req, res) => {
    const principal = await auth.requireMutation(req, res);
    await access(principal, req.params.id);
    await health.deleteProbe(req.params.id, req.params.probeId);
    res.sendStatus(204);
  });
  router.post(`${base}/probes/:probeId/check`, async (req, res) => {
    const principal = await auth.requireMutation(req, res);
    await access(principal, req.params.id);
    await health.checkNow(req.params.id, req.params.probeId);
    res.status(202).json({ queued: true });
  });
  router.get(`${base}/events`, async (req, res) => {
    const principal = await auth.authenticate(req, res);
    await access(principal, req.params.id);
    if (req.destroyed) return;
    if (streams >= 100)
      throw new AuthError(503, "Live health connection limit reached.");
    streams++;
    let closed = false;
    let checking = false;
    let unsubscribe = () => {};
    const close = () => {
      if (closed) return;
      closed = true;
      streams--;
      clearInterval(timer);
      unsubscribe();
      res.end();
    };
    const write = (frame: string) => {
      if (closed) return;
      if (res.writableLength > 65536 || !res.write(frame)) close();
    };
    async function heartbeat() {
      if (closed || checking) return;
      checking = true;
      try {
        await auth.assertActive(principal);
        await workspaces.get(principal.user.id, req.params.id);
        write(": heartbeat\n\n");
      } catch {
        write("event: access-revoked\ndata: {}\n\n");
        close();
      } finally {
        checking = false;
      }
    }
    const timer = setInterval(() => void heartbeat(), 25000);
    res.once("close", close);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // Invalidation contains no workspace data. Snapshot reads verify fresh access.
    unsubscribe = store.subscribe((scope) => {
      if (scope === `health-${req.params.id}`)
        write("event: health\ndata: {}\n\n");
    });
    write("event: health\ndata: {}\n\n");
  });
  return router;
}
