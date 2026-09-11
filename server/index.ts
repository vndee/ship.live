import "dotenv/config";
import express from "express";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthService, authConfigFromEnv } from "./auth.js";
import { GitHubApp } from "./github-app.js";
import { log } from "./logger.js";
import { startRetention } from "./maintenance.js";
import { metrics, startProcessMetrics } from "./metrics.js";
import { PostgresEventStore } from "./postgres-store.js";
import { PostgresRateLimiter } from "./rate-limit.js";
import {
  githubAppConfigFromEnv,
  metricsTokenFromEnv,
  retentionFromEnv,
  trustProxyHopsFromEnv,
} from "./runtime-config.js";
import { SECURITY_HEADERS } from "./security.js";
import { createWorkspaceApp } from "./workspace-app.js";
import { HealthStore } from "./health-store.js";
import { startHealthWorker } from "./health-worker.js";
import { WorkspaceStore } from "./workspace-store.js";
import { SecretBox } from "./secret-box.js";
import type { AccessCheck } from "./webhook-outbox.js";
import { WebhookStore } from "./webhook-store.js";
import { startWebhookWorker } from "./webhook-worker.js";

const poolConnections = metrics.gauge(
  "ship_live_db_pool_connections",
  "PostgreSQL pool connections in this process by state.",
  ["state"],
);

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    log.error(
      "Set DATABASE_URL to a PostgreSQL database before starting ship.live.",
    );
    process.exitCode = 1;
    return;
  }
  const port = Number(process.env.PORT || 3001);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    log.error("PORT must be a valid TCP port.");
    process.exitCode = 1;
    return;
  }
  let store: PostgresEventStore;
  try {
    store = await PostgresEventStore.open(databaseUrl);
  } catch {
    log.error(
      "Could not initialize PostgreSQL. Check DATABASE_URL, database permissions, and schema compatibility.",
    );
    process.exitCode = 1;
    return;
  }
  try {
    const production = process.env.NODE_ENV === "production";
    const authConfig = authConfigFromEnv();
    const githubConfig = githubAppConfigFromEnv(authConfig);
    const retention = retentionFromEnv();
    const auth = new AuthService(authConfig, store.pool);
    const workspaces = new WorkspaceStore(
      store.pool,
      process.env.TOKEN_ENCRYPTION_KEY?.trim(),
    );
    const secrets = new SecretBox(process.env.TOKEN_ENCRYPTION_KEY?.trim());
    const webhooks = new WebhookStore(store.pool, secrets);
    const app = createWorkspaceApp({
      auth,
      store,
      workspaces,
      webhooks,
      secrets,
      github: githubConfig ? new GitHubApp(githubConfig) : undefined,
      webhookSecret: process.env.GITHUB_WEBHOOK_SECRET?.trim(),
      trustProxyHops: trustProxyHopsFromEnv(),
      metricsToken: metricsTokenFromEnv(),
      responseHeaders: production ? SECURITY_HEADERS : undefined,
      rateLimiter: new PostgresRateLimiter(store.pool, (error) =>
        log.warn(
          "Shared request limits are unavailable; limiting per process.",
          { error },
        ),
      ),
    });
    if (production) {
      const dist = fileURLToPath(new URL("../dist/", import.meta.url));
      // Vite fingerprints assets; only these files can be cached across deploys.
      app.use(
        "/assets",
        express.static(resolve(dist, "assets"), {
          maxAge: "1y",
          immutable: true,
        }),
      );
      app.use(express.static(dist));
      // Page routes such as /health and /feed all load the same application.
      // A root keeps send's dotfile check off the install path's own folders.
      app.get(/.*/, (_request, response) =>
        response.sendFile("index.html", { root: dist }),
      );
    }
    const stopProcessMetrics = startProcessMetrics();
    const stopPoolMetrics = metrics.collect(() => {
      poolConnections.set({ state: "total" }, store.pool.totalCount);
      poolConnections.set({ state: "idle" }, store.pool.idleCount);
      poolConnections.set({ state: "waiting" }, store.pool.waitingCount);
    });
    const stopHealth = startHealthWorker(new HealthStore(store.pool));
    const stopRetention = startRetention(store.pool, retention);
    // Webhooks follow their owner's current membership and repository access.
    const access: AccessCheck = async (userId, workspaceId) => {
      try {
        const workspace = await workspaces.get(userId, workspaceId);
        if (!workspace.installationId) return new Set<number>();
        if (!(await workspaces.installationActive(workspace.installationId)))
          return undefined;
        const repositories = await workspaces.repositoryAccess(
          userId,
          workspace.installationId,
        );
        return repositories
          ? new Set(repositories.map((repository) => repository.id))
          : undefined;
      } catch {
        return undefined;
      }
    };
    const stopWebhooks = startWebhookWorker({
      pool: store.pool,
      store: webhooks,
      access,
    });
    const server = app.listen(port, () =>
      log.info(`ship.live listening on http://localhost:${port}`, {
        eventRetentionDays: retention.eventDays || "indefinite",
        deliveryRetentionDays: retention.deliveryDays || "indefinite",
      }),
    );
    let stopping = false;
    const stop = async (exitCode: number) => {
      if (stopping) return;
      stopping = true;
      // Bound shutdown even if a database or open SSE client is unresponsive.
      const timeout = setTimeout(() => process.exit(exitCode), 5_000);
      timeout.unref();
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
      stopProcessMetrics();
      stopPoolMetrics();
      await stopHealth();
      await stopRetention();
      await stopWebhooks();
      await store.close();
      clearTimeout(timeout);
      process.exitCode = exitCode;
    };
    server.once("error", () => {
      log.error(
        "Could not start the HTTP server. Check PORT and whether it is already in use.",
      );
      void stop(1);
    });
    for (const signal of ["SIGTERM", "SIGINT"] as const)
      process.once(signal, () => void stop(0));
  } catch (error) {
    await store.close();
    // Configuration errors name the setting to fix and never include its value.
    log.error(
      "Could not initialize ship.live. Check the Supabase, GitHub App, and database configuration.",
      { error },
    );
    process.exitCode = 1;
  }
}

await main();
