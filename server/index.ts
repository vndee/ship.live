import "dotenv/config";
import express from "express";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { EventStore } from "./store.js";

const config = {
  organization: process.env.GITHUB_ORG?.trim() || undefined,
  token: process.env.GITHUB_TOKEN?.trim() || undefined,
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET?.trim() || undefined,
  dashboardAccessKey: process.env.DASHBOARD_ACCESS_KEY?.trim() || undefined,
};
const store = await EventStore.open(
  resolve(process.env.DATA_DIR || ".data", "events.json"),
);
const app = createApp(config, store);

if (process.env.NODE_ENV === "production") {
  const dist = fileURLToPath(new URL("../dist/", import.meta.url));
  app.use(express.static(dist));
  app.get(/.*/, (_request, response) =>
    response.sendFile(resolve(dist, "index.html")),
  );
}

const port = Number(process.env.PORT || 3001);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be a valid TCP port.");
const server = app.listen(port, () =>
  console.log(`ship.live listening on http://localhost:${port}`),
);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    // SSE connections may otherwise prevent the process from stopping.
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
