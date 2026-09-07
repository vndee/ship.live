import assert from "node:assert/strict";
import test from "node:test";
import { FeedError, GitHubFeed, githubHeaders } from "./github.js";

test("server token is attached only to the configured organization", () => {
  const config = { organization: "our-team", token: "server-secret" };
  assert.equal(
    githubHeaders("OUR-TEAM", config).Authorization,
    "Bearer server-secret",
  );
  assert.equal(githubHeaders("other-team", config).Authorization, undefined);
  assert.equal(
    githubHeaders("our-team", { token: "server-secret" }).Authorization,
    undefined,
  );
});

test("polling coalesces concurrent requests, obeys poll interval, and sends conditional ETags", async () => {
  let now = Date.parse("2026-09-07T08:00:00Z");
  const calls: RequestInit[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(
      input,
      "https://api.github.com/orgs/our-team/events?per_page=100",
    );
    calls.push(init!);
    return calls.length === 1
      ? new Response("[]", {
          headers: { etag: '"version-1"', "x-poll-interval": "90" },
        })
      : new Response(null, {
          status: 304,
          headers: { "x-poll-interval": "90" },
        });
  };
  const feed = new GitHubFeed({}, fetcher, () => now);
  await Promise.all([feed.get("our-team"), feed.get("our-team")]);
  assert.equal(calls.length, 1);
  now += 61_000;
  await feed.get("our-team");
  assert.equal(calls.length, 1);
  now += 30_000;
  await feed.get("our-team");
  assert.equal(calls.length, 2);
  assert.equal(
    (calls[1].headers as Record<string, string>)["If-None-Match"],
    '"version-1"',
  );
  assert.equal(calls[0].redirect, "error");
});

test("public polling fails closed for private or other-organization events", async () => {
  const event = {
    id: "1",
    type: "PushEvent",
    public: true,
    actor: { login: "dev" },
    repo: { name: "our-team/service" },
    payload: { ref: "refs/heads/main", head: "a".repeat(40) },
    created_at: "2026-09-07T08:00:00Z",
  };
  const fetcher: typeof fetch = async () =>
    new Response(
      JSON.stringify([
        event,
        { ...event, id: "2", public: false },
        { ...event, id: "3", repo: { name: "other-team/secret" } },
      ]),
    );
  const result = await new GitHubFeed({}, fetcher).get("our-team");
  assert.equal(result.events.length, 1);
});

test("GitHub rate limits return readable retry errors and prevent repeated upstream requests", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return new Response("{}", {
      status: 429,
      headers: { "retry-after": "120" },
    });
  };
  const feed = new GitHubFeed({}, fetcher);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(
      feed.get("our-team"),
      (error: unknown) =>
        error instanceof FeedError &&
        error.status === 429 &&
        error.retryAfter === 120,
    );
  }
  assert.equal(calls, 1);
});
