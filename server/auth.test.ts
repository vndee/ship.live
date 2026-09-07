import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import express, { type ErrorRequestHandler } from "express";
import { Pool } from "pg";
import type { SessionResponse } from "../shared/auth.js";
import {
  AuthError,
  AuthService,
  authConfigFromEnv,
  type Principal,
} from "./auth.js";
import { createTestDatabase } from "./test-database.js";

const origin = "https://ship.example.test";
const supabaseUrl = "https://auth.example.test";
const uid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const anotherUid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

class CookieJar {
  values = new Map<string, string>();
  apply(response: Response) {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (!value || /Max-Age=0(?:;|$)/i.test(cookie)) this.values.delete(name);
      else this.values.set(name, value);
    }
  }
  header() {
    return [...this.values]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
  copy() {
    const copy = new CookieJar();
    copy.values = new Map(this.values);
    return copy;
  }
}

function upstream() {
  const codes = new Map<string, { challenge: string; userId: string }>();
  const revoked = new Set<string>();
  const calls: string[] = [];
  let expireTokens = false;
  let unavailable = false;
  let beforeUser: (() => Promise<void>) | undefined;
  function user(userId: string) {
    return {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: "builder@example.test",
      email_confirmed_at: new Date().toISOString(),
      app_metadata: { provider: "google", providers: ["google"] },
      user_metadata: {
        full_name: "Builder",
        avatar_url: "javascript:alert(1)",
      },
      identities: [],
      created_at: new Date().toISOString(),
    };
  }
  function session(userId: string) {
    const expires = Math.floor(Date.now() / 1000) + (expireTokens ? -10 : 3600);
    const payload = { sub: userId, exp: expires, session_id: randomUUID() };
    return {
      access_token: `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.test-signature`,
      refresh_token: `refresh-${userId}`,
      token_type: "bearer",
      expires_in: expireTokens ? -10 : 3600,
      expires_at: expires,
      user: user(userId),
      provider_token: "must-not-be-in-public-response",
    };
  }
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    calls.push(url.pathname + url.search);
    if (unavailable)
      return Response.json({ msg: "provider unavailable" }, { status: 503 });
    if (url.pathname === "/auth/v1/token") {
      const body = JSON.parse(String(init?.body));
      if (url.searchParams.get("grant_type") === "pkce") {
        const grant = codes.get(body.auth_code);
        codes.delete(body.auth_code);
        if (
          !grant ||
          createHash("sha256")
            .update(body.code_verifier ?? "")
            .digest("base64url") !== grant.challenge
        )
          return Response.json(
            { msg: "PKCE rejected", error_code: "bad_code_verifier" },
            { status: 400 },
          );
        return Response.json(session(grant.userId));
      }
      if (url.searchParams.get("grant_type") === "refresh_token") {
        const userId = String(body.refresh_token).replace(/^refresh-/, "");
        if (revoked.has(userId))
          return Response.json({ msg: "Session revoked" }, { status: 401 });
        expireTokens = false;
        return Response.json(session(userId));
      }
    }
    if (url.pathname === "/auth/v1/user") {
      await beforeUser?.();
      const token = new Headers(init?.headers)
        .get("authorization")
        ?.replace(/^Bearer /, "");
      const payload = JSON.parse(
        Buffer.from(token?.split(".")[1] ?? "", "base64url").toString(),
      );
      if (revoked.has(payload.sub) || payload.exp <= Date.now() / 1000)
        return Response.json(
          { msg: "Session revoked", error_code: "bad_jwt" },
          { status: 401 },
        );
      return Response.json(user(payload.sub));
    }
    if (url.pathname === "/auth/v1/logout")
      return new Response(null, { status: 204 });
    throw new Error(`Unexpected Supabase request ${url.pathname}`);
  };
  return {
    fetcher,
    codes,
    calls,
    revoked,
    expire() {
      expireTokens = true;
    },
    unavailable() {
      unavailable = true;
    },
    beforeUser(callback: () => Promise<void>) {
      beforeUser = callback;
    },
  };
}

async function withAuth(
  t: TestContext,
  run: (context: {
    auth: AuthService;
    replica: AuthService;
    pool: Pool;
    provider: ReturnType<typeof upstream>;
    request: (
      path: string,
      jar?: CookieJar,
      init?: RequestInit,
    ) => Promise<Response>;
    login: (
      jar?: CookieJar,
      userId?: string,
      provider?: "google" | "github",
    ) => Promise<CookieJar>;
    principal: () => Principal | undefined;
  }) => Promise<void>,
) {
  const database = await createTestDatabase(t);
  if (!database) return;
  const pool = new Pool({ connectionString: database });
  let server: ReturnType<express.Express["listen"]> | undefined;
  try {
    await pool.query(
      await readFile(
        new URL("./migrations/002_auth.sql", import.meta.url),
        "utf8",
      ),
    );
    const provider = upstream();
    const config = {
      appUrl: origin,
      supabaseUrl,
      supabasePublishableKey: "sb_publishable_fixture",
      fetcher: provider.fetcher,
    };
    const auth = new AuthService(config, pool);
    const replica = new AuthService(config, pool);
    const app = express();
    let lastPrincipal: Principal | undefined;
    app.use(auth.router);
    app.get("/protected", async (req, res) => {
      lastPrincipal = await replica.authenticate(req, res);
      res.json({ id: lastPrincipal.user.id });
    });
    app.post("/mutation", async (req, res) => {
      const principal = await auth.requireMutation(req, res);
      res.json({ id: principal.user.id });
    });
    const errors: ErrorRequestHandler = (error, _req, res, _next) => {
      res
        .status(error instanceof AuthError ? error.status : 500)
        .json({ error: error.message });
    };
    app.use(errors);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = async (
      path: string,
      jar = new CookieJar(),
      init: RequestInit = {},
    ) => {
      const headers = new Headers(init.headers);
      headers.set("Cookie", jar.header());
      const response = await fetch(base + path, {
        ...init,
        headers,
        redirect: "manual",
      });
      jar.apply(response);
      return response;
    };
    const login = async (
      jar = new CookieJar(),
      userId = uid,
      selected: "google" | "github" = "google",
    ) => {
      const start = await request(`/api/auth/${selected}/start`, jar);
      assert.equal(start.status, 302);
      const authorization = new URL(start.headers.get("location")!);
      assert.equal(authorization.origin, supabaseUrl);
      assert.equal(authorization.searchParams.get("provider"), selected);
      assert.equal(
        authorization.searchParams.get("code_challenge_method"),
        "s256",
      );
      const callback = new URL(authorization.searchParams.get("redirect_to")!);
      assert.equal(callback.origin, origin);
      const code = randomUUID();
      provider.codes.set(code, {
        challenge: authorization.searchParams.get("code_challenge")!,
        userId,
      });
      const result = await request(
        callback.pathname + callback.search + `&code=${code}`,
        jar,
      );
      assert.equal(result.status, 302, await result.text());
      assert.equal(result.headers.get("location"), origin + "/");
      return jar;
    };
    await run({
      auth,
      replica,
      pool,
      provider,
      request,
      login,
      principal: () => lastPrincipal,
    });
  } finally {
    server?.closeAllConnections();
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    await pool.end();
  }
}

test("auth configuration requires complete credentials and one trusted HTTPS origin", () => {
  assert.equal(authConfigFromEnv({}).supabaseUrl, undefined);
  for (const env of [
    { SUPABASE_URL: supabaseUrl },
    { SUPABASE_URL: supabaseUrl, SUPABASE_PUBLISHABLE_KEY: "key" },
    {
      APP_URL: "https://good.test/path",
      SUPABASE_URL: supabaseUrl,
      SUPABASE_PUBLISHABLE_KEY: "key",
    },
    {
      APP_URL: "http://public.example",
      SUPABASE_URL: supabaseUrl,
      SUPABASE_PUBLISHABLE_KEY: "key",
    },
    {
      APP_URL: origin,
      SUPABASE_URL: "http://auth.public.example",
      SUPABASE_PUBLISHABLE_KEY: "key",
    },
    {
      APP_URL: origin,
      SUPABASE_URL: supabaseUrl,
      SUPABASE_PUBLISHABLE_KEY: "sb_secret_never_use_for_login",
    },
    {
      APP_URL: origin,
      SUPABASE_URL: supabaseUrl,
      SUPABASE_PUBLISHABLE_KEY: `header.${Buffer.from('{"role":"service_role"}').toString("base64url")}.signature`,
    },
  ])
    assert.throws(() => authConfigFromEnv(env));
  assert.equal(
    authConfigFromEnv({
      APP_URL: origin,
      SUPABASE_URL: supabaseUrl,
      SUPABASE_ANON_KEY: "legacy-key",
    }).supabasePublishableKey,
    "legacy-key",
  );
});

test("Google and GitHub PKCE login exposes a sanitized session with secure cookies", async (t) => {
  await withAuth(t, async ({ login, request, pool }) => {
    assert.equal((await request("/protected")).status, 401);
    for (const provider of ["google", "github"] as const) {
      const jar = await login(undefined, uid, provider);
      for (const [name, value] of jar.values) {
        if (
          name.includes("ship-live-supabase") &&
          !name.includes("code-verifier")
        ) {
          const stored = Buffer.from(
            decodeURIComponent(value).replace(/^base64-/, ""),
            "base64url",
          ).toString();
          assert.doesNotMatch(
            stored,
            /provider_token|provider_refresh_token|must-not-be-in-public-response/,
          );
        }
      }
      const response = await request("/api/session", jar);
      const body: SessionResponse = await response.json();
      assert.equal(body.user?.id, uid);
      assert.equal(body.user?.name, "Builder");
      assert.equal(body.user?.avatarUrl, undefined);
      assert.ok(body.csrfToken);
      assert.deepEqual(body.providers, { google: true, github: true });
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.doesNotMatch(
        JSON.stringify(body),
        /access_token|refresh_token|provider_token|email/,
      );
      assert.equal((await request("/protected", jar)).status, 200);
      const rows = await pool.query(
        "SELECT token_hash FROM ship_live_auth_sessions",
      );
      for (const row of rows.rows) {
        assert.match(row.token_hash, /^[0-9a-f]{64}$/);
        assert.ok(!jar.header().includes(row.token_hash));
      }
    }
  });
});

test("OAuth callback rejects browser swaps, missing PKCE, expired flow, and replay", async (t) => {
  await withAuth(t, async ({ request, provider, pool }) => {
    const jar = new CookieJar();
    const response = await request("/api/auth/google/start", jar);
    assert.equal(response.status, 302);
    for (const cookie of response.headers.getSetCookie()) {
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /Secure/);
      assert.match(cookie, /SameSite=Lax/i);
      assert.match(cookie, /Path=\//);
      assert.doesNotMatch(cookie, /Domain=/i);
    }
    const auth = new URL(response.headers.get("location")!);
    const callback = new URL(auth.searchParams.get("redirect_to")!);
    provider.codes.set("test-code", {
      challenge: auth.searchParams.get("code_challenge")!,
      userId: uid,
    });
    const path = callback.pathname + callback.search + "&code=test-code";
    assert.equal((await request(path)).status, 400);
    assert.equal(provider.calls.length, 0);
    const original = jar.copy();
    const success = await request(path, jar);
    assert.equal(success.status, 302, await success.text());
    assert.equal((await request(path, original)).status, 400);

    const missing = new CookieJar();
    const missingStart = await request("/api/auth/google/start", missing);
    const missingAuth = new URL(missingStart.headers.get("location")!);
    const missingCallback = new URL(
      missingAuth.searchParams.get("redirect_to")!,
    );
    provider.codes.set("missing-pkce", {
      challenge: missingAuth.searchParams.get("code_challenge")!,
      userId: uid,
    });
    for (const name of missing.values.keys())
      if (name.includes("code-verifier")) missing.values.delete(name);
    assert.equal(
      (
        await request(
          missingCallback.pathname +
            missingCallback.search +
            "&code=missing-pkce",
          missing,
        )
      ).status,
      400,
    );

    const expired = new CookieJar();
    const expiredStart = await request("/api/auth/github/start", expired);
    const expiredAuth = new URL(expiredStart.headers.get("location")!);
    const expiredCallback = new URL(
      expiredAuth.searchParams.get("redirect_to")!,
    );
    await pool.query(
      "UPDATE ship_live_auth_flows SET expires_at = now() - interval '1 minute'",
    );
    assert.equal(
      (
        await request(
          expiredCallback.pathname + expiredCallback.search + "&code=expired",
          expired,
        )
      ).status,
      400,
    );
  });
});

test("mutations require both same Origin and session-bound CSRF; logout revokes replicas", async (t) => {
  await withAuth(
    t,
    async ({ login, request, replica, principal, provider }) => {
      const jar = await login();
      const session: SessionResponse = await (
        await request("/api/session", jar)
      ).json();
      const headers = { Origin: origin, "x-csrf-token": session.csrfToken! };
      assert.equal(
        (await request("/mutation", jar, { method: "POST" })).status,
        403,
      );
      assert.equal(
        (
          await request("/mutation", jar, {
            method: "POST",
            headers: {
              Origin: "https://evil.test",
              "x-csrf-token": session.csrfToken!,
            },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await request("/mutation", jar, {
            method: "POST",
            headers: { Origin: origin, "x-csrf-token": "wrong" },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await request("/mutation", jar, {
            method: "POST",
            headers: { Origin: origin, "x-csrf-token": "é".repeat(64) },
          })
        ).status,
        403,
      );
      assert.equal(
        (await request("/mutation", jar, { method: "POST", headers })).status,
        200,
      );
      await request("/protected", jar);
      const active = principal()!;
      await replica.assertActive(active);
      const stolen = jar.copy();
      const logout = await request("/api/logout", jar, {
        method: "POST",
        headers,
      });
      assert.equal(logout.status, 204);
      assert.equal((await request("/protected", stolen)).status, 401);
      await assert.rejects(
        replica.assertActive(active),
        (error: unknown) => error instanceof AuthError && error.status === 401,
      );
      assert.ok(
        provider.calls.some((call) => call === "/auth/v1/logout?scope=local"),
      );
    },
  );
});

test("an expired Supabase session refreshes via HttpOnly cookies before private requests", async (t) => {
  await withAuth(t, async ({ login, request, provider }) => {
    const jar = await login();
    const name = [...jar.values.keys()].find((value) =>
      value.endsWith("ship-live-supabase"),
    )!;
    assert.ok(name, "Expected one compact tokens-only Supabase cookie");
    const encoded = decodeURIComponent(jar.values.get(name)!);
    const saved = JSON.parse(
      Buffer.from(encoded.replace(/^base64-/, ""), "base64url").toString(),
    );
    saved.expires_at = Math.floor(Date.now() / 1000) - 10;
    const parts = saved.access_token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    payload.exp = saved.expires_at;
    parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
    saved.access_token = parts.join(".");
    jar.values.set(
      name,
      encodeURIComponent(
        "base64-" + Buffer.from(JSON.stringify(saved)).toString("base64url"),
      ),
    );
    const response = await request("/protected", jar);
    assert.equal(response.status, 200, await response.text());
    assert.ok(
      provider.calls.includes("/auth/v1/token?grant_type=refresh_token"),
    );
    assert.ok(
      response.headers
        .getSetCookie()
        .some((value) => /HttpOnly/.test(value) && /Secure/.test(value)),
    );
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const updated = decodeURIComponent(jar.values.get(name)!);
    assert.doesNotMatch(
      Buffer.from(updated.replace(/^base64-/, ""), "base64url").toString(),
      /provider_token|provider_refresh_token/,
    );
  });
});

test("Supabase outages fail closed while local logout still revokes access", async (t) => {
  await withAuth(t, async ({ login, request, provider, pool }) => {
    const jar = await login();
    const session: SessionResponse = await (
      await request("/api/session", jar)
    ).json();
    provider.unavailable();
    assert.equal((await request("/protected", jar)).status, 503);
    const logout = await request("/api/logout", jar, {
      method: "POST",
      headers: { Origin: origin, "x-csrf-token": session.csrfToken! },
    });
    assert.equal(logout.status, 204);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM ship_live_auth_sessions",
        )
      ).rows[0].count,
      0,
    );
    assert.equal((await request("/protected", jar)).status, 401);
  });
});

test("app-session and Supabase identity must agree, upstream revocation closes access", async (t) => {
  await withAuth(
    t,
    async ({ login, request, replica, principal, provider }) => {
      const first = await login();
      const second = await login(undefined, anotherUid);
      const appCookie = [...first.values.keys()].find((name) =>
        name.endsWith("ship-live-session"),
      )!;
      const mixed = second.copy();
      mixed.values.set(appCookie, first.values.get(appCookie)!);
      assert.equal((await request("/protected", mixed)).status, 401);
      await request("/protected", first);
      const active = principal()!;
      provider.revoked.add(uid);
      assert.equal((await request("/protected", first)).status, 401);
      await assert.rejects(replica.assertActive(active));
      assert.equal((await request("/protected", second)).status, 200);
    },
  );
});

test("logout during an in-flight Supabase lookup prevents the private response", async (t) => {
  await withAuth(t, async ({ login, request, provider, pool }) => {
    const jar = await login();
    let entered!: () => void;
    let release!: () => void;
    const called = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.beforeUser(async () => {
      entered();
      await pending;
    });
    const reading = request("/protected", jar);
    await called;
    await pool.query("DELETE FROM ship_live_auth_sessions");
    release();
    assert.equal((await reading).status, 401);
  });
});

test("two concurrent OAuth callbacks consume one flow and create one app session", async (t) => {
  await withAuth(t, async ({ request, provider, pool }) => {
    const jar = new CookieJar();
    const start = await request("/api/auth/google/start", jar);
    const auth = new URL(start.headers.get("location")!);
    const callback = new URL(auth.searchParams.get("redirect_to")!);
    provider.codes.set("concurrent-code", {
      challenge: auth.searchParams.get("code_challenge")!,
      userId: uid,
    });
    const path = callback.pathname + callback.search + "&code=concurrent-code";
    const results = await Promise.all([
      request(path, jar.copy()),
      request(path, jar.copy()),
    ]);
    assert.deepEqual(
      results.map((response) => response.status).sort(),
      [302, 400],
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM ship_live_auth_sessions",
        )
      ).rows[0].count,
      1,
    );
  });
});
