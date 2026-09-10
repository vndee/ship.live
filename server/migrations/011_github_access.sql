-- Repository access each viewer's GitHub user token reported at their last
-- explicit connect, refresh, or sync. Reads authorize from this snapshot
-- instead of calling GitHub; installation webhooks narrow it.
CREATE TABLE ship_live_github_access (
  user_id uuid NOT NULL REFERENCES ship_live_github_connections(user_id) ON DELETE CASCADE,
  generation uuid NOT NULL,
  installation_id bigint NOT NULL,
  account_id bigint NOT NULL,
  account_login text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('User','Organization')),
  repositories jsonb NOT NULL,
  PRIMARY KEY (user_id, installation_id)
);
CREATE INDEX ship_live_github_access_installation
  ON ship_live_github_access(installation_id);

-- NULL until the current authorization has been synced at least once.
ALTER TABLE ship_live_github_connections ADD COLUMN access_synced_at timestamptz;
-- Bumped by every webhook narrowing. A refresh that read GitHub under an older
-- value is discarded, so it cannot restore access removed in the meantime.
ALTER TABLE ship_live_github_connections
  ADD COLUMN access_version bigint NOT NULL DEFAULT 0;

ALTER TABLE ship_live_github_access ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ship_live_github_access FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON ship_live_github_access FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
