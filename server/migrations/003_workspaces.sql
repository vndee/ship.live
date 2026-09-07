CREATE TABLE ship_live_workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('personal','team')),
  owner_user_id uuid UNIQUE REFERENCES ship_live_auth_users(id) ON DELETE CASCADE,
  installation_id bigint UNIQUE,
  github_account text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind='personal' AND owner_user_id IS NOT NULL) OR (kind='team' AND owner_user_id IS NULL))
);

CREATE TABLE ship_live_workspace_members (
  workspace_id uuid REFERENCES ship_live_workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES ship_live_auth_users(id) ON DELETE CASCADE,
  PRIMARY KEY(workspace_id,user_id)
);

CREATE TABLE ship_live_github_connections (
  user_id uuid PRIMARY KEY REFERENCES ship_live_auth_users(id) ON DELETE CASCADE,
  github_user_id bigint UNIQUE NOT NULL,
  login text NOT NULL,
  encrypted_grant text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ship_live_github_flows (
  state_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES ship_live_auth_users(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  encrypted_verifier text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE ship_live_installations (
  id bigint PRIMARY KEY,
  account_id bigint NOT NULL,
  account_login text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('User','Organization')),
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ship_live_notes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES ship_live_workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES ship_live_auth_users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK(char_length(body)<=10000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ship_live_notes_recent ON ship_live_notes(workspace_id,created_at DESC);
CREATE INDEX ship_live_events_repository ON ship_live_events(organization, (event->>'repositoryId'),occurred_at DESC);

-- The application accesses PostgreSQL on the server. Supabase's browser-facing
-- Data API must not inherit its default public-schema grants for these tables.
DO $$
DECLARE target record; role_name text;
BEGIN
  FOR target IN SELECT schemaname,tablename FROM pg_tables
    WHERE schemaname=current_schema() AND left(tablename,10)='ship_live_'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',target.schemaname,target.tablename);
    EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM PUBLIC',target.schemaname,target.tablename);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM %I',target.schemaname,target.tablename,role_name);
      END IF;
    END LOOP;
  END LOOP;
END $$;
