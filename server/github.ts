import type { ActivityEvent } from "../shared/types.js";
import { normalizeRestEvent, object, validOrganization } from "./normalize.js";

export interface GitHubConfig {
  organization?: string;
  token?: string;
}
interface CachedFeed {
  events: ActivityEvent[];
  updatedAt: string;
  etag?: string;
  nextPollAt: number;
}
export class FeedError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
  }
}

/** Seconds until GitHub accepts requests again, bounded to one minute through one hour. */
export function rateLimitRetryAfter(headers: Headers, now: number): number {
  const reset = Number(headers.get("x-ratelimit-reset")) * 1000;
  return Math.min(
    3600,
    Math.max(
      60,
      Number(headers.get("retry-after")) ||
        Math.ceil((reset - now) / 1000) ||
        60,
    ),
  );
}

export function githubHeaders(
  organization: string,
  config: GitHubConfig,
  etag?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
    "User-Agent": "eng-live-feed",
  };
  if (
    config.token &&
    config.organization?.toLowerCase() === organization.toLowerCase()
  )
    headers.Authorization = `Bearer ${config.token}`;
  if (etag) headers["If-None-Match"] = etag;
  return headers;
}

export class GitHubFeed {
  private readonly cache = new Map<string, CachedFeed>();
  private readonly pending = new Map<string, Promise<CachedFeed>>();
  private readonly failures = new Map<
    string,
    { error: FeedError; expires: number }
  >();
  constructor(
    private readonly config: GitHubConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async get(organization: string): Promise<CachedFeed> {
    if (!validOrganization(organization))
      throw new FeedError(400, "Enter a valid GitHub organization name.");
    const org = organization.toLowerCase();
    const cached = this.cache.get(org);
    if (cached && cached.nextPollAt > this.now()) return cached;
    const failure = this.failures.get(org);
    if (failure && failure.expires > this.now()) throw failure.error;
    const running = this.pending.get(org);
    if (running) return running;
    const request = this.load(org, cached)
      .catch((error: unknown) => {
        const readable =
          error instanceof FeedError
            ? error
            : new FeedError(
                502,
                "GitHub could not be reached. Please try again shortly.",
              );
        this.failures.set(org, {
          error: readable,
          expires: this.now() + (readable.retryAfter ?? 60) * 1000,
        });
        if (this.failures.size > 100)
          this.failures.delete(this.failures.keys().next().value!);
        throw readable;
      })
      .finally(() => this.pending.delete(org));
    this.pending.set(org, request);
    return request;
  }

  private async load(
    organization: string,
    cached?: CachedFeed,
  ): Promise<CachedFeed> {
    const response = await this.fetcher(
      `https://api.github.com/orgs/${encodeURIComponent(organization)}/events?per_page=100`,
      {
        headers: githubHeaders(organization, this.config, cached?.etag),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      },
    );
    const pollSeconds = Math.max(
      60,
      Number(response.headers.get("x-poll-interval")) || 60,
    );
    const nextPollAt = this.now() + pollSeconds * 1000;
    if (response.status === 304 && cached) {
      const result = {
        ...cached,
        updatedAt: new Date(this.now()).toISOString(),
        nextPollAt,
      };
      this.cache.set(organization, result);
      return result;
    }
    if (!response.ok) {
      if (response.status === 404)
        throw new FeedError(
          404,
          "GitHub organization not found. Check the organization name.",
        );
      const limited =
        response.status === 429 ||
        response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.has("retry-after");
      if (limited) {
        const retryAfter = rateLimitRetryAfter(response.headers, this.now());
        throw new FeedError(
          429,
          "GitHub rate limit reached. The feed will retry automatically; a server token can increase the allowance.",
          retryAfter,
        );
      }
      if (response.status === 401 || response.status === 403)
        throw new FeedError(
          502,
          "GitHub rejected the request. Check the server token and organization access.",
        );
      throw new FeedError(
        502,
        "GitHub is temporarily unavailable. Please try again shortly.",
      );
    }
    const payload: unknown = await response.json();
    if (!Array.isArray(payload))
      throw new FeedError(502, "GitHub returned an unexpected feed response.");
    const events = payload
      // This endpoint is public; fail closed if upstream ever includes a private event.
      .filter((event) => object(event).public === true)
      .map(normalizeRestEvent)
      .filter(
        (event): event is ActivityEvent =>
          event !== null &&
          event.repo.split("/")[0].toLowerCase() === organization,
      );
    const result: CachedFeed = {
      events,
      updatedAt: new Date(this.now()).toISOString(),
      etag: response.headers.get("etag") ?? undefined,
      nextPollAt,
    };
    this.cache.set(organization, result);
    if (this.cache.size > 100)
      this.cache.delete(this.cache.keys().next().value!);
    this.failures.delete(organization);
    return result;
  }
}
