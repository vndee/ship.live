-- The latest history sync per workspace. Sync runs in the background after the
-- request returns; clients read this row for its outcome on any replica.
CREATE TABLE ship_live_sync_runs (
  workspace_id uuid PRIMARY KEY REFERENCES ship_live_workspaces(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES ship_live_auth_users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('running','succeeded','failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  synced integer,
  message text
);

ALTER TABLE ship_live_sync_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ship_live_sync_runs FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON ship_live_sync_runs FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
