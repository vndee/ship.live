CREATE TABLE ship_live_dashboard_shares (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES ship_live_workspaces(id) ON DELETE CASCADE,
  creator_user_id uuid NOT NULL REFERENCES ship_live_auth_users(id) ON DELETE CASCADE,
  connection_generation uuid NOT NULL,
  installation_id bigint NOT NULL,
  repository_ids bigint[] NOT NULL CHECK (cardinality(repository_ids) > 0),
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE(workspace_id, creator_user_id)
);

ALTER TABLE ship_live_dashboard_shares ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ship_live_dashboard_shares FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON ship_live_dashboard_shares FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
