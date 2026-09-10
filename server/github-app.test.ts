import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import type { ActivityEvent } from "../shared/types.js";
import {
  backfillNotice,
  GitHubApp,
  type GitHubAppConfig,
} from "./github-app.js";
import { FeedError } from "./github.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config: GitHubAppConfig = {
  appId: "1234",
  clientId: "Iv1.test-app-client",
  clientSecret: "test-client-secret",
  privateKey: keys.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString(),
  slug: "ship-live-test",
  appUrl: "https://ship.example",
};
const permissions = {
  metadata: "read",
  contents: "read",
  pull_requests: "read",
  issues: "read",
  actions: "read",
  checks: "read",
  statuses: "read",
  deployments: "read",
};
const installation = (id = 7, account = "our-team") => ({
  id,
  app_id: 1234,
  account: { id: id + 100, login: account, type: "Organization" },
  suspended_at: null,
});
const json = (body: unknown, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
  });
const installationToken = () =>
  json({
    token: "ghs_installation",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    permissions,
  });

function mockApi(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.protocol, "https:");
    assert.ok(["api.github.com", "github.com"].includes(url.hostname));
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    return handler(url, init);
  };
}

test("GitHub App authorization uses its client ID, a fixed callback and S256 PKCE", () => {
  const app = new GitHubApp(config);
  const verifier = "a".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(app.authorizationUrl("anti-forgery-state", challenge));
  assert.equal(
    url.origin + url.pathname,
    "https://github.com/login/oauth/authorize",
  );
  assert.equal(url.searchParams.get("client_id"), "Iv1.test-app-client");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://ship.example/api/github/callback",
  );
  assert.equal(url.searchParams.get("state"), "anti-forgery-state");
  assert.equal(url.searchParams.get("code_challenge"), challenge);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), null);
  assert.equal(
    app.installUrl(),
    "https://github.com/apps/ship-live-test/installations/new",
  );
  assert.throws(() => app.authorizationUrl("", challenge));
  assert.throws(() => app.authorizationUrl("state", "plain-verifier"));
});

test("authorization exchange binds the verifier and refresh rotates expiring grants without URL secrets", async () => {
  const requests: URLSearchParams[] = [];
  const app = new GitHubApp(
    config,
    mockApi((url, init) => {
      assert.equal(url.href, "https://github.com/login/oauth/access_token");
      assert.equal(init.method, "POST");
      const body = new URLSearchParams(String(init.body));
      requests.push(body);
      assert.equal(body.get("client_id"), config.clientId);
      assert.equal(body.get("client_secret"), config.clientSecret);
      return json({
        access_token: `ghu_token_${requests.length}`,
        refresh_token: `ghr_token_${requests.length}`,
        token_type: "bearer",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
      });
    }),
  );
  const before = Date.now();
  const grant = await app.exchange("authorization-code", "v".repeat(64));
  assert.equal(requests[0].get("code"), "authorization-code");
  assert.equal(requests[0].get("code_verifier"), "v".repeat(64));
  assert.equal(
    requests[0].get("redirect_uri"),
    "https://ship.example/api/github/callback",
  );
  assert.ok(
    grant.expiresAt >= before + 28_800_000 &&
      grant.expiresAt <= Date.now() + 28_800_000,
  );
  assert.ok(grant.refreshExpiresAt! >= before + 15_897_600_000);
  const refreshed = await app.refresh(grant.refreshToken!);
  assert.equal(requests[1].get("grant_type"), "refresh_token");
  assert.equal(requests[1].get("refresh_token"), "ghr_token_1");
  assert.equal(refreshed.accessToken, "ghu_token_2");
  assert.equal(refreshed.refreshToken, "ghr_token_2");
});

test("OAuth errors and malformed or non-expiring token responses fail without exposing secrets", async () => {
  for (const body of [
    { error: "bad_verification_code", error_description: "test-client-secret" },
    { access_token: "ghu_forever", token_type: "bearer" },
    { access_token: "ghu_bad", token_type: "bearer", expires_in: -1 },
  ]) {
    const app = new GitHubApp(
      config,
      mockApi(() => json(body)),
    );
    await assert.rejects(
      app.exchange("code", "v".repeat(64)),
      (error: unknown) =>
        error instanceof Error && !error.message.includes(config.clientSecret),
    );
  }
});

test("viewer identity and complete installation/repository pagination use only the user grant", async () => {
  const paths: string[] = [];
  const app = new GitHubApp(
    config,
    mockApi((url, init) => {
      assert.equal(
        new Headers(init.headers).get("authorization"),
        "Bearer ghu_viewer",
      );
      paths.push(url.pathname);
      if (url.pathname === "/user") return json({ id: 99, login: "viewer" });
      if (url.pathname === "/user/installations") {
        if (url.searchParams.get("page") === "2")
          return json({
            total_count: 2,
            installations: [installation(8, "second-team")],
          });
        return json(
          { total_count: 2, installations: [installation()] },
          {
            link: '<https://api.github.com/user/installations?per_page=100&page=2>; rel="next"',
          },
        );
      }
      assert.equal(url.pathname, "/user/installations/7/repositories");
      if (url.searchParams.get("page") === "2")
        return json({
          total_count: 2,
          repositories: [
            { id: 102, full_name: "our-team/second", private: false },
          ],
        });
      return json(
        {
          total_count: 2,
          repositories: [
            { id: 101, full_name: "our-team/first", private: true },
          ],
        },
        {
          link: '<https://api.github.com/user/installations/7/repositories?per_page=100&page=2>; rel="next"',
        },
      );
    }),
  );
  assert.deepEqual(await app.user("ghu_viewer"), { id: 99, login: "viewer" });
  assert.deepEqual(
    (await app.installations("ghu_viewer")).map((item) => item.id),
    [7, 8],
  );
  assert.deepEqual(await app.repositories("ghu_viewer", 7), [
    { id: 101, name: "our-team/first", private: true },
    { id: 102, name: "our-team/second", private: false },
  ]);
  assert.ok(paths.every((path) => path.startsWith("/user")));
});

test("permission listings reject foreign apps, inaccessible installations, suspended grants and untrusted pagination", async () => {
  for (const next of [
    "https://evil.example/user/installations?page=2&per_page=100",
    "https://api.github.com.evil.example/user/installations?page=2&per_page=100",
    "https://attacker@api.github.com/user/installations?page=2&per_page=100",
    "https://api.github.com/app/installations?page=2&per_page=100",
    "https://api.github.com/user/installations?page=1&per_page=100",
  ]) {
    let calls = 0;
    const app = new GitHubApp(
      config,
      mockApi(() => {
        calls += 1;
        return json(
          { total_count: 2, installations: [installation()] },
          { link: `<${next}>; rel="next"` },
        );
      }),
    );
    await assert.rejects(app.installations("ghu_viewer"));
    assert.equal(calls, 1);
  }
  const foreign = new GitHubApp(
    config,
    mockApi(() =>
      json({
        total_count: 1,
        installations: [{ ...installation(), app_id: 9999 }],
      }),
    ),
  );
  await assert.rejects(foreign.installations("ghu_viewer"));
  const suspended = new GitHubApp(
    config,
    mockApi(() =>
      json({
        total_count: 1,
        installations: [
          { ...installation(), suspended_at: new Date().toISOString() },
        ],
      }),
    ),
  );
  await assert.rejects(suspended.repositories("ghu_viewer", 7));
  const missing = new GitHubApp(
    config,
    mockApi(() => json({ total_count: 0, installations: [] })),
  );
  await assert.rejects(missing.repositories("ghu_viewer", 7));
});

test("viewer pagination refuses missing pages, changing totals and lists beyond 100 pages", async () => {
  const incomplete = new GitHubApp(
    config,
    mockApi(() => json({ total_count: 2, installations: [installation()] })),
  );
  await assert.rejects(incomplete.installations("ghu_viewer"));
  let count = 0;
  const unbounded = new GitHubApp(
    config,
    mockApi((url) => {
      const page = Number(url.searchParams.get("page"));
      count += 1;
      return json(
        { total_count: 101, installations: [installation(page)] },
        {
          link: `<https://api.github.com/user/installations?per_page=100&page=${page + 1}>; rel="next"`,
        },
      );
    }),
  );
  await assert.rejects(unbounded.installations("ghu_viewer"));
  assert.equal(count, 100);
  const changed = new GitHubApp(
    config,
    mockApi((url) =>
      url.searchParams.get("page") === "2"
        ? json({ total_count: 3, installations: [installation(8)] })
        : json(
            { total_count: 2, installations: [installation()] },
            {
              link: '<https://api.github.com/user/installations?per_page=100&page=2>; rel="next"',
            },
          ),
    ),
  );
  await assert.rejects(changed.installations("ghu_viewer"));
});

test("installation access verifies the app and uses a short RS256 JWT with read-only repository scope", async () => {
  const app = new GitHubApp(
    config,
    mockApi((url, init) => {
      const jwt = new Headers(init.headers)
        .get("authorization")!
        .replace(/^Bearer /, "");
      const [header, payload, signature] = jwt.split(".");
      assert.deepEqual(
        JSON.parse(Buffer.from(header, "base64url").toString()),
        { alg: "RS256", typ: "JWT" },
      );
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
      assert.equal(claims.iss, config.clientId);
      assert.ok(claims.iat <= Math.floor(Date.now() / 1000));
      assert.ok(
        claims.exp > Date.now() / 1000 &&
          claims.exp <= Math.floor(Date.now() / 1000) + 540,
      );
      assert.equal(
        verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${payload}`),
          keys.publicKey,
          Buffer.from(signature, "base64url"),
        ),
        true,
      );
      if (url.pathname === "/app/installations/7") return json(installation());
      assert.equal(url.pathname, "/app/installations/7/access_tokens");
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(String(init.body)), {
        permissions,
        repository_ids: [101, 102],
      });
      return installationToken();
    }),
  );
  assert.equal(
    await app.installationToken(7, [101, 102, 101]),
    "ghs_installation",
  );
  const wrong = new GitHubApp(
    config,
    mockApi(() => json({ ...installation(), app_id: 999 })),
  );
  await assert.rejects(wrong.installationToken(7, [101]));
  await assert.rejects(app.installationToken(7, []));
});

test("recent backfill keeps webhook identities, real contributors and repository IDs without source or push requests", async () => {
  const recent = new Date(Date.now() - 86_400_000).toISOString();
  const old = new Date(Date.now() - 45 * 86_400_000).toISOString();
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const pr = {
    number: 42,
    title: "Ship the fix",
    created_at: recent,
    updated_at: recent,
    merged_at: recent,
    user: { login: "author" },
  };
  const requested: string[] = [];
  const app = new GitHubApp(
    config,
    mockApi((url, init) => {
      requested.push(url.pathname);
      if (url.pathname === "/app/installations/7") return json(installation());
      if (url.pathname.endsWith("/access_tokens")) return installationToken();
      assert.equal(
        new Headers(init.headers).get("authorization"),
        "Bearer ghs_installation",
      );
      if (url.pathname.endsWith("/pulls"))
        return json([
          pr,
          {
            ...pr,
            number: 43,
            created_at: old,
            merged_at: null,
            updated_at: old,
          },
        ]);
      if (url.pathname.endsWith("/issues"))
        return json([
          {
            number: 9,
            title: "Resolved bug",
            closed_at: recent,
            state_reason: "completed",
            user: { login: "reporter" },
            closed_by: { login: "closer" },
          },
          {
            number: 10,
            title: "No actor",
            closed_at: recent,
            state_reason: "completed",
            user: { login: "reporter" },
          },
          {
            number: 11,
            title: "Not completed",
            closed_at: recent,
            state_reason: "not_planned",
            closed_by: { login: "closer" },
          },
        ]);
      if (url.pathname.endsWith("/releases"))
        return json([
          {
            id: 66,
            name: "v1",
            published_at: recent,
            draft: false,
            author: { login: "publisher" },
          },
          {
            id: 67,
            name: "future",
            published_at: future,
            draft: false,
            author: { login: "publisher" },
          },
        ]);
      assert.equal(url.pathname, "/repos/our-team/service/pulls/42/reviews");
      return json([
        {
          id: 77,
          submitted_at: recent,
          state: "APPROVED",
          user: { login: "reviewer" },
        },
        {
          id: 78,
          submitted_at: old,
          state: "COMMENTED",
          user: { login: "reviewer" },
        },
        { id: 79, state: "PENDING", user: { login: "reviewer" } },
      ]);
    }),
  );
  const events: ActivityEvent[] = [];
  const result = await app.backfill(
    7,
    [{ id: 101, name: "our-team/service", private: true }],
    async (batch) => {
      events.push(...batch);
    },
  );
  assert.equal(result.synced, 5);
  assert.deepEqual(
    new Set(events.map((item) => item.id)),
    new Set([
      `our-team/service:pr:42:opened:${recent}`,
      "our-team/service:pr:42:merged",
      "our-team/service:review:77",
      "our-team/service:issue:9:closed",
      "our-team/service:release:66",
    ]),
  );
  assert.ok(events.every((item) => item.repositoryId === 101));
  assert.equal(
    events.find((item) => item.type === "issue")?.actor.login,
    "closer",
  );
  assert.equal(
    events.find((item) => item.type === "review")?.actor.login,
    "reviewer",
  );
  assert.deepEqual([result.scanned, result.failed, result.skipped], [1, 0, 0]);
  assert.match(backfillNotice(result), /last 30 days/);
  assert.ok(
    requested.every((path) => !/(contents|commits|git\/|events)/.test(path)),
  );
});

test("backfill bounds repository and review work and propagates persistence failures", async () => {
  const recent = new Date(Date.now() - 1_000).toISOString();
  let reviews = 0;
  const repositoryPaths = new Set<string>();
  const app = new GitHubApp(
    config,
    mockApi((url) => {
      if (url.pathname === "/app/installations/7") return json(installation());
      if (url.pathname.endsWith("/access_tokens")) return installationToken();
      repositoryPaths.add(url.pathname.split("/")[3]);
      if (url.pathname.endsWith("/reviews")) {
        reviews += 1;
        return json([]);
      }
      if (url.pathname.endsWith("/pulls"))
        return json(
          Array.from({ length: 35 }, (_, index) => ({
            number: index + 1,
            created_at: recent,
            updated_at: recent,
            user: { login: "author" },
          })),
        );
      return json([]);
    }),
  );
  const repos = Array.from({ length: 21 }, (_, index) => ({
    id: index + 1,
    name: `our-team/repo${index}`,
    private: false,
  }));
  const result = await app.backfill(7, repos, async () => {});
  assert.equal(repositoryPaths.size, 20);
  assert.equal(reviews, 600);
  assert.deepEqual([result.scanned, result.skipped], [20, 1]);
  await assert.rejects(
    app.backfill(7, [repos[0]], async () => {
      throw new Error("Database unavailable");
    }),
    /Database unavailable/,
  );
});

test("GitHub App rate limits report when to retry, including secondary limits", async () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  const cases: Array<[number, Record<string, string>, number]> = [
    [
      403,
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
      600,
    ],
    [429, { "retry-after": "120" }, 120],
    // Secondary limits can arrive as 403s with remaining quota; this is not revoked access.
    [403, { "retry-after": "90", "x-ratelimit-remaining": "4000" }, 90],
  ];
  for (const [status, headers, retryAfter] of cases) {
    const app = new GitHubApp(
      config,
      mockApi(
        () =>
          new Response(JSON.stringify({ message: "limited" }), {
            status,
            headers: { "content-type": "application/json", ...headers },
          }),
      ),
    );
    await assert.rejects(
      app.installations("ghu_one"),
      (error: unknown) =>
        error instanceof FeedError &&
        error.status === 429 &&
        Math.abs((error.retryAfter ?? 0) - retryAfter) <= 2 &&
        new RegExp(`about ${Math.ceil(retryAfter / 60)} minutes`).test(
          error.message,
        ),
    );
  }
});

test("known installation listings skip a second user listing, and installation selections use the installation token", async () => {
  const paths: string[] = [];
  const app = new GitHubApp(
    config,
    mockApi((url, init) => {
      const authorization = new Headers(init.headers).get("authorization");
      paths.push(
        `${url.pathname}:${authorization?.startsWith("Bearer ghu_") ? "user" : "app"}`,
      );
      if (url.pathname === "/app/installations/7") return json(installation());
      if (url.pathname.endsWith("/access_tokens")) return installationToken();
      return json({
        total_count: 1,
        repositories: [{ id: 101, full_name: "our-team/first", private: true }],
      });
    }),
  );
  const repo = { id: 101, name: "our-team/first", private: true };
  const known = [
    {
      id: 7,
      accountId: 107,
      account: "our-team",
      kind: "Organization" as const,
      suspended: false,
    },
  ];
  assert.deepEqual(await app.repositories("ghu_viewer", 7, known), [repo]);
  assert.deepEqual(paths, ["/user/installations/7/repositories:user"]);
  paths.length = 0;
  assert.deepEqual(await app.installationRepositories(7), [repo]);
  assert.deepEqual(paths, [
    "/app/installations/7:app",
    "/app/installations/7/access_tokens:app",
    "/installation/repositories:app",
  ]);
});

test("backfill resumes each repository after its last import and reports stored repositories", async () => {
  const now = Date.now();
  const iso = (ago: number) => new Date(now - ago).toISOString();
  const reviewed: string[] = [];
  const issuesSince = new Map<string, number>();
  const app = new GitHubApp(
    config,
    mockApi((url) => {
      if (url.pathname === "/app/installations/7") return json(installation());
      if (url.pathname.endsWith("/access_tokens")) return installationToken();
      const [, , , repo, , number] = url.pathname.split("/");
      if (repo === "broken") return new Response("{}", { status: 404 });
      if (url.pathname.endsWith("/reviews")) {
        reviewed.push(`${repo}#${number}`);
        return json([]);
      }
      if (url.pathname.endsWith("/issues"))
        issuesSince.set(repo, Date.parse(url.searchParams.get("since")!));
      if (url.pathname.endsWith("/pulls"))
        return json([
          {
            number: 1,
            created_at: iso(5 * 86_400_000),
            updated_at: iso(5 * 86_400_000),
            user: { login: "author" },
          },
          {
            number: 2,
            created_at: iso(3_600_000),
            updated_at: iso(3_600_000),
            user: { login: "author" },
          },
        ]);
      return json([]);
    }),
  );
  const lastSync = now - 86_400_000;
  const stored: string[] = [];
  const synced: number[] = [];
  const result = await app.backfill(
    7,
    [
      { id: 1, name: "our-team/fresh", private: false },
      { id: 2, name: "our-team/known", private: false },
      { id: 3, name: "our-team/broken", private: false },
    ],
    async (events) => {
      stored.push(...events.map((event) => event.id));
    },
    {
      since: new Map([[2, lastSync]]),
      onSynced: async (repositoryId) => {
        synced.push(repositoryId);
      },
    },
  );
  // A new repository reads the whole window; a known one only what changed
  // since its last import, with a short overlap.
  assert.deepEqual(reviewed.sort(), ["fresh#1", "fresh#2", "known#2"]);
  assert.equal(issuesSince.get("known"), lastSync - 15 * 60_000);
  assert.ok(issuesSince.get("fresh")! <= now - 29 * 86_400_000);
  assert.ok(stored.some((id) => id.startsWith("our-team/fresh:pr:1:")));
  assert.ok(stored.some((id) => id.startsWith("our-team/known:pr:2:")));
  assert.ok(!stored.some((id) => id.startsWith("our-team/known:pr:1:")));
  // A failed repository keeps its previous watermark.
  assert.deepEqual(synced.sort(), [1, 2]);
  assert.deepEqual([result.scanned, result.resumed, result.failed], [2, 1, 1]);
});

test("backfill watermarks use the caller's start time", async () => {
  const app = new GitHubApp(
    config,
    mockApi((url) => {
      if (url.pathname === "/app/installations/7") return json(installation());
      if (url.pathname.endsWith("/access_tokens")) return installationToken();
      return json([]);
    }),
  );
  const startedAt = Date.parse("2026-09-10T08:00:00Z");
  const synced: number[] = [];
  await app.backfill(
    7,
    [{ id: 1, name: "our-team/repo", private: false }],
    async () => {},
    {
      startedAt,
      onSynced: async (_repositoryId, syncedAt) => {
        synced.push(syncedAt);
      },
    },
  );
  assert.deepEqual(synced, [startedAt]);
});

test("backfill reads four repositories at a time and a whole sync gets one summary", async () => {
  let active = 0;
  let peak = 0;
  const app = new GitHubApp(
    config,
    mockApi(async (url) => {
      if (url.pathname === "/app/installations/7") return json(installation());
      if (url.pathname.endsWith("/access_tokens")) return installationToken();
      if (url.pathname.endsWith("/pulls")) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      }
      return json([]);
    }),
  );
  const repos = Array.from({ length: 8 }, (_, index) => ({
    id: index + 1,
    name: `our-team/repo${index}`,
    private: false,
  }));
  const result = await app.backfill(7, repos, async () => {});
  assert.equal(peak, 4);
  assert.deepEqual(result, {
    synced: 0,
    scanned: 8,
    resumed: 0,
    failed: 0,
    skipped: 0,
  });
  assert.equal(
    backfillNotice({
      synced: 5,
      scanned: 169,
      resumed: 169,
      failed: 0,
      skipped: 0,
    }),
    "Synced 169 repositories (169 resumed from their last sync) and found 5 recent records. History covers the last 30 days; pushes arrive through webhooks.",
  );
  assert.match(
    backfillNotice({
      synced: 1,
      scanned: 1,
      resumed: 0,
      failed: 2,
      skipped: 0,
    }),
    /^Synced 1 repository and found 1 recent record\. 2 repositories could not be imported/,
  );
  assert.equal(
    backfillNotice({
      synced: 0,
      scanned: 0,
      resumed: 0,
      failed: 0,
      skipped: 0,
    }),
    "No repositories are currently visible to your GitHub account.",
  );
});
