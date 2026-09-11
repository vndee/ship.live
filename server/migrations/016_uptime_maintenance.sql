-- 90-day uptime: each day's aggregate also counts the checks that passed,
-- and daily aggregates are kept for 90 days. Existing days are backfilled
-- only when every check they counted is still retained; the rest stay NULL
-- and are left out of uptime rather than guessed.
ALTER TABLE ship_live_health_latency_daily ADD COLUMN passed bigint;
UPDATE ship_live_health_latency_daily d SET passed = recent.passed
FROM (
  SELECT probe_id, (checked_at AT TIME ZONE 'UTC')::date AS day,
         count(*) AS checks,
         count(*) FILTER (WHERE (result->>'ok')::boolean) AS passed
  FROM ship_live_health_checks
  GROUP BY 1, 2
) recent
WHERE recent.probe_id = d.probe_id AND recent.day = d.day
  AND recent.checks = d.checks;

-- Planned maintenance. Checks inside a window are recorded but count against
-- no uptime figure, open no incidents, and send no alerts. A window without a
-- service covers every service in the workspace.
CREATE TABLE ship_live_health_maintenance (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES ship_live_workspaces(id) ON DELETE CASCADE,
  service_id uuid REFERENCES ship_live_health_services(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  created_by uuid REFERENCES ship_live_auth_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ship_live_health_maintenance_window_idx
  ON ship_live_health_maintenance(workspace_id, ends_at);

ALTER TABLE ship_live_health_maintenance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ship_live_health_maintenance FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON ship_live_health_maintenance FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
