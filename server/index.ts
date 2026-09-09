import "dotenv/config";
import express from "express";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthService, authConfigFromEnv } from "./auth.js";
import { GitHubApp } from "./github-app.js";
import { PostgresEventStore } from "./postgres-store.js";
import {
  githubAppConfigFromEnv,
  trustProxyHopsFromEnv,
} from "./runtime-config.js";
import { createWorkspaceApp } from "./workspace-app.js";
import { HealthStore } from "./health-store.js";
import { startHealthWorker } from "./health-worker.js";
import { WorkspaceStore } from "./workspace-store.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error(
      "Set DATABASE_URL to a PostgreSQL database before starting ship.live.",
    );
    process.exitCode = 1;
    return;
  }
  const port = Number(process.env.PORT || 3001);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    console.error("PORT must be a valid TCP port.");
    process.exitCode = 1;
    return;
  }
  let store: PostgresEventStore;
  try {
    store = await PostgresEventStore.open(databaseUrl);
  } catch {
    console.error(
      "Could not initialize PostgreSQL. Check DATABASE_URL, database permissions, and schema compatibility.",
    );
    process.exitCode = 1;
    return;
  }
  try {
    const authConfig = authConfigFromEnv();
    const githubConfig = githubAppConfigFromEnv(authConfig);
    const auth = new AuthService(authConfig, store.pool);
    const workspaces = new WorkspaceStore(
      store.pool,
      process.env.TOKEN_ENCRYPTION_KEY?.trim(),
    );
    const app = createWorkspaceApp({
      auth,
      store,
      workspaces,
      github: githubConfig ? new GitHubApp(githubConfig) : undefined,
      webhookSecret: process.env.GITHUB_WEBHOOK_SECRET?.trim(),
      trustProxyHops: trustProxyHopsFromEnv(),
    });
    if (process.env.NODE_ENV === "production") {
      const dist = fileURLToPath(new URL("../dist/", import.meta.url));
      app.use((_request, response, next) => {
        response.set({
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://avatars.githubusercontent.com https://*.googleusercontent.com; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "X-Frame-Options": "DENY",
        });
        next();
      });
      // Vite fingerprints assets; only these files can be cached across deploys.
      app.use(
        "/assets",
        express.static(resolve(dist, "assets"), {
          maxAge: "1y",
          immutable: true,
        }),
      );
      app.use(express.static(dist));
      app.get(/.*/, (_request, response) =>
        response.sendFile(resolve(dist, "index.html")),
      );
    }
    const stopHealth = startHealthWorker(new HealthStore(store.pool));
    const server = app.listen(port, () =>
      console.log(`ship.live listening on http://localhost:${port}`),
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
      await stopHealth();
      await store.close();
      clearTimeout(timeout);
      process.exitCode = exitCode;
    };
    server.once("error", () => {
      console.error(
        "Could not start the HTTP server. Check PORT and whether it is already in use.",
      );
      void stop(1);
    });
    for (const signal of ["SIGTERM", "SIGINT"] as const)
      process.once(signal, () => void stop(0));
  } catch {
    await store.close();
    console.error(
      "Could not initialize ship.live. Check the Supabase, GitHub App, and database configuration.",
    );
    process.exitCode = 1;
  }
}

await main();
