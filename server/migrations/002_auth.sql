CREATE TABLE ship_live_auth_users (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ship_live_auth_sessions (
  token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
  user_id uuid NOT NULL REFERENCES ship_live_auth_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ship_live_auth_sessions_user ON ship_live_auth_sessions(user_id);
CREATE INDEX ship_live_auth_sessions_expiry ON ship_live_auth_sessions(expires_at);

CREATE TABLE ship_live_auth_flows (
  token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
  browser_hash text NOT NULL CHECK (length(browser_hash) = 64),
  expires_at timestamptz NOT NULL
);
CREATE INDEX ship_live_auth_flows_expiry ON ship_live_auth_flows(expires_at);

-- These tables are only accessed by the server's PostgreSQL role. Supabase's
-- browser Data API must not expose session hashes, profiles, or OAuth flows.
ALTER TABLE ship_live_auth_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE ship_live_auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ship_live_auth_flows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ship_live_auth_users, ship_live_auth_sessions, ship_live_auth_flows FROM PUBLIC;
