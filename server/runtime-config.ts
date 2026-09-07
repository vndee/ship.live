import type { AuthConfig } from "./auth.js";
import type { GitHubAppConfig } from "./github-app.js";

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
