import "dotenv/config";
import express from "express";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { PostgresEventStore } from "./postgres-store.js";

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
  const config = {
    organization: process.env.GITHUB_ORG?.trim() || undefined,
    token: process.env.GITHUB_TOKEN?.trim() || undefined,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET?.trim() || undefined,
    dashboardAccessKey: process.env.DASHBOARD_ACCESS_KEY?.trim() || undefined,
  };
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
    const app = await createApp(config, store);
    if (process.env.NODE_ENV === "production") {
      const dist = fileURLToPath(new URL("../dist/", import.meta.url));
      app.use(express.static(dist));
      app.get(/.*/, (_request, response) =>
        response.sendFile(resolve(dist, "index.html")),
      );
    }
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
      "Could not initialize ship.live. Check the organization configuration and database connection.",
    );
    process.exitCode = 1;
  }
}

await main();
