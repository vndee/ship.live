import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { AuthService } from "./auth.js";
import { PostgresEventStore } from "./postgres-store.js";
import { SECURITY_HEADERS } from "./security.js";
import { createTestDatabase } from "./test-database.js";
import { createWorkspaceApp } from "./workspace-app.js";
import { WorkspaceStore } from "./workspace-store.js";

type Options = Partial<Parameters<typeof createWorkspaceApp>[0]>;
const TOKEN = "synthetic-metrics-token-0123456789";

async function withServer(
  t: TestContext,
  options: Options,
  run: (
    request: (path: string, init?: RequestInit) => Promise<Response>,
  ) => Promise<void>,
) {
  const database = await createTestDatabase(t);
  if (!database) return;
  const store = await PostgresEventStore.open(database);
  const server = createWorkspaceApp({
    store,
    auth: new AuthService({ appUrl: "http://127.0.0.1:5173" }, store.pool),
    workspaces: new WorkspaceStore(store.pool),
    ...options,
  }).listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await run((path, init) =>
      fetch(`http://127.0.0.1:${address.port}${path}`, {
        ...init,
        signal: AbortSignal.timeout(4000),
      }),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
  }
}

test("every response carries a request ID and the configured headers", async (t) => {
  await withServer(
    t,
    { responseHeaders: SECURITY_HEADERS },
    async (request) => {
      const first = await request("/api/not-a-route");
      const second = await request("/api/health");
      assert.equal(first.status, 404);
      assert.equal(second.status, 200);
      const ids = [first, second].map((response) =>
        response.headers.get("x-request-id"),
      );
      for (const id of ids) assert.match(id || "", /^[0-9a-f-]{36}$/);
      assert.notEqual(ids[0], ids[1]);
      assert.equal(
        first.headers.get("content-security-policy"),
        SECURITY_HEADERS["Content-Security-Policy"],
      );
      assert.equal(first.headers.get("x-powered-by"), null);
    },
  );
});

test("clients over the request limit get 429 with retry guidance; the health check is exempt", async (t) => {
  await withServer(t, { rateLimits: { api: 2 } }, async (request) => {
    const responses = [];
    for (let index = 0; index < 3; index += 1)
      responses.push(await request("/api/not-a-route"));
    assert.deepEqual(
      responses.map((response) => response.status),
      [404, 404, 429],
    );
    const limited = responses[2];
    assert.equal(limited.headers.get("ratelimit-limit"), "2");
    assert.equal(limited.headers.get("ratelimit-remaining"), "0");
    const retry = Number(limited.headers.get("retry-after"));
    assert.ok(retry >= 1 && retry <= 60);
    assert.match((await limited.json()).error, /Too many requests/);
    assert.equal((await request("/api/health")).status, 200);
  });
});

test("inbound alerts count against the webhook limit, not the API limit", async (t) => {
  await withServer(t, { rateLimits: { api: 1 } }, async (request) => {
    const statuses = [];
    for (let index = 0; index < 3; index += 1)
      statuses.push(
        (await request("/api/hooks/not-a-token", { method: "POST" })).status,
      );
    assert.ok(!statuses.includes(429), statuses.join(", "));
    assert.equal((await request("/api/not-a-route")).status, 404);
    assert.equal((await request("/api/not-a-route")).status, 429);
  });
});

test("/metrics is absent without a token and otherwise requires it", async (t) => {
  await withServer(t, {}, async (request) => {
    assert.equal((await request("/metrics")).status, 404);
  });
  await withServer(t, { metricsToken: TOKEN }, async (request) => {
    const anonymous = await request("/metrics");
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get("www-authenticate") || "", /Bearer/);
    const wrong = await request("/metrics", {
      headers: { authorization: `Bearer ${TOKEN}x` },
    });
    assert.equal(wrong.status, 401);
    await request("/api/health");
    await request("/api/workspaces/5f0e/feed");
    // The previous responses are recorded when they finish on the server.
    let body = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const scrape = await request("/metrics", {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(scrape.status, 200);
      assert.match(scrape.headers.get("content-type") || "", /^text\/plain/);
      body = await scrape.text();
      if (body.includes('route="/api/workspaces/:id/feed"')) break;
      await delay(25);
    }
    assert.match(
      body,
      /ship_live_http_requests_total\{method="GET",route="\/api\/health",status="200"\} \d+/,
    );
    // Route patterns, not paths: the workspace ID never becomes a label.
    assert.match(body, /route="\/api\/workspaces\/:id\/feed"/);
    assert.doesNotMatch(body, /5f0e/);
    assert.match(body, /ship_live_http_request_duration_seconds_bucket/);
  });
});
