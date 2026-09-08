-- A new authorization receives a new generation, even for the same GitHub
-- identity. In-flight reads and installation changes must still match it.
ALTER TABLE ship_live_github_connections
  ADD COLUMN generation uuid NOT NULL DEFAULT gen_random_uuid();

-- Keep a claimed OAuth transaction until its credentials are committed.
-- Disconnecting can then invalidate a callback already exchanging its code.
ALTER TABLE ship_live_github_flows
  ADD COLUMN consumed boolean NOT NULL DEFAULT false;
