import type { AuthConfig } from "./auth.js";
import type { GitHubAppConfig } from "./github-app.js";
import type { RetentionPolicy } from "./maintenance.js";

function days(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
): number {
  const value = env[name]?.trim();
  if (!value) return fallback;
  const parsed = /^\d{1,5}$/.test(value) ? Number(value) : NaN;
  if (parsed !== 0 && !(parsed >= minimum && parsed <= 36_500))
    throw new Error(
      `${name} must be 0 (keep indefinitely) or a whole number of days from ${minimum} to 36500.`,
    );
  return parsed;
}

/**
 * Activity is kept indefinitely unless an operator opts in; the minimum covers
 * the 30-day import window and weekly recognition. Delivery IDs only guard
 * against GitHub redelivering the same webhook, so they expire after 30 days.
 */
export function retentionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RetentionPolicy {
  return {
    eventDays: days(env, "EVENT_RETENTION_DAYS", 0, 31),
    deliveryDays: days(env, "DELIVERY_RETENTION_DAYS", 30, 7),
  };
}

/** /metrics stays disabled until an operator sets a bearer token for it. */
export function metricsTokenFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const token = env.METRICS_TOKEN?.trim();
  if (!token) return undefined;
  if (token.length < 24)
    throw new Error("METRICS_TOKEN must be at least 24 characters.");
  return token;
}

export function trustProxyHopsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const value = env.TRUST_PROXY_HOPS?.trim() || "0";
  if (!/^[0-5]$/.test(value))
    throw new Error("TRUST_PROXY_HOPS must be an integer from 0 to 5.");
  return Number(value);
}

export function githubAppConfigFromEnv(
  auth: AuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): GitHubAppConfig | undefined {
  const appId = env.GITHUB_APP_ID?.trim();
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.replaceAll("\\n", "\n").trim();
  const slug = env.GITHUB_APP_SLUG?.trim();
  if (![appId, clientId, clientSecret, privateKey, slug].some(Boolean))
    return undefined;
  if (
    !appId ||
    !clientId ||
    !clientSecret ||
    !privateKey ||
    !slug ||
    !env.GITHUB_WEBHOOK_SECRET?.trim()
  )
    throw new Error(
      "Set all GitHub App credentials and GITHUB_WEBHOOK_SECRET to enable repository connections.",
    );
  if (!auth.supabaseUrl || !auth.supabasePublishableKey)
    throw new Error(
      "Configure Supabase Auth before enabling GitHub App connections.",
    );
  if (!/^[a-f\d]{64}$/i.test(env.TOKEN_ENCRYPTION_KEY?.trim() || ""))
    throw new Error(
      "Set a 32-byte TOKEN_ENCRYPTION_KEY as 64 hexadecimal characters.",
    );
  return {
    appId,
    clientId,
    clientSecret,
    privateKey,
    slug,
    appUrl: auth.appUrl,
  };
}
