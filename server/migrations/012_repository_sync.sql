-- When each installation repository's history was last imported. Syncs
-- resume from here instead of re-reading the whole 30-day window.
CREATE TABLE ship_live_repository_sync (
  installation_id bigint NOT NULL,
  repository_id bigint NOT NULL,
  synced_at timestamptz NOT NULL,
  PRIMARY KEY (installation_id, repository_id)
);

ALTER TABLE ship_live_repository_sync ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ship_live_repository_sync FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON ship_live_repository_sync FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
