-- Request limits shared by every replica. Rows are short-lived counters, so the
-- table is unlogged: a crash only resets the current minute's counts.
CREATE UNLOGGED TABLE ship_live_rate_limits (
  bucket text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL
) WITH (fillfactor = 70);
CREATE INDEX ship_live_rate_limits_window_idx
  ON ship_live_rate_limits(window_start);

-- The retention job deletes by age across every scope.
CREATE INDEX ship_live_events_occurred_idx ON ship_live_events(occurred_at);
CREATE INDEX ship_live_deliveries_received_idx
  ON ship_live_deliveries(received_at);
CREATE INDEX ship_live_wall_deliveries_received_idx
  ON ship_live_wall_deliveries(received_at);
CREATE INDEX ship_live_wall_signals_observed_idx
  ON ship_live_wall_signals(observed_at);

ALTER TABLE ship_live_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ship_live_rate_limits FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON ship_live_rate_limits FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
