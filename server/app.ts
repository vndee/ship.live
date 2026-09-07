import { EventEmitter } from "node:events";
import express, {
  type ErrorRequestHandler,
  type Request,
  type Response,
} from "express";
import type { FeedResponse } from "../shared/types.js";
import { FeedError, GitHubFeed, type GitHubConfig } from "./github.js";
import {
  normalizeWebhook,
  validOrganization,
  webhookOrganization,
} from "./normalize.js";
import { verifyAccessKey, verifyWebhookSignature } from "./security.js";
import { combineEvents, EventStore } from "./store.js";

export interface ServerConfig extends GitHubConfig {
  webhookSecret?: string;
  dashboardAccessKey?: string;
}

export function createApp(
  config: ServerConfig,
  store: EventStore,
  github = new GitHubFeed(config),
) {
  if (config.organization && !validOrganization(config.organization))
    throw new Error("GITHUB_ORG must be a GitHub organization name.");
  if ((config.token || config.webhookSecret) && !config.organization)
    throw new Error("Set GITHUB_ORG when configuring GitHub credentials.");
  const app = express();
  app.disable("x-powered-by");
  const stream = new EventEmitter();
  stream.setMaxListeners(110);
  let connections = 0;
  const attempts = new Map<string, { count: number; reset: number }>();

  function protectedFeed(org: string): boolean {
    return (
      store.requiresProtection(org) ||
      (org.toLowerCase() === config.organization?.toLowerCase() &&
        Boolean(config.token || config.webhookSecret))
    );
  }
  function organizationFromRequest(request: Request): string {
    const organization = request.query.org ?? config.organization;
    if (!validOrganization(organization))
      throw new FeedError(400, "Enter a valid GitHub organization name.");
    return organization;
  }
  function authorize(request: Request, organization: string): void {
    if (!protectedFeed(organization)) return;
    if (!config.dashboardAccessKey)
      throw new FeedError(
        503,
        "This feed is protected. Set DASHBOARD_ACCESS_KEY on the server before connecting.",
      );
    if (
      !verifyAccessKey(
        request.get("x-dashboard-key"),
        config.dashboardAccessKey,
      )
    )
      throw new FeedError(
        401,
        "Enter the dashboard access key to connect to this organization.",
      );
  }

  app.use("/api", (request, response, next) => {
    response.set("Cache-Control", "no-store");
    response.set("X-Content-Type-Options", "nosniff");
    // Webhook deliveries have separate HMAC authentication and must not compete with polling.
    if (request.path === "/webhooks/github" || request.path === "/health")
      return next();
    const ip = request.ip ?? "unknown";
    const current = attempts.get(ip);
    const window =
      current && current.reset > Date.now()
        ? current
        : { count: 0, reset: Date.now() + 60_000 };
    window.count += 1;
    attempts.set(ip, window);
    if (attempts.size > 1000) attempts.delete(attempts.keys().next().value!);
    if (window.count > 120) {
      response
        .set("Retry-After", "60")
        .status(429)
        .json({ error: "Too many requests. Please try again in a minute." });
      return;
    }
    next();
  });

  app.get("/api/health", (_request, response) => {
    response.json({
      status: "ok",
      configuredOrg: config.organization,
      privateFeed: config.organization
        ? protectedFeed(config.organization)
        : false,
      webhookConfigured: Boolean(config.webhookSecret),
    });
  });

  app.get("/api/feed", async (request, response, next) => {
    try {
      const organization = organizationFromRequest(request);
      authorize(request, organization);
      const configured =
        organization.toLowerCase() === config.organization?.toLowerCase();
      const saved = configured ? store.list(organization) : [];
      let feed;
      try {
        feed = await github.get(organization);
      } catch (error) {
        if (
          !saved.length ||
          !(error instanceof FeedError) ||
          error.status === 404
        )
          throw error;
        const fallback: FeedResponse = {
          events: saved,
          organization,
          source: "github",
          updatedAt: saved[0].occurredAt,
          notice: `${error.message} Showing saved activity.`,
        };
        response.json(fallback);
        return;
      }
      if (configured)
        await store.merge(organization, feed.events, { preferExisting: true });
      const result: FeedResponse = {
        events: combineEvents(
          feed.events,
          configured ? store.list(organization) : [],
        ),
        organization,
        source: "github",
        updatedAt: feed.updatedAt,
        notice:
          configured && config.webhookSecret
            ? "Public GitHub activity plus received webhooks. Webhooks stream live; public API events may be delayed."
            : "Public GitHub activity. GitHub can delay API events by 30 seconds to 6 hours. Connect an organization webhook for live and private activity.",
      };
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/events", (request, response, next) => {
    try {
      const organization = organizationFromRequest(request).toLowerCase();
      authorize(request, organization);
      if (connections >= 100)
        throw new FeedError(
          503,
          "Live connection limit reached. Activity polling remains available.",
        );
      connections += 1;
      response.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.flushHeaders();
      response.write("retry: 5000\nevent: connected\ndata: {}\n\n");
      const listener = (org: string, event: unknown) => {
        if (org === organization && !response.writableEnded)
          response.write(`event: activity\ndata: ${JSON.stringify(event)}\n\n`);
      };
      stream.on("activity", listener);
      const heartbeat = setInterval(
        () => response.write(": heartbeat\n\n"),
        25_000,
      );
      request.on("close", () => {
        clearInterval(heartbeat);
        stream.off("activity", listener);
        connections -= 1;
      });
    } catch (error) {
      next(error);
    }
  });

  // Keep the exact raw bytes until signature verification. No JSON parser precedes this route.
  app.post(
    "/api/webhooks/github",
    express.raw({ type: "application/json", limit: "2mb" }),
    async (request, response, next) => {
      try {
        if (!config.webhookSecret || !config.organization)
          throw new FeedError(
            503,
            "GitHub webhooks are not configured on this server.",
          );
        if (!config.dashboardAccessKey)
          throw new FeedError(
            503,
            "Set DASHBOARD_ACCESS_KEY before receiving organization webhooks.",
          );
        if (!Buffer.isBuffer(request.body))
          throw new FeedError(
            415,
            "Configure the GitHub webhook content type as application/json.",
          );
        if (
          !verifyWebhookSignature(
            request.body,
            request.get("x-hub-signature-256"),
            config.webhookSecret,
          )
        )
          throw new FeedError(401, "Invalid webhook signature.");
        const kind = request.get("x-github-event");
        const deliveryId = request.get("x-github-delivery");
        if (!kind || !deliveryId || !/^[a-z\d-]{1,100}$/i.test(deliveryId))
          throw new FeedError(
            400,
            "Missing or invalid GitHub delivery headers.",
          );
        let payload: unknown;
        try {
          payload = JSON.parse(request.body.toString("utf8"));
        } catch {
          throw new FeedError(400, "The webhook payload is not valid JSON.");
        }
        const org = webhookOrganization(payload);
        if (!org || org.toLowerCase() !== config.organization.toLowerCase())
          throw new FeedError(
            403,
            "This webhook does not belong to the configured organization.",
          );
        if (kind === "ping") {
          response.json({ accepted: true, message: "Webhook connected." });
          return;
        }
        const event = normalizeWebhook(kind, payload, deliveryId);
        if (!event) {
          response.status(202).json({ accepted: true, ignored: true });
          return;
        }
        if (
          event.repo.split("/")[0].toLowerCase() !==
          config.organization.toLowerCase()
        )
          throw new FeedError(
            403,
            "This repository does not belong to the configured organization.",
          );
        const result = await store.merge(org, [event], {
          restricted: true,
          deliveryId,
        });
        const storedEvent = store
          .list(org)
          .find((savedEvent) => savedEvent.id === event.id);
        if (!result.duplicate && storedEvent)
          stream.emit("activity", org.toLowerCase(), storedEvent);
        response
          .status(202)
          .json({ accepted: true, duplicate: result.duplicate });
      } catch (error) {
        next(error);
      }
    },
  );

  app.use("/api", (_request, response) =>
    response.status(404).json({ error: "API route not found." }),
  );
  const handleError: ErrorRequestHandler = (
    error: unknown,
    _request: Request,
    response: Response,
    _next,
  ) => {
    if (response.headersSent) return;
    if (error instanceof FeedError) {
      if (error.retryAfter)
        response.set("Retry-After", String(error.retryAfter));
      response.status(error.status).json({ error: error.message });
      return;
    }
    if (
      error instanceof Error &&
      "type" in error &&
      error.type === "entity.too.large"
    ) {
      response.status(413).json({
        error:
          "Webhook payload is too large. The local MVP accepts payloads up to 2 MB.",
      });
      return;
    }
    // Avoid logging upstream request objects, which could contain tokens or private payloads.
    console.error("The feed server could not complete a request.");
    response.status(500).json({
      error:
        "The server could not complete this request. Check server storage and configuration.",
    });
  };
  app.use(handleError);
  return app;
}
