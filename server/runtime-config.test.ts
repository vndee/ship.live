import assert from "node:assert/strict";
import test from "node:test";
import {
  githubAppConfigFromEnv,
  metricsTokenFromEnv,
  retentionFromEnv,
  trustProxyHopsFromEnv,
} from "./runtime-config.js";

test("retention keeps activity by default, expires delivery IDs after 30 days, and bounds settings", () => {
  assert.deepEqual(retentionFromEnv({}), { eventDays: 0, deliveryDays: 30 });
  assert.deepEqual(
    retentionFromEnv({
      EVENT_RETENTION_DAYS: " 90 ",
      DELIVERY_RETENTION_DAYS: "0",
    }),
    { eventDays: 90, deliveryDays: 0 },
  );
  for (const value of ["30", "-1", "1.5", "36501", "forever"])
    assert.throws(() => retentionFromEnv({ EVENT_RETENTION_DAYS: value }));
  assert.throws(() => retentionFromEnv({ DELIVERY_RETENTION_DAYS: "6" }));
});

test("metrics stay disabled without a token and require a long one", () => {
  assert.equal(metricsTokenFromEnv({}), undefined);
  assert.throws(() => metricsTokenFromEnv({ METRICS_TOKEN: "short-token" }));
  assert.equal(
    metricsTokenFromEnv({ METRICS_TOKEN: ` ${"m".repeat(32)} ` }),
    "m".repeat(32),
  );
});

test("proxy trust defaults to direct access and rejects unbounded values", () => {
  assert.equal(trustProxyHopsFromEnv({}), 0);
  assert.equal(trustProxyHopsFromEnv({ TRUST_PROXY_HOPS: "1" }), 1);
  for (const value of ["true", "-1", "6", "1.5", "1e0"])
    assert.throws(() => trustProxyHopsFromEnv({ TRUST_PROXY_HOPS: value }));
});

test("GitHub activity requires complete credentials, authentication, and an encryption key", () => {
  const auth = { appUrl: "https://ship.example.test" };
  assert.equal(githubAppConfigFromEnv(auth, {}), undefined);
  assert.equal(
    githubAppConfigFromEnv(auth, { GITHUB_WEBHOOK_SECRET: "legacy" }),
    undefined,
  );
  assert.throws(() => githubAppConfigFromEnv(auth, { GITHUB_APP_ID: "1" }));
  const env = {
    GITHUB_APP_ID: "1",
    GITHUB_APP_CLIENT_ID: "test-client",
    GITHUB_APP_CLIENT_SECRET: "synthetic-secret",
    GITHUB_APP_PRIVATE_KEY: "synthetic\\nkey",
    GITHUB_APP_SLUG: "ship-test",
    GITHUB_WEBHOOK_SECRET: "synthetic-webhook",
    TOKEN_ENCRYPTION_KEY: "ab".repeat(32),
  };
  assert.throws(() => githubAppConfigFromEnv(auth, env));
  const enabled = {
    ...auth,
    supabaseUrl: "https://auth.example.test",
    supabasePublishableKey: "sb_publishable_synthetic",
  };
  assert.throws(() =>
    githubAppConfigFromEnv(enabled, {
      ...env,
      TOKEN_ENCRYPTION_KEY: "too-short",
    }),
  );
  const result = githubAppConfigFromEnv(enabled, env);
  assert.equal(result?.privateKey, "synthetic\nkey");
  assert.equal(result?.appUrl, auth.appUrl);
});
