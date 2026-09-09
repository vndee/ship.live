CREATE TABLE ship_live_wall_deliveries (
  delivery_id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ship_live_wall_signals (
  installation_id bigint NOT NULL,
  repository_id bigint NOT NULL,
  repository text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('pull_request','review','pipeline','deployment')),
  signal_key text NOT NULL,
  observed_at timestamptz NOT NULL,
  value jsonb NOT NULL,
  PRIMARY KEY (installation_id, repository_id, kind, signal_key)
);
CREATE INDEX ship_live_wall_signals_scope_idx
  ON ship_live_wall_signals(installation_id, repository_id, observed_at DESC);
ALTER TABLE ship_live_wall_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ship_live_wall_signals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE ship_live_wall_deliveries, ship_live_wall_signals FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE ship_live_wall_deliveries, ship_live_wall_signals FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
