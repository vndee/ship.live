CREATE TABLE ship_live_health_latency_daily (
  probe_id uuid NOT NULL REFERENCES ship_live_health_probes(id) ON DELETE CASCADE,
  day date NOT NULL,
  checks bigint NOT NULL CHECK (checks > 0),
  total_latency numeric NOT NULL,
  min_latency numeric NOT NULL,
  max_latency numeric NOT NULL,
  PRIMARY KEY (probe_id, day)
);
INSERT INTO ship_live_health_latency_daily
SELECT probe_id,(checked_at AT TIME ZONE 'UTC')::date,count(*),
       sum((result->>'latencyMs')::numeric),min((result->>'latencyMs')::numeric),max((result->>'latencyMs')::numeric)
FROM ship_live_health_checks
WHERE checked_at >= now()-interval '30 days'
GROUP BY probe_id,(checked_at AT TIME ZONE 'UTC')::date;
ALTER TABLE ship_live_health_latency_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE ship_live_health_latency_daily FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE ship_live_health_latency_daily FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
