CREATE TABLE ship_live_health_services (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES ship_live_workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,workspace_id)
);
CREATE TABLE ship_live_health_probes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  service_id uuid NOT NULL,
  config jsonb NOT NULL,
  headers_encrypted text,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  lease uuid,
  lease_until timestamptz,
  state text NOT NULL DEFAULT 'unknown',
  failures integer NOT NULL DEFAULT 0,
  successes integer NOT NULL DEFAULT 0,
  last_checked_at timestamptz,
  last_result jsonb,
  FOREIGN KEY (service_id,workspace_id) REFERENCES ship_live_health_services(id,workspace_id) ON DELETE CASCADE
);
CREATE INDEX ship_live_health_due ON ship_live_health_probes(next_check_at);
CREATE TABLE ship_live_health_checks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  probe_id uuid NOT NULL REFERENCES ship_live_health_probes(id) ON DELETE CASCADE,
  checked_at timestamptz NOT NULL DEFAULT now(),
  result jsonb NOT NULL,
  state text NOT NULL
);
CREATE INDEX ship_live_health_checks_recent ON ship_live_health_checks(probe_id,checked_at DESC,id DESC);
DO $$
DECLARE target text; role_name text;
BEGIN
  FOREACH target IN ARRAY ARRAY['ship_live_health_services','ship_live_health_probes','ship_live_health_checks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',target);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',target,role_name);
      END IF;
    END LOOP;
  END LOOP;
END $$;
