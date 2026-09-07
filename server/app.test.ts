import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import type { ActivityEvent, FeedResponse } from "../shared/types.js";
import { getMetrics } from "../src/lib/activity.js";
import { createApp, type ServerConfig } from "./app.js";
import { GitHubFeed } from "./github.js";
import { MemoryEventStore, type EventStore } from "./store.js";

const config = {
  organization: "our-team",
  webhookSecret: "hook-secret",
  dashboardAccessKey: "dashboard-secret",
  token: "github-secret",
};
const payload = {
  action: "closed",
  organization: { login: "our-team" },
  repository: {
    full_name: "our-team/private-service",
    owner: { login: "our-team" },
    private: true,
  },
  sender: { login: "engineer" },
  pull_request: {
    number: 1,
    title: "Private change",
    merged: true,
    merged_at: "2026-09-07T08:00:00Z",
  },
};

async function setup(
  t: TestContext,
  options: ServerConfig = config,
  existing?: EventStore,
  upstreamEvents: unknown[] = [],
) {
  const store = existing ?? new MemoryEventStore();
  const calls: { input: unknown; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify(upstreamEvents));
  };
  const app = await createApp(options, store, new GitHubFeed(options, fetcher));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { store, calls, url };
}

function signedBody(value: unknown = payload) {
  const body = JSON.stringify(value);
  return {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-1",
      "x-hub-signature-256": `sha256=${createHmac("sha256", config.webhookSecret).update(body).digest("hex")}`,
    },
  };
}

test("configured private feed and stream require access key, public org requests cannot use token", async (t) => {
  const { url, calls } = await setup(t);
  for (const path of ["/api/feed?org=our-team", "/api/events?org=our-team"])
    assert.equal((await fetch(url + path)).status, 401);
  assert.equal(calls.length, 0);
  assert.equal((await fetch(`${url}/api/feed?org=another-team`)).status, 200);
  assert.equal(
    (calls[0].init?.headers as Record<string, string>).Authorization,
    undefined,
  );
  assert.equal(
    (
      await fetch(`${url}/api/feed?org=our-team`, {
        headers: { "x-dashboard-key": config.dashboardAccessKey },
      })
    ).status,
    200,
  );
  assert.equal(
    (calls[1].init?.headers as Record<string, string>).Authorization,
    "Bearer github-secret",
  );
  const health = await (await fetch(`${url}/api/health`)).json();
  assert.deepEqual(health, {
    status: "ok",
    configuredOrg: "our-team",
    privateFeed: true,
    webhookConfigured: true,
  });
});

test("verified webhook is persisted once and visible only in the authorized organization feed", async (t) => {
  const { url, store } = await setup(t);
  const first = await fetch(`${url}/api/webhooks/github`, signedBody());
  assert.equal(first.status, 202);
  assert.equal((await first.json()).duplicate, false);
  const second = await fetch(`${url}/api/webhooks/github`, signedBody());
  assert.equal((await second.json()).duplicate, true);
  assert.equal((await store.list("our-team")).length, 1);
  const response = await fetch(`${url}/api/feed?org=our-team`, {
    headers: { "x-dashboard-key": config.dashboardAccessKey },
  });
  assert.equal((await response.json()).events[0].title, "Private change");
  const publicResponse = await fetch(`${url}/api/feed?org=another-team`);
  assert.deepEqual((await publicResponse.json()).events, []);
});

test("webhooks reject tampering and wrong organization without writing any events", async (t) => {
  const { url, store } = await setup(t);
  const tampered = {
    ...signedBody(),
    body: JSON.stringify({ ...payload, action: "opened" }),
  };
  assert.equal(
    (await fetch(`${url}/api/webhooks/github`, tampered)).status,
    401,
  );
  const wrongOrg = signedBody({
    ...payload,
    organization: { login: "another-team" },
  });
  assert.equal(
    (await fetch(`${url}/api/webhooks/github`, wrongOrg)).status,
    403,
  );
  assert.equal((await store.list("our-team")).length, 0);
});

test("an authenticated SSE connection receives a verified webhook immediately", async (t) => {
  const { url } = await setup(t);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(`${url}/api/events?org=our-team`, {
    headers: { "x-dashboard-key": config.dashboardAccessKey },
    signal: abort.signal,
  });
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/event-stream(?:;|$)/,
  );
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: connected/);
  const delivery = await fetch(`${url}/api/webhooks/github`, signedBody());
  assert.equal(delivery.status, 202);
  const frame = new TextDecoder().decode((await reader.read()).value);
  assert.match(frame, /event: activity/);
  assert.match(frame, /Private change/);
  await reader.cancel();
});

test("reclosing an issue streams the original closure so weekly XP cannot be earned again", async (t) => {
  const { url } = await setup(t);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(`${url}/api/events?org=our-team`, {
    headers: { "x-dashboard-key": config.dashboardAccessKey },
    signal: abort.signal,
  });
  const reader = response.body!.getReader();
  await reader.read();
  for (const [index, closed_at] of [
    "2026-09-07T08:00:00.000Z",
    "2026-09-14T08:00:00.000Z",
  ].entries()) {
    const request = signedBody({
      ...payload,
      issue: {
        number: 10,
        title: "A completed issue",
        state_reason: "completed",
        closed_at,
      },
    });
    request.headers["x-github-event"] = "issues";
    request.headers["x-github-delivery"] = `issue-close-${index}`;
    assert.equal(
      (await fetch(`${url}/api/webhooks/github`, request)).status,
      202,
    );
    const frame = new TextDecoder().decode((await reader.read()).value);
    assert.match(frame, /2026-09-07T08:00:00.000Z/);
    assert.doesNotMatch(frame, /2026-09-14/);
  }
  await reader.cancel();
});

test("public refresh cannot revive issue credit when its canonical closure is older than the 2000-event feed", async (t) => {
  const store = new MemoryEventStore();
  const issue: ActivityEvent = {
    id: "our-team/private-service:issue:10:closed",
    type: "issue",
    actor: { login: "engineer" },
    repo: "our-team/private-service",
    title: "A completed issue",
    occurredAt: "2026-09-07T08:00:00.000Z",
    number: 10,
  };
  const recent = Array.from({ length: 2000 }, (_, index): ActivityEvent => ({
    ...issue,
    id: `recent-push-${index}`,
    type: "push",
    occurredAt: new Date(
      Date.parse("2026-09-14T08:00:00.000Z") + index * 1000,
    ).toISOString(),
  }));
  await store.merge("our-team", [issue, ...recent]);
  const upstream = [
    {
      id: "upstream-reclosed-issue",
      type: "IssuesEvent",
      public: true,
      actor: { login: "engineer" },
      repo: { name: issue.repo },
      created_at: "2026-09-15T08:00:00.000Z",
      payload: {
        action: "closed",
        issue: {
          number: 10,
          title: issue.title,
          state_reason: "completed",
          closed_at: "2026-09-15T08:00:00.000Z",
        },
      },
    },
  ];
  const { url } = await setup(t, config, store, upstream);
  const response = await fetch(`${url}/api/feed?org=our-team`, {
    headers: { "x-dashboard-key": config.dashboardAccessKey },
  });
  assert.equal(response.status, 200);
  const feed: FeedResponse = await response.json();
  assert.equal(feed.events.length, 2000);
  assert.equal(
    feed.events.some((event) => event.id === issue.id),
    false,
  );
  assert.equal(
    getMetrics(feed.events, Date.parse("2026-09-16T08:00:00.000Z")).xp,
    0,
  );
  assert.deepEqual(await store.get("our-team", issue.id), issue);
});

test("webhook configuration alone protects the feed and requires a dashboard key", async (t) => {
  const { url } = await setup(t, {
    organization: "our-team",
    webhookSecret: config.webhookSecret,
  });
  assert.equal((await fetch(`${url}/api/feed?org=our-team`)).status, 503);
  assert.equal(
    (await fetch(`${url}/api/webhooks/github`, signedBody())).status,
    503,
  );
});

test("removing webhook credentials does not expose previously saved private data", async (t) => {
  const store = new MemoryEventStore();
  await store.merge("our-team", [], { restricted: true });
  const { url } = await setup(t, { organization: "our-team" }, store);
  assert.equal((await fetch(`${url}/api/feed?org=our-team`)).status, 503);
  assert.equal((await fetch(`${url}/api/events?org=our-team`)).status, 503);
});

test("invalid organization inputs are rejected before a GitHub request", async (t) => {
  const { url, calls } = await setup(t, {});
  assert.equal((await fetch(`${url}/api/feed?org=..%2Fsecret`)).status, 400);
  assert.equal((await fetch(`${url}/api/feed`)).status, 400);
  assert.equal(calls.length, 0);
});

test("one organization's dashboard key cannot open another organization's protected stream", async (t) => {
  const store = new MemoryEventStore();
  await store.merge("another-team", [], { restricted: true });
  const { url } = await setup(t, config, store);
  const response = await fetch(`${url}/api/events?org=another-team`, {
    headers: { "x-dashboard-key": config.dashboardAccessKey },
  });
  await response.body?.cancel();
  assert.equal(response.status, 403);
});

test("a webhook on one app reaches an authenticated stream on another app sharing its store", async (t) => {
  const first = await setup(t);
  const second = await setup(t, config, first.store);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(`${second.url}/api/events?org=our-team`, {
    headers: { "x-dashboard-key": config.dashboardAccessKey },
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(1500)]),
  });
  const reader = response.body!.getReader();
  await reader.read();
  const delivery = await fetch(
    `${first.url}/api/webhooks/github`,
    signedBody(),
  );
  assert.equal(delivery.status, 202);
  const frame = new TextDecoder().decode((await reader.read()).value);
  assert.match(frame, /event: activity/);
  assert.match(frame, /Private change/);
  await reader.cancel();
});
