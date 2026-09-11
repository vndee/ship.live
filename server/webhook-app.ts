import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import type { Pool } from "pg";
import type {
  WebhookSettings,
  WebhookTestResult,
} from "../shared/webhook-api.js";
import { compileTemplate, TemplateError } from "../shared/webhook-template.js";
import { sampleEvent } from "../shared/webhooks.js";
import type { Workspace } from "../shared/workspaces.js";
import { AuthError, type AuthService, type Principal } from "./auth.js";
import type { Repo } from "./github-app.js";
import { publicHttpUrl, sendOutbound } from "./outbound.js";
import { ACTIVITY_CHANNEL } from "./postgres-notifications.js";
import { verifyWebhookSignature } from "./security.js";
import { recordWorkspaceEvent } from "./webhook-outbox.js";
import type { WebhookStore } from "./webhook-store.js";
import { accepted, prepareRequest, type Send } from "./webhook-worker.js";

type Viewer = (
  principal: Principal,
  id: string,
) => Promise<{ workspace: Workspace; repositories: Repo[] }>;

/** Team members manage a workspace's outbound and inbound webhooks. */
export function webhookRouter({
  auth,
  webhooks,
  viewer,
  send = sendOutbound,
}: {
  auth: AuthService;
  webhooks: WebhookStore;
  viewer: Viewer;
  send?: Send;
}): Router {
  const router = Router();
  const base = "/api/workspaces/:id/webhooks";
  const inbound = "/api/workspaces/:id/inbound";
  async function team(principal: Principal, id: string) {
    const current = await viewer(principal, id);
    if (current.workspace.kind !== "team")
      throw new AuthError(403, "Webhooks are available in team workspaces.");
    return current;
  }
  const endpoint = (path?: string) =>
    path ? new URL(path, auth.config.appUrl).href : undefined;

  router.get(base, async (request, response) => {
    const principal = await auth.authenticate(request, response);
    await team(principal, request.params.id);
    const settings = await webhooks.settings(request.params.id);
    await auth.assertActive(principal);
    const body: WebhookSettings = {
      ...settings,
      configured: webhooks.configured,
    };
    response.json(body);
  });
  // Saving pins the saver's current repositories to the webhook.
  router.post(base, async (request, response) => {
    const principal = await auth.requireMutation(request, response);
    const current = await team(principal, request.params.id);
    const saved = await webhooks.create(
      request.params.id,
      principal.user.id,
      request.body,
      current.repositories.map((repository) => repository.id),
    );
    await auth.assertActive(principal);
    response.status(201).json(saved);
  });
  router.put(`${base}/:webhookId`, async (request, response) => {
    const principal = await auth.requireMutation(request, response);
    const current = await team(principal, request.params.id);
    const saved = await webhooks.update(
      request.params.id,
      request.params.webhookId,
      principal.user.id,
      request.body,
      current.repositories.map((repository) => repository.id),
    );
    await auth.assertActive(principal);
    response.json(saved);
  });
  router.delete(`${base}/:webhookId`, async (request, response) => {
    const principal = await auth.requireMutation(request, response);
    await team(principal, request.params.id);
    await webhooks.remove(request.params.id, request.params.webhookId);
    response.sendStatus(204);
  });
  router.get(`${base}/:webhookId/deliveries`, async (request, response) => {
    const principal = await auth.authenticate(request, response);
    await team(principal, request.params.id);
    const deliveries = await webhooks.deliveries(
      request.params.id,
      request.params.webhookId,
    );
    await auth.assertActive(principal);
    response.json({ deliveries });
  });
  router.post(
    `${base}/:webhookId/deliveries/:deliveryId/redeliver`,
    async (request, response) => {
      const principal = await auth.requireMutation(request, response);
      await team(principal, request.params.id);
      await webhooks.redeliver(
        request.params.id,
        request.params.webhookId,
        request.params.deliveryId,
      );
      response.status(202).json({ queued: true });
    },
  );
  /** Sends a sample event with the saved settings, ignoring filters and cooldown. */
  router.post(`${base}/:webhookId/test`, async (request, response) => {
    const principal = await auth.requireMutation(request, response);
    const current = await team(principal, request.params.id);
    const target = await webhooks.targetById(
      request.params.id,
      request.params.webhookId,
    );
    const type =
      typeof request.body?.eventType === "string" &&
      request.body.eventType.length <= 60
        ? request.body.eventType
        : "webhook.test";
    const event = sampleEvent(type, {
      id: current.workspace.id,
      name: current.workspace.name,
    });
    let result: WebhookTestResult;
    let requestBody = "";
    try {
      const prepared = prepareRequest(target, event, {
        id: `test-${randomUUID()}`,
        attempt: 1,
      });
      requestBody = prepared.body;
      const reply = await send(prepared);
      const verdict = accepted(target, reply);
      result = {
        ok: verdict.ok,
        status: reply.status,
        body: reply.body.slice(0, 1024),
        ...(verdict.ok ? {} : { error: verdict.reason }),
        latencyMs: reply.latencyMs,
        requestBody,
      };
    } catch (error) {
      result = {
        ok: false,
        status: null,
        body: "",
        error:
          error instanceof TemplateError
            ? `The template could not render: ${error.message}`
            : "The test could not be sent.",
        latencyMs: 0,
        requestBody,
      };
    }
    await auth.assertActive(principal);
    response.json(result);
  });

  router.post(inbound, async (request, response) => {
    const principal = await auth.requireMutation(request, response);
    await team(principal, request.params.id);
    const saved = await webhooks.createInbound(
      request.params.id,
      principal.user.id,
      request.body,
    );
    await auth.assertActive(principal);
    response.status(201).json({ ...saved, endpoint: endpoint(saved.endpoint) });
  });
  router.put(`${inbound}/:hookId`, async (request, response) => {
    const principal = await auth.requireMutation(request, response);
    await team(principal, request.params.id);
    const saved = await webhooks.updateInbound(
      request.params.id,
      request.params.hookId,
      request.body,
    );
    await auth.assertActive(principal);
    response.json(saved);
  });
  router.post(`${inbound}/:hookId/rotate`, async (request, response) => {
    const principal = await auth.requireMutation(request, response);
    await team(principal, request.params.id);
    const saved = await webhooks.rotateInbound(
      request.params.id,
      request.params.hookId,
    );
    await auth.assertActive(principal);
    response.json({ ...saved, endpoint: endpoint(saved.endpoint) });
  });
  router.delete(`${inbound}/:hookId`, async (request, response) => {
    const principal = await auth.requireMutation(request, response);
    await team(principal, request.params.id);
    await webhooks.removeInbound(request.params.id, request.params.hookId);
    response.sendStatus(204);
  });
  return router;
}

/**
 * Accepts JSON from any service at /api/hooks/<token>. The token in the URL
 * identifies the endpoint; an optional secret also requires an
 * X-Signature-256: sha256=<hex HMAC of the body> header, as GitHub sends.
 * Mount before JSON body parsing: the signature covers the raw bytes.
 */
export function inboundReceiver({
  webhooks,
  pool,
}: {
  webhooks: WebhookStore;
  pool: Pool;
}): Router {
  const router = Router();
  router.post(
    "/api/hooks/:token",
    express.raw({ type: () => true, limit: "256kb" }),
    async (request, response) => {
      const hook = await webhooks.inboundByToken(request.params.token);
      if (!hook) throw new AuthError(404, "Unknown webhook.");
      const reject = async (status: number, reason: string) => {
        await webhooks.receipt(hook.id, false, null, reason);
        throw new AuthError(status, reason);
      };
      const body = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.alloc(0);
      if (
        hook.secret &&
        !verifyWebhookSignature(
          body,
          request.get("x-signature-256") ?? request.get("x-hub-signature-256"),
          hook.secret,
        )
      )
        return reject(401, "The signature did not match.");
      let payload: unknown;
      try {
        payload = body.length ? JSON.parse(body.toString("utf8")) : {};
      } catch {
        return reject(400, "Send a JSON body.");
      }
      const render = (template: string) =>
        template
          ? compileTemplate(template, "text").render({ payload }).trim()
          : "";
      let title: string;
      let text: string;
      let url: string;
      let id: string;
      try {
        title = render(hook.mapping.title).slice(0, 300);
        text = render(hook.mapping.body).slice(0, 4000);
        url = render(hook.mapping.url);
        id = render(hook.mapping.id).slice(0, 200);
      } catch (error) {
        return reject(
          422,
          `The mapping could not render this payload: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
      if (!title) return reject(422, "The title mapping rendered no text.");
      const link =
        url && publicHttpUrl(url)?.protocol === "https:" ? url : undefined;
      const serialized = JSON.stringify(payload);
      await recordWorkspaceEvent(pool, hook.workspaceId, {
        type: `inbound.${hook.slug}`,
        // The sender's own ID deduplicates its retries.
        dedupeKey: `inbound:${hook.id}:${id || randomUUID()}`,
        occurredAt: new Date().toISOString(),
        summary: title,
        url: link,
        data: {
          endpoint: { id: hook.id, name: hook.name, slug: hook.slug },
          title,
          body: text,
          ...(serialized.length <= 16_384 ? { payload } : {}),
        },
      });
      await webhooks.receipt(hook.id, true, title, null);
      // Open Live activity views refetch and show the alert.
      await pool.query("SELECT pg_notify($1,$2)", [
        ACTIVITY_CHANNEL,
        JSON.stringify({
          organization: `workspace-${hook.workspaceId}`,
          eventId: "refresh",
        }),
      ]);
      response.status(202).json({ accepted: true });
    },
  );
  return router;
}
