import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import type { ActivityEvent } from "../shared/types.js";
import { FeedError, rateLimitRetryAfter } from "./github.js";
import { normalizeWebhook, object, validOrganization } from "./normalize.js";

export interface GitHubAppConfig {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  slug: string;
  appUrl: string;
}
export interface GitHubGrant {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  refreshExpiresAt?: number;
}
export interface InstallationInfo {
  id: number;
  accountId: number;
  account: string;
  kind: "User" | "Organization";
  suspended: boolean;
}
export interface Repo {
  id: number;
  name: string;
  private: boolean;
}

const API = "https://api.github.com";
const OAUTH = "https://github.com/login/oauth/access_token";
const READ_PERMISSIONS = {
  metadata: "read",
  contents: "read",
  pull_requests: "read",
  issues: "read",
  actions: "read",
  checks: "read",
  statuses: "read",
  deployments: "read",
};
const DAY = 86_400_000;
// Resumed syncs re-read this much before the last import, for late GitHub writes.
const SYNC_OVERLAP = 15 * 60_000;
// Repositories read at once per sync: faster without extra requests, and well
// under GitHub's secondary limits on concurrent calls.
const BACKFILL_CONCURRENCY = 4;

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function credential(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 8_192 &&
    !/\s/.test(value)
  );
}
function malformed(): never {
  throw new FeedError(
    502,
    "GitHub returned an incomplete or unexpected response. Retry the connection.",
  );
}
function repository(value: unknown): Repo {
  const repo = object(value);
  const fullName = repo.full_name ?? repo.name;
  if (
    !positiveId(repo.id) ||
    typeof fullName !== "string" ||
    typeof repo.private !== "boolean"
  )
    malformed();
  const parts = fullName.split("/");
  if (
    parts.length !== 2 ||
    !validOrganization(parts[0]) ||
    !/^[a-z\d_.-]{1,100}$/i.test(parts[1]) ||
    [".", ".."].includes(parts[1])
  )
    malformed();
  return { id: repo.id, name: fullName, private: repo.private };
}

export interface BackfillResult {
  /** Activity records read in the sync window; storage deduplicates them. */
  synced: number;
  /** Repositories whose history was read and stored. */
  scanned: number;
  /** Scanned repositories that resumed from their previous sync. */
  resumed: number;
  failed: number;
  /** Repositories beyond the per-call limit. */
  skipped: number;
}

/** One summary for a whole sync, however many batches it took. */
export function backfillNotice(totals: BackfillResult): string {
  const repositories = (count: number) =>
    `${count} ${count === 1 ? "repository" : "repositories"}`;
  if (!totals.scanned && !totals.failed && !totals.skipped)
    return "No repositories are currently visible to your GitHub account.";
  return [
    `Synced ${repositories(totals.scanned)}${totals.resumed ? ` (${totals.resumed} resumed from their last sync)` : ""} and found ${totals.synced} recent ${totals.synced === 1 ? "record" : "records"}.`,
    totals.failed
      ? `${repositories(totals.failed)} could not be imported; check access and sync again.`
      : "",
    totals.skipped
      ? `${repositories(totals.skipped)} were not scanned; sync again to import them.`
      : "",
    "History covers the last 30 days; pushes arrive through webhooks.",
  ]
    .filter(Boolean)
    .join(" ");
}

export class GitHubApp {
  private readonly key: KeyObject;
  private readonly callback: string;

  constructor(
    private readonly config: GitHubAppConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (
      !/^\d+$/.test(config.appId) ||
      !positiveId(Number(config.appId)) ||
      !credential(config.clientId) ||
      !credential(config.clientSecret) ||
      !/^[a-z\d][a-z\d-]{0,99}$/i.test(config.slug)
    )
      throw new Error(
        "Complete the GitHub App ID, client credentials, and app slug configuration.",
      );
    const appUrl = new URL(config.appUrl);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(appUrl.hostname);
    if (
      (appUrl.protocol !== "https:" &&
        !(appUrl.protocol === "http:" && local)) ||
      appUrl.username ||
      appUrl.password ||
      appUrl.search ||
      appUrl.hash ||
      appUrl.pathname !== "/"
    )
      throw new Error(
        "APP_URL must be an HTTPS origin, or a local HTTP development origin.",
      );
    this.callback = new URL("/api/github/callback", appUrl).href;
    try {
      this.key = createPrivateKey(config.privateKey.replaceAll("\\n", "\n"));
      if (this.key.asymmetricKeyType !== "rsa") throw new Error();
    } catch {
      throw new Error(
        "GITHUB_APP_PRIVATE_KEY must contain the GitHub App's RSA private key.",
      );
    }
  }

  authorizationUrl(state: string, codeChallenge: string): string {
    if (!credential(state) || !/^[a-z\d_-]{43}$/i.test(codeChallenge))
      throw new FeedError(
        400,
        "A state value and S256 PKCE challenge are required.",
      );
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.callback,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return url.href;
  }

  installUrl(): string {
    return `https://github.com/apps/${this.config.slug}/installations/new`;
  }

  private async request(
    url: string,
    init: RequestInit,
  ): Promise<{ data: unknown; response: Response }> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new FeedError(
        502,
        "GitHub could not be reached. Please try again.",
      );
    }
    if (!response.ok) {
      const retryHeader = response.headers.get("retry-after");
      // Secondary limits can arrive as a 403 with Retry-After and quota remaining.
      if (
        response.status === 429 ||
        response.headers.get("x-ratelimit-remaining") === "0" ||
        (response.status === 403 && retryHeader !== null)
      ) {
        const retryAfter = rateLimitRetryAfter(response.headers, Date.now());
        const minutes = Math.ceil(retryAfter / 60);
        throw new FeedError(
          429,
          `GitHub rate limit reached. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
          retryAfter,
        );
      }
      if ([401, 403, 404].includes(response.status))
        throw new FeedError(
          response.status,
          "GitHub access is unavailable or was revoked. Reconnect the GitHub App and check repository access.",
        );
      throw new FeedError(
        502,
        "GitHub could not complete the request. Please try again.",
      );
    }
    try {
      return { data: await response.json(), response };
    } catch {
      malformed();
    }
  }

  private api(path: string, token: string, body?: unknown) {
    if (!credential(token))
      throw new FeedError(401, "A valid GitHub access token is required.");
    return this.request(new URL(path, API).href, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "ship.live",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  private async grant(
    parameters: Record<string, string>,
    refreshing = false,
  ): Promise<GitHubGrant> {
    const { data } = await this.request(OAUTH, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        ...parameters,
      }).toString(),
    });
    const grant = object(data);
    if (grant.error)
      throw new FeedError(
        401,
        "GitHub authorization expired or was rejected. Reconnect your GitHub account.",
      );
    if (
      !credential(grant.access_token) ||
      grant.token_type !== "bearer" ||
      !positiveId(grant.expires_in) ||
      grant.expires_in > 31_536_000
    )
      throw new FeedError(
        502,
        "GitHub did not return an expiring user token. Enable user token expiration in the GitHub App settings.",
      );
    const now = Date.now();
    const result: GitHubGrant = {
      accessToken: grant.access_token,
      expiresAt: now + grant.expires_in * 1000,
    };
    if (grant.refresh_token !== undefined || refreshing) {
      if (
        !credential(grant.refresh_token) ||
        !positiveId(grant.refresh_token_expires_in) ||
        grant.refresh_token_expires_in > 31_536_000
      )
        malformed();
      result.refreshToken = grant.refresh_token;
      result.refreshExpiresAt = now + grant.refresh_token_expires_in * 1000;
    }
    return result;
  }

  async exchange(code: string, verifier: string): Promise<GitHubGrant> {
    if (!credential(code) || !/^[a-z\d._~-]{43,128}$/i.test(verifier))
      throw new FeedError(
        400,
        "The GitHub authorization code or PKCE verifier is invalid.",
      );
    return this.grant({
      code,
      code_verifier: verifier,
      redirect_uri: this.callback,
    });
  }

  async refresh(refreshToken: string): Promise<GitHubGrant> {
    if (!credential(refreshToken))
      throw new FeedError(
        401,
        "Reconnect GitHub to obtain a new refresh token.",
      );
    return this.grant(
      { grant_type: "refresh_token", refresh_token: refreshToken },
      true,
    );
  }

  async user(accessToken: string): Promise<{ id: number; login: string }> {
    const data = object((await this.api("/user", accessToken)).data);
    if (!positiveId(data.id) || !validOrganization(data.login)) malformed();
    return { id: data.id, login: data.login };
  }

  private installationInfo(value: unknown): InstallationInfo {
    const item = object(value);
    const account = object(item.account);
    if (item.app_id !== Number(this.config.appId))
      throw new FeedError(
        403,
        "This installation does not belong to the configured GitHub App.",
      );
    if (
      !positiveId(item.id) ||
      !positiveId(account.id) ||
      !validOrganization(account.login) ||
      !["User", "Organization"].includes(String(account.type)) ||
      !("suspended_at" in item)
    )
      malformed();
    return {
      id: item.id,
      accountId: account.id,
      account: account.login,
      kind: account.type as InstallationInfo["kind"],
      suspended: item.suspended_at !== null,
    };
  }

  private nextPage(header: string | null, current: URL): URL | null {
    if (!header) return null;
    const next = header
      .split(/,(?=\s*<)/)
      .filter((part) => /;\s*rel\s*=\s*"[^"]*\bnext\b[^"]*"/i.test(part));
    if (!next.length) return null;
    if (next.length !== 1) malformed();
    const match = next[0].match(/^\s*<([^>]+)>/);
    if (!match) malformed();
    let url: URL;
    try {
      url = new URL(match[1], current);
    } catch {
      malformed();
    }
    if (
      url.origin !== API ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      url.pathname !== current.pathname ||
      url.searchParams.get("per_page") !== "100" ||
      [...url.searchParams.keys()].some(
        (key) => !["page", "per_page"].includes(key),
      ) ||
      url.searchParams.getAll("page").length !== 1 ||
      url.searchParams.getAll("per_page").length !== 1 ||
      Number(url.searchParams.get("page")) !==
        Number(current.searchParams.get("page")) + 1
    )
      throw new FeedError(
        502,
        "GitHub returned an untrusted pagination link. No access list was accepted.",
      );
    return url;
  }

  /** Complete, validated pagination. Callers choose the token kind the listing needs. */
  private async listPages<T extends { id: number }>(
    path: string,
    token: string,
    field: string,
    parse: (item: unknown) => T,
  ): Promise<T[]> {
    let url = new URL(`${path}?per_page=100&page=1`, API);
    let total: number | undefined;
    const items = new Map<number, T>();
    for (let page = 1; page <= 100; page += 1) {
      const { data, response } = await this.api(url.href, token);
      const result = object(data);
      if (
        !count(result.total_count) ||
        !Array.isArray(result[field]) ||
        result[field].length > 100 ||
        (total !== undefined && result.total_count !== total)
      )
        malformed();
      total = result.total_count;
      for (const value of result[field]) {
        const item = parse(value);
        if (items.has(item.id)) malformed();
        items.set(item.id, item);
      }
      const next = this.nextPage(response.headers.get("link"), url);
      if (!next) {
        if (items.size !== total) malformed();
        return [...items.values()];
      }
      if (items.size >= total) malformed();
      url = next;
    }
    throw new FeedError(
      502,
      "GitHub access listing exceeded 100 pages. No partial permissions were accepted.",
    );
  }

  installations(userToken: string): Promise<InstallationInfo[]> {
    return this.listPages(
      "/user/installations",
      userToken,
      "installations",
      (item) => this.installationInfo(item),
    );
  }

  /** Pass `installations` when this same user token just listed them. */
  async repositories(
    userToken: string,
    installationId: number,
    installations?: InstallationInfo[],
  ): Promise<Repo[]> {
    if (!positiveId(installationId))
      throw new FeedError(400, "Choose a valid GitHub App installation.");
    const installation = (
      installations ?? (await this.installations(userToken))
    ).find((item) => item.id === installationId);
    if (!installation || installation.suspended)
      throw new FeedError(
        403,
        "You do not have an active grant for this GitHub App installation.",
      );
    return this.listPages(
      `/user/installations/${installationId}/repositories`,
      userToken,
      "repositories",
      repository,
    );
  }

  /** The installation's current repository selection, read with its own token. */
  async installationRepositories(installationId: number): Promise<Repo[]> {
    return this.listPages(
      "/installation/repositories",
      await this.installationToken(installationId),
      "repositories",
      repository,
    );
  }

  private jwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iat: now - 60,
        exp: now + 540,
        iss: this.config.clientId,
      }),
    ).toString("base64url");
    const input = `${header}.${payload}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), this.key).toString("base64url")}`;
  }

  async installation(installationId: number): Promise<InstallationInfo> {
    if (!positiveId(installationId))
      throw new FeedError(400, "Choose a valid GitHub App installation.");
    const info = this.installationInfo(
      (await this.api(`/app/installations/${installationId}`, this.jwt())).data,
    );
    if (info.id !== installationId) malformed();
    return info;
  }

  async installationToken(id: number, repoIds?: number[]): Promise<string> {
    if (
      repoIds !== undefined &&
      (!repoIds.length || repoIds.length > 500 || !repoIds.every(positiveId))
    )
      throw new FeedError(
        400,
        "Choose between 1 and 500 repository IDs for the installation token.",
      );
    const installation = await this.installation(id);
    if (installation.suspended)
      throw new FeedError(403, "This GitHub App installation is suspended.");
    const result = object(
      (
        await this.api(`/app/installations/${id}/access_tokens`, this.jwt(), {
          permissions: READ_PERMISSIONS,
          ...(repoIds === undefined
            ? {}
            : { repository_ids: [...new Set(repoIds)] }),
        })
      ).data,
    );
    const permissions = object(result.permissions);
    if (
      !credential(result.token) ||
      typeof result.expires_at !== "string" ||
      !(Date.parse(result.expires_at) > Date.now()) ||
      Object.keys(READ_PERMISSIONS).some(
        (name) => permissions[name] !== "read",
      ) ||
      Object.values(permissions).some((level) => level !== "read")
    )
      malformed();
    return result.token;
  }

  private async recentRepository(
    repo: Repo,
    token: string,
    cutoff: number,
    now: number,
  ): Promise<ActivityEvent[]> {
    const path = `/repos/${repo.name.split("/").map(encodeURIComponent).join("/")}`;
    const list = async (suffix: string): Promise<Record<string, unknown>[]> => {
      const { data } = await this.api(path + suffix, token);
      if (!Array.isArray(data)) malformed();
      return data.slice(0, 100).map(object);
    };
    const inWindow = (date: unknown) =>
      typeof date === "string" &&
      Date.parse(date) >= cutoff &&
      Date.parse(date) <= now;
    const validActor = (actor: unknown) => credential(object(actor).login);
    const events = new Map<string, ActivityEvent>();
    const add = (
      kind: string,
      payload: Record<string, unknown>,
      actor: unknown,
    ) => {
      if (!validActor(actor)) return;
      const event = normalizeWebhook(
        kind,
        { ...payload, sender: actor, repository: { full_name: repo.name } },
        "backfill",
        new Date(now).toISOString(),
      );
      if (event && inWindow(event.occurredAt))
        events.set(event.id, { ...event, repositoryId: repo.id });
    };
    const pulls = await list(
      "/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1",
    );
    for (const pr of pulls) {
      if (!positiveId(pr.number)) continue;
      if (inWindow(pr.created_at))
        add("pull_request", { action: "opened", pull_request: pr }, pr.user);
      if (inWindow(pr.merged_at))
        add(
          "pull_request",
          { action: "closed", pull_request: { ...pr, merged: true } },
          pr.user,
        );
    }
    const issues = await list(
      `/issues?state=closed&sort=updated&direction=desc&since=${encodeURIComponent(new Date(cutoff).toISOString())}&per_page=100&page=1`,
    );
    for (const issue of issues) {
      if (inWindow(issue.closed_at))
        add("issues", { action: "closed", issue }, issue.closed_by);
    }
    const releases = await list("/releases?per_page=100&page=1");
    for (const release of releases) {
      if (positiveId(release.id) && inWindow(release.published_at))
        add("release", { action: "published", release }, release.author);
    }
    for (const pr of pulls
      .filter((item) => positiveId(item.number) && inWindow(item.updated_at))
      .slice(0, 30)) {
      const reviews = await list(
        `/pulls/${pr.number}/reviews?per_page=100&page=1`,
      );
      for (const review of reviews) {
        if (positiveId(review.id) && inWindow(review.submitted_at))
          add(
            "pull_request_review",
            { action: "submitted", pull_request: pr, review },
            review.user,
          );
      }
    }
    return [...events.values()].sort(
      (a, b) =>
        b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id),
    );
  }

  async backfill(
    installationId: number,
    repositories: Repo[],
    onEvents: (events: ActivityEvent[]) => Promise<void>,
    options: {
      /** Last successful import per repository ID, in epoch milliseconds. */
      since?: Map<number, number>;
      /** Called after a repository's events are stored, with this sync's start time. */
      onSynced?: (repositoryId: number, syncedAt: number) => Promise<void>;
      /** Sync start in epoch milliseconds; pass the database clock so replicas agree. */
      startedAt?: number;
    } = {},
  ): Promise<BackfillResult> {
    const unique = new Map<number, Repo>();
    for (const input of repositories) {
      const repo = repository(input);
      if (unique.has(repo.id) && unique.get(repo.id)!.name !== repo.name)
        malformed();
      unique.set(repo.id, repo);
    }
    const selected = [...unique.values()].slice(0, 20);
    const result: BackfillResult = {
      synced: 0,
      scanned: 0,
      resumed: 0,
      failed: 0,
      skipped: unique.size - selected.length,
    };
    if (selected.length) {
      const token = await this.installationToken(
        installationId,
        selected.map((repo) => repo.id),
      );
      const now = options.startedAt ?? Date.now();
      const window = now - 30 * DAY;
      const queue = [...selected];
      const fatal: unknown[] = [];
      const worker = async () => {
        for (
          let repo = queue.shift();
          repo && !fatal.length;
          repo = queue.shift()
        ) {
          const last = options.since?.get(repo.id);
          // A previously imported repository only needs what changed since then.
          const cutoff =
            last === undefined
              ? window
              : Math.max(window, Math.min(last, now) - SYNC_OVERLAP);
          let events: ActivityEvent[];
          try {
            events = await this.recentRepository(repo, token, cutoff, now);
          } catch (error) {
            if (error instanceof FeedError) result.failed += 1;
            else fatal.push(error);
            continue;
          }
          try {
            // Persistence failures stop the sync and reach the caller.
            if (events.length) await onEvents(events);
            // Only a stored import advances the watermark; failures retry the same range.
            await options.onSynced?.(repo.id, now);
          } catch (error) {
            fatal.push(error);
            continue;
          }
          result.synced += events.length;
          result.scanned += 1;
          if (cutoff > window) result.resumed += 1;
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(BACKFILL_CONCURRENCY, selected.length) },
          worker,
        ),
      );
      if (fatal.length) throw fatal[0];
    }
    return result;
  }
}
