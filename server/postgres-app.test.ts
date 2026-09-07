import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import type { ActivityEvent } from "../shared/types.js";
import { createApp, type ServerConfig } from "./app.js";
import { GitHubFeed } from "./github.js";
import { PostgresEventStore } from "./postgres-store.js";
import { createTestDatabase } from "./test-database.js";

const config: ServerConfig = {
  organization: "our-team",
  webhookSecret: "isolated-webhook-secret",
  dashboardAccessKey: "isolated-dashboard-key",
};

function webhook(number = 42, title = "Private deployment improvement") {
  return {
    action: "closed",
    organization: { login: "our-team" },
    repository: {
      full_name: "our-team/private-service",
      owner: { login: "our-team" },
      private: true,
    },
    sender: { login: "engineer" },
    pull_request: {
      number,
      title,
      merged: true,
      merged_at: "2026-09-07T08:00:00.000Z",
      user: { login: "engineer" },
    },
  };
}

async function sendWebhook(url: string, delivery: string, payload = webhook()) {
  const body = JSON.stringify(payload);
  return fetch(`${url}/api/webhooks/github`, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(3_000),
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": delivery,
      "x-hub-signature-256": `sha256=${createHmac("sha256", config.webhookSecret!).update(body).digest("hex")}`,
    },
  });
}

class Stream {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly abort: AbortController,
  ) {}

  async nextFrame(): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.abort.abort();
        reject(new Error("No SSE frame or stream closure within 3 seconds."));
      }, 3_000);
    });
    try {
      return await Promise.race([this.readFrame(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readFrame(): Promise<string | null> {
    while (true) {
      const end = this.buffer.indexOf("\n\n");
      if (end !== -1) {
        const frame = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        return frame;
      }
      const chunk = await this.reader.read();
      if (chunk.done) return null;
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  async close(): Promise<void> {
    this.abort.abort();
    await this.reader.cancel().catch(() => undefined);
  }
}

function activity(frame: string | null): ActivityEvent {
  assert.ok(frame);
  assert.match(frame, /^event: activity\n/);
  const data = frame.split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6)) as ActivityEvent;
}

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 3_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withApps(
  t: TestContext,
  run: (context: {
    start: (
      options: ServerConfig,
      fetcher?: typeof fetch,
    ) => Promise<{ url: string; store: PostgresEventStore }>;
    stream: (url: string, key?: string) => Promise<Stream>;
  }) => Promise<void>,
) {
  const databaseUrl = await createTestDatabase(t);
  if (!databaseUrl) return;
  const stores: PostgresEventStore[] = [];
  const servers: Server[] = [];
  const streams: Stream[] = [];
  try {
    await run({
      start: async (options, fetcher = async () => new Response("[]")) => {
        const store = await PostgresEventStore.open(databaseUrl);
        stores.push(store);
        const app = await createApp(
          options,
          store,
          new GitHubFeed(options, fetcher),
        );
        const server = app.listen(0, "127.0.0.1");
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
          server.once("listening", resolve);
          server.once("error", reject);
        });
        return {
          url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          store,
        };
      },
      stream: async (url, key) => {
        const abort = new AbortController();
        const headers = key ? { "x-dashboard-key": key } : undefined;
        const timer = setTimeout(() => abort.abort(), 3_000);
        let response: Response;
        try {
          response = await fetch(`${url}/api/events?org=our-team`, {
            headers,
            signal: abort.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        assert.equal(response.status, 200);
        assert.match(
          response.headers.get("content-type") ?? "",
          /^text\/event-stream(?:;|$)/,
        );
        const stream = new Stream(response.body!.getReader(), abort);
        streams.push(stream);
        assert.match((await stream.nextFrame()) ?? "", /event: connected/);
        return stream;
      },
    });
  } finally {
    // The helper drops the database in t.after; release HTTP and DB sessions first.
    await Promise.all(streams.map((stream) => stream.close()));
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
    await Promise.all(stores.map((store) => store.close()));
  }
}

test("a private webhook crosses independent PostgreSQL-backed apps and duplicate delivery stays deduplicated", async (t) => {
  await withApps(t, async ({ start, stream }) => {
    const [instanceA, instanceB] = await Promise.all([
      start(config),
      start(config),
    ]);
    assert.notEqual(instanceA.store, instanceB.store);
    const live = await stream(instanceB.url, config.dashboardAccessKey);
    const first = await sendWebhook(instanceA.url, "cross-instance-first");
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), { accepted: true, duplicate: false });
    const received = activity(await live.nextFrame());
    assert.equal(received.id, "our-team/private-service:pr:42:merged");
    assert.equal(received.title, "Private deployment improvement");

    const duplicate = await sendWebhook(instanceB.url, "cross-instance-first");
    assert.equal(duplicate.status, 202);
    assert.deepEqual(await duplicate.json(), {
      accepted: true,
      duplicate: true,
    });
    assert.equal((await instanceA.store.list("our-team")).length, 1);
    assert.equal((await instanceB.store.list("our-team")).length, 1);
    const saved = await fetch(`${instanceB.url}/api/feed?org=our-team`, {
      headers: { "x-dashboard-key": config.dashboardAccessKey! },
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).events, [received]);

    // A subsequent delivery is a barrier: an accidental duplicate SSE frame appears first.
    const barrier = await sendWebhook(
      instanceA.url,
      "cross-instance-barrier",
      webhook(43, "Next private improvement"),
    );
    assert.equal(barrier.status, 202);
    assert.equal(
      activity(await live.nextFrame()).id,
      "our-team/private-service:pr:43:merged",
    );
  });
});

test("a different organization's configured key cannot open a protected PostgreSQL feed or stream", async (t) => {
  await withApps(t, async ({ start }) => {
    // Deliberately reuse the key value: authorization must bind the configured organization.
    const [instanceA, instanceB] = await Promise.all([
      start(config),
      start({ ...config, organization: "other-team" }),
    ]);
    assert.equal(
      (await sendWebhook(instanceA.url, "organization-boundary")).status,
      202,
    );
    for (const path of ["/api/feed?org=our-team", "/api/events?org=our-team"]) {
      const response = await fetch(instanceB.url + path, {
        headers: { "x-dashboard-key": config.dashboardAccessKey! },
        signal: AbortSignal.timeout(3_000),
      });
      assert.equal(response.status, 403);
      assert.doesNotMatch(
        await response.text(),
        /Private deployment improvement/,
      );
    }
    assert.equal(
      (await fetch(`${instanceA.url}/api/feed?org=our-team`)).status,
      401,
    );
    assert.equal((await instanceB.store.list("our-team")).length, 1);
  });
});

test("an existing public stream closes without private activity when another instance enables protection", async (t) => {
  await withApps(t, async ({ start, stream }) => {
    const publicInstance = await start({ organization: "our-team" });
    const live = await stream(publicInstance.url);
    assert.equal(
      await publicInstance.store.requiresProtection("our-team"),
      false,
    );
    const privateInstance = await start(config);
    assert.equal(
      await publicInstance.store.requiresProtection("our-team"),
      true,
    );
    const accepted = await sendWebhook(
      privateInstance.url,
      "protect-open-stream",
    );
    assert.equal(accepted.status, 202);
    assert.equal(
      await live.nextFrame(),
      null,
      "An unauthorized stream must close before writing private activity.",
    );
    assert.equal(
      (await publicInstance.store.list("our-team"))[0].title,
      "Private deployment improvement",
    );
    const reconnect = await fetch(
      `${publicInstance.url}/api/events?org=our-team`,
      { signal: AbortSignal.timeout(3_000) },
    );
    assert.equal(reconnect.status, 503);
    await reconnect.body?.cancel();
  });
});

test("an in-flight public feed reauthorizes after another PostgreSQL-backed instance becomes private", async (t) => {
  await withApps(t, async ({ start }) => {
    let started!: () => void;
    let release!: (response: Response) => void;
    const fetching = new Promise<void>((resolve) => {
      started = resolve;
    });
    const upstream = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const publicInstance = await start(
      { organization: "our-team" },
      async () => {
        started();
        return upstream;
      },
    );
    const pending = fetch(`${publicInstance.url}/api/feed?org=our-team`, {
      signal: AbortSignal.timeout(5_000),
    });
    try {
      await within(
        fetching,
        "The public feed did not start its upstream request.",
      );
      const privateInstance = await start(config);
      assert.equal(
        (await sendWebhook(privateInstance.url, "privacy-during-poll")).status,
        202,
      );
      release(new Response("[]"));
      const response = await pending;
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.events, undefined);
      assert.doesNotMatch(
        JSON.stringify(body),
        /Private deployment improvement/,
      );
      assert.equal((await publicInstance.store.list("our-team")).length, 1);
    } finally {
      release(new Response("[]"));
      await pending.catch(() => undefined);
    }
  });
});
