export const MIGRATION_FILES: readonly string[] = [
  "001_initial.sql",
  "002_auth.sql",
  "003_workspaces.sql",
  "004_connection_fencing.sql",
  "005_dashboard_shares.sql",
  "006_service_health.sql",
  "007_health_shares.sql",
  "008_health_latency_daily.sql",
  "009_engineering_wall.sql",
  "010_health_service_order.sql",
  "011_github_access.sql",
  "012_repository_sync.sql",
  "013_sync_runs.sql",
  "014_rate_limits_retention.sql",
  "015_webhooks.sql",
  "016_uptime_maintenance.sql",
  "017_share_link_reveal.sql",
  "018_pulse_heading.sql",
  "019_inbound_alerts.sql",
  "020_personal_sources.sql",
];

export const SCHEMA_VERSION = MIGRATION_FILES.length;
export const MAX_SUPPORTED_SCHEMA_VERSION = SCHEMA_VERSION + 1;

export function assertSupportedSchema(appliedVersions: readonly number[]) {
  if (appliedVersions.some((version) => version > MAX_SUPPORTED_SCHEMA_VERSION))
    throw new Error(
      "This database uses a newer ship.live schema. Upgrade the application before starting it.",
    );
}
