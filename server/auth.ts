import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import {
  createClient,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";
import { Router, type Request, type Response } from "express";
import type { Pool } from "pg";
import type {
  AuthUser,
  LoginProvider,
  SessionResponse,
} from "../shared/auth.js";

export interface AuthConfig {
  appUrl: string;
  supabaseUrl?: string;
  supabasePublishableKey?: string;
  providers?: Record<LoginProvider, boolean>;
  fetcher?: typeof fetch;
}

export interface Principal {
  user: AuthUser;
  sessionId: string;
  csrfToken: string;
}

const SESSION_LIFETIME = 7 * 24 * 60 * 60;
const FLOW_LIFETIME = 10 * 60;
const opaque = () => randomBytes(32).toString("base64url");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const validOpaque = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requestCookies(request: Request): Map<string, string> {
  const header = request.get("cookie") || "";
  if (header.length > 16_384)
    throw new AuthError(400, "Invalid session cookies.");
  const cookies = new Map<string, string>();
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (cookies.has(name))
      throw new AuthError(400, "Ambiguous session cookies.");
    try {
      cookies.set(name, decodeURIComponent(part.slice(index + 1).trim()));
    } catch {
      throw new AuthError(400, "Invalid session cookies.");
    }
  }
  return cookies;
}

function publicUser(user: User): AuthUser {
  const rawName =
    user.user_metadata?.full_name ||
    user.user_metadata?.name ||
    user.user_metadata?.user_name;
  const name =
    typeof rawName === "string"
      ? rawName
          .replace(/[\u0000-\u001f\u007f]/g, "")
          .trim()
          .slice(0, 120)
      : "";
  let avatarUrl: string | undefined;
  const rawAvatar =
    user.user_metadata?.avatar_url || user.user_metadata?.picture;
  if (typeof rawAvatar === "string" && rawAvatar.length < 2048) {
    try {
      const url = new URL(rawAvatar);
      if (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        (url.hostname === "avatars.githubusercontent.com" ||
          /^lh\d+\.googleusercontent\.com$/.test(url.hostname))
      )
        avatarUrl = url.href;
    } catch {
      /* A profile picture is optional. */
    }
  }
  return {
    id: user.id,
    name: name || "Builder",
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}

export class AuthError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function trustedOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid origin.`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      `${label} must be an HTTPS origin without a path. HTTP is allowed only on loopback.`,
    );
  return url.origin;
}

function requirePublicKey(key: string | undefined) {
  if (!key) return;
  let serviceRole = key.startsWith("sb_secret_");
  try {
    serviceRole ||=
      JSON.parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString())
        .role === "service_role";
  } catch {
    /* Non-JWT publishable keys are supported. */
  }
  if (serviceRole)
    throw new Error(
      "Use a Supabase publishable or anon key for sign-in, never a secret or service-role key.",
    );
}

export function authConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AuthConfig {
  const supabaseUrl = env.SUPABASE_URL;
  const supabasePublishableKey =
    env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
  requirePublicKey(supabasePublishableKey);
  if (Boolean(supabaseUrl) !== Boolean(supabasePublishableKey))
    throw new Error(
      "Set both SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY to enable sign-in.",
    );
  if (supabaseUrl && !env.APP_URL)
    throw new Error("APP_URL is required when sign-in is configured.");
  const appUrl = trustedOrigin(
    env.APP_URL || "http://127.0.0.1:5173",
    "APP_URL",
  );
  const enabled = (value: string | undefined) => {
    if (value === undefined) return true;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error("SUPABASE provider flags must be true or false.");
  };
  return {
    appUrl,
    supabaseUrl: supabaseUrl
      ? trustedOrigin(supabaseUrl, "SUPABASE_URL")
      : undefined,
    supabasePublishableKey,
    providers: {
      google: enabled(env.SUPABASE_GOOGLE_ENABLED),
      github: enabled(env.SUPABASE_GITHUB_ENABLED),
    },
  };
}

export class AuthService {
  readonly router = Router();
  readonly configured: boolean;
  private readonly sessionCookie: string;
  private readonly flowCookie: string;
  private readonly supabaseCookie: string;
  private readonly secure: boolean;
  private readonly contexts = new WeakMap<
    Request,
    { client: SupabaseClient; flush: () => void }
  >();
  private readonly credentials = new WeakMap<
    Principal,
    { accessToken: string; expiresAt: number }
  >();

  constructor(
    readonly config: AuthConfig,
    private readonly pool: Pool,
  ) {
    requirePublicKey(config.supabasePublishableKey);
    config.appUrl = trustedOrigin(config.appUrl, "APP_URL");
    if (Boolean(config.supabaseUrl) !== Boolean(config.supabasePublishableKey))
      throw new Error(
        "Supabase authentication requires a project URL and publishable key.",
      );
    if (config.supabaseUrl)
      config.supabaseUrl = trustedOrigin(config.supabaseUrl, "SUPABASE_URL");
    this.configured = Boolean(
      config.supabaseUrl && config.supabasePublishableKey,
    );
    this.secure = config.appUrl.startsWith("https:");
    const prefix = this.secure ? "__Host-" : "";
    this.sessionCookie = `${prefix}ship-live-session`;
    this.flowCookie = `${prefix}ship-live-auth-flow`;
    this.supabaseCookie = `${prefix}ship-live-supabase`;

    this.router.use((request, response, next) => {
      if (
        request.path === "/api/session" ||
        request.path.startsWith("/api/auth/") ||
        request.path === "/api/logout"
      ) {
        response.set("Cache-Control", "private, no-store");
        response.set("Referrer-Policy", "no-referrer");
        response.set("X-Content-Type-Options", "nosniff");
      }
      next();
    });
    this.router.get("/api/session", async (request, response) => {
      const result: SessionResponse = {
        user: null,
        configured: this.configured,
        providers: this.providers(),
      };
      if (this.configured) {
        try {
          const principal = await this.authenticate(request, response);
          result.user = principal.user;
          result.csrfToken = principal.csrfToken;
        } catch (error) {
          if (!(error instanceof AuthError) || error.status !== 401)
            throw error;
        }
      }
      response.json(result);
    });
    this.router.get("/api/auth/:provider/start", async (request, response) => {
      this.requireConfigured();
      const provider = request.params.provider;
      if (
        (provider !== "google" && provider !== "github") ||
        !this.providers()[provider]
      )
        throw new AuthError(404, "This sign-in provider is not enabled.");
      const flow = opaque();
      const browser = opaque();
      await this.pool.query(
        "DELETE FROM ship_live_auth_flows WHERE expires_at <= now()",
      );
      await this.pool.query(
        "DELETE FROM ship_live_auth_sessions WHERE expires_at <= now()",
      );
      await this.pool.query(
        "INSERT INTO ship_live_auth_flows (token_hash, browser_hash, expires_at) VALUES ($1, $2, now() + interval '10 minutes')",
        [hash(flow), hash(browser)],
      );
      const callback = new URL("/api/auth/callback", config.appUrl);
      callback.searchParams.set("flow", flow);
      const context = this.context(request, response);
      const { data, error } = await context.client.auth.signInWithOAuth({
        provider,
        options: { redirectTo: callback.href, skipBrowserRedirect: true },
      });
      if (error || !data.url)
        throw new AuthError(503, "Sign-in is temporarily unavailable.");
      const destination = new URL(data.url);
      if (
        destination.origin !== config.supabaseUrl ||
        destination.pathname !== "/auth/v1/authorize"
      )
        throw new AuthError(503, "Sign-in is temporarily unavailable.");
      context.flush();
      this.setCookie(response, this.flowCookie, browser, FLOW_LIFETIME);
      response.redirect(302, destination.href);
    });
    this.router.get("/api/auth/callback", async (request, response) => {
      this.requireConfigured();
      const { flow, code } = request.query;
      const browser = requestCookies(request).get(this.flowCookie);
      if (
        !validOpaque(flow) ||
        !validOpaque(browser) ||
        typeof code !== "string" ||
        !code ||
        code.length > 2048
      )
        throw new AuthError(
          400,
          "Sign-in could not be verified. Please start again.",
        );
      const consumed = await this.pool.query(
        "DELETE FROM ship_live_auth_flows WHERE token_hash = $1 AND browser_hash = $2 AND expires_at > now() RETURNING token_hash",
        [hash(flow), hash(browser)],
      );
      if (!consumed.rowCount)
        throw new AuthError(
          400,
          "Sign-in could not be verified. Please start again.",
        );
      this.setCookie(response, this.flowCookie, "", 0);
      const context = this.context(request, response);
      const { data, error } =
        await context.client.auth.exchangeCodeForSession(code);
      if (error || !data.session)
        throw new AuthError(
          400,
          "Sign-in could not be verified. Please start again.",
        );
      // Rebuild the stored session from Supabase tokens only. OAuth provider
      // tokens are unnecessary for login and must not persist in our cookies.
      const verified = await context.client.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });
      if (
        verified.error ||
        !verified.data.user ||
        verified.data.user.is_anonymous ||
        !uuid.test(verified.data.user.id)
      )
        throw new AuthError(
          400,
          "Sign-in could not be verified. Please start again.",
        );
      const user = publicUser(verified.data.user);
      const cookie = opaque();
      const previous = requestCookies(request).get(this.sessionCookie);
      const connection = await this.pool.connect();
      try {
        await connection.query("BEGIN");
        await connection.query(
          `INSERT INTO ship_live_auth_users (id, name, avatar_url) VALUES ($1, $2, $3)
          ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url, updated_at = now()`,
          [user.id, user.name, user.avatarUrl ?? null],
        );
        if (validOpaque(previous))
          await connection.query(
            "DELETE FROM ship_live_auth_sessions WHERE token_hash = $1",
            [hash(previous)],
          );
        await connection.query(
          "INSERT INTO ship_live_auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '7 days')",
          [hash(cookie), user.id],
        );
        await connection.query("COMMIT");
      } catch (error) {
        await connection.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
      context.flush();
      this.setCookie(response, this.sessionCookie, cookie, SESSION_LIFETIME);
      response.redirect(302, config.appUrl + "/");
    });
    this.router.post("/api/logout", async (request, response) => {
      this.requireConfigured();
      // Local logout must succeed even if Supabase cannot be reached. The
      // opaque session and CSRF proof authorize only its own revocation.
      const local = await this.localSession(request);
      this.checkMutation(request, local.csrfToken);
      await this.pool.query(
        "DELETE FROM ship_live_auth_sessions WHERE token_hash = $1",
        [local.sessionId],
      );
      const context = this.context(request, response, 2000);
      await context.client.auth
        .signOut({ scope: "local" })
        .catch(() => undefined);
      this.clearCookies(request, response);
      response.status(204).end();
    });
  }

  private providers(): Record<LoginProvider, boolean> {
    return {
      google: this.configured && (this.config.providers?.google ?? true),
      github: this.configured && (this.config.providers?.github ?? true),
    };
  }

  private requireConfigured() {
    if (!this.configured)
      throw new AuthError(503, "Sign-in is not configured on this server.");
  }

  private setCookie(
    response: Response,
    name: string,
    value: string,
    maxAge: number,
  ) {
    response.cookie(name, value, {
      httpOnly: true,
      secure: this.secure,
      sameSite: "lax",
      path: "/",
      maxAge: maxAge * 1000,
    });
  }

  private clearCookies(request: Request, response: Response) {
    const names = new Set([
      this.sessionCookie,
      this.flowCookie,
      this.supabaseCookie,
    ]);
    for (const name of requestCookies(request).keys())
      if (
        name.startsWith(this.supabaseCookie + ".") ||
        name.startsWith(this.supabaseCookie + "-")
      )
        names.add(name);
    for (const name of names) this.setCookie(response, name, "", 0);
  }

  private fetcher(timeoutMs = 10_000): typeof fetch {
    const upstream = this.config.fetcher ?? fetch;
    return async (input, init) => {
      const destination = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (destination.origin !== this.config.supabaseUrl)
        throw new AuthError(503, "Authentication is temporarily unavailable.");
      const deadline = AbortSignal.timeout(timeoutMs);
      return upstream(input, {
        ...init,
        redirect: "error",
        signal: init?.signal
          ? AbortSignal.any([init.signal, deadline])
          : deadline,
      });
    };
  }

  private context(request: Request, response: Response, timeoutMs = 10_000) {
    const existing = this.contexts.get(request);
    if (existing) return existing;
    this.requireConfigured();
    const cookies = requestCookies(request);
    const pending = new Map<
      string,
      { value: string; options: CookieOptions }
    >();
    const client = createServerClient(
      this.config.supabaseUrl!,
      this.config.supabasePublishableKey!,
      {
        global: { fetch: this.fetcher(timeoutMs) },
        cookieOptions: {
          name: this.supabaseCookie,
          httpOnly: true,
          secure: this.secure,
          sameSite: "lax",
          path: "/",
        },
        cookies: {
          encode: "tokens-only",
          getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
          setAll: (updates) => {
            for (const { name, value, options } of updates) {
              if (!value || options.maxAge === 0) cookies.delete(name);
              else cookies.set(name, value);
              pending.set(name, { value, options });
            }
          },
        },
      },
    );
    const context = {
      client,
      flush: () => {
        if (pending.size && response.headersSent)
          throw new AuthError(401, "Reconnect to refresh your session.");
        if (pending.size) {
          response.set("Cache-Control", "private, no-store");
          response.set("Expires", "0");
          response.set("Pragma", "no-cache");
        }
        for (const [name, { value, options }] of pending)
          this.setCookie(
            response,
            name,
            value,
            !value || options.maxAge === 0
              ? 0
              : name.includes("code-verifier")
                ? FLOW_LIFETIME
                : SESSION_LIFETIME,
          );
        pending.clear();
      },
    };
    this.contexts.set(request, context);
    return context;
  }

  private async localSession(request: Request) {
    const cookie = requestCookies(request).get(this.sessionCookie);
    if (!validOpaque(cookie)) throw new AuthError(401, "Sign in to continue.");
    const sessionId = hash(cookie);
    const rows = await this.pool.query<{ user_id: string }>(
      "SELECT user_id FROM ship_live_auth_sessions WHERE token_hash = $1 AND expires_at > now()",
      [sessionId],
    );
    if (!rows.rows[0]) throw new AuthError(401, "Sign in to continue.");
    return {
      sessionId,
      userId: rows.rows[0].user_id,
      csrfToken: hash(`ship.live.csrf:${cookie}`),
    };
  }

  private async checkSession(sessionId: string, userId: string) {
    const result = await this.pool.query(
      "SELECT 1 FROM ship_live_auth_sessions WHERE token_hash = $1 AND user_id = $2 AND expires_at > now()",
      [sessionId, userId],
    );
    if (!result.rowCount) throw new AuthError(401, "Sign in to continue.");
  }

  async authenticate(request: Request, response: Response): Promise<Principal> {
    this.requireConfigured();
    const local = await this.localSession(request);
    const context = this.context(request, response);
    const { data, error } = await context.client.auth.getUser();
    if (
      error ||
      !data.user ||
      data.user.is_anonymous ||
      data.user.id !== local.userId
    )
      throw new AuthError(
        error && (!error.status || error.status >= 500) ? 503 : 401,
        "Sign in again to continue.",
      );
    // getSession supplies credentials only after getUser verified the identity.
    const session = await context.client.auth.getSession();
    if (session.error || !session.data.session)
      throw new AuthError(401, "Sign in to continue.");
    let activeSession = session.data.session;
    if (activeSession.provider_token || activeSession.provider_refresh_token) {
      const sanitized = await context.client.auth.setSession({
        access_token: activeSession.access_token,
        refresh_token: activeSession.refresh_token,
      });
      if (
        sanitized.error ||
        !sanitized.data.session ||
        sanitized.data.user?.id !== local.userId
      )
        throw new AuthError(401, "Sign in again to continue.");
      activeSession = sanitized.data.session;
    }
    await this.checkSession(local.sessionId, local.userId);
    const principal: Principal = {
      user: publicUser(data.user),
      sessionId: local.sessionId,
      csrfToken: local.csrfToken,
    };
    this.credentials.set(principal, {
      accessToken: activeSession.access_token,
      expiresAt: activeSession.expires_at ?? 0,
    });
    context.flush();
    return principal;
  }

  private checkMutation(request: Request, csrfToken: string) {
    const supplied = request.get("x-csrf-token") ?? "";
    if (
      request.get("origin") !== this.config.appUrl ||
      !/^[0-9a-f]{64}$/.test(supplied) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(csrfToken))
    )
      throw new AuthError(
        403,
        "This action could not be verified. Refresh the page and try again.",
      );
  }

  async requireMutation(
    request: Request,
    response: Response,
  ): Promise<Principal> {
    const principal = await this.authenticate(request, response);
    this.checkMutation(request, principal.csrfToken);
    return principal;
  }

  async assertActive(principal: Principal): Promise<void> {
    await this.checkSession(principal.sessionId, principal.user.id);
    const credentials = this.credentials.get(principal);
    if (!credentials || credentials.expiresAt <= Date.now() / 1000)
      throw new AuthError(401, "Reconnect to refresh your session.");
    // A stream cannot refresh response cookies after sending headers. Verify
    // its original token; expiry closes it so the next request can refresh.
    const verifier = createClient(
      this.config.supabaseUrl!,
      this.config.supabasePublishableKey!,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: { fetch: this.fetcher() },
      },
    );
    const { data, error } = await verifier.auth.getUser(
      credentials.accessToken,
    );
    if (error || data.user?.id !== principal.user.id)
      throw new AuthError(401, "Sign in again to continue.");
    await this.checkSession(principal.sessionId, principal.user.id);
  }
}
