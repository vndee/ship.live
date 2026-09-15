CREATE TABLE ship_live_review_claims (
 workspace_id uuid NOT NULL REFERENCES ship_live_workspaces(id) ON DELETE CASCADE,
 repository_id bigint NOT NULL,
 pull_number integer NOT NULL CHECK(pull_number>0),
 fingerprint text NOT NULL,
 user_id uuid NOT NULL REFERENCES ship_live_auth_users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,repository_id,pull_number)
);
CREATE TABLE ship_live_review_snoozes (
 workspace_id uuid NOT NULL REFERENCES ship_live_workspaces(id) ON DELETE CASCADE,
 repository_id bigint NOT NULL,
 pull_number integer NOT NULL CHECK(pull_number>0),
 user_id uuid NOT NULL REFERENCES ship_live_auth_users(id) ON DELETE CASCADE,
 fingerprint text NOT NULL,
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,repository_id,pull_number,user_id)
);
ALTER TABLE ship_live_review_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE ship_live_review_snoozes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ship_live_review_claims,ship_live_review_snoozes FROM PUBLIC;


CREATE TABLE ship_live_recap_notes (
  workspace_id uuid NOT NULL REFERENCES ship_live_workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES ship_live_auth_users(id) ON DELETE CASCADE,
  week_start date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
  reflection text NOT NULL DEFAULT '' CHECK (char_length(reflection) <= 5000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, week_start)
);
CREATE TABLE ship_live_digest_schedules (
  workspace_id uuid PRIMARY KEY REFERENCES ship_live_workspaces(id) ON DELETE CASCADE,
  weekday smallint NOT NULL DEFAULT 1 CHECK (weekday BETWEEN 0 AND 6),
  local_time text NOT NULL DEFAULT '09:00' CHECK (local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  timezone text NOT NULL DEFAULT 'UTC',
  updated_at timestamptz NOT NULL DEFAULT now()
);


CREATE TABLE ship_live_saved_views (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES ship_live_auth_users(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES ship_live_workspaces(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 60),
 href text NOT NULL CHECK(char_length(href) BETWEEN 1 AND 2048),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ship_live_saved_views_owner ON ship_live_saved_views(user_id, created_at);
ALTER TABLE ship_live_saved_views ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ship_live_saved_views FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON ship_live_saved_views FROM %I',r);
  END IF;
 END LOOP;
END $$;

-- Hosted database APIs can grant table privileges by default. Only the server
-- role may access follow-through, private reflections, or scheduling settings.
DO $$ DECLARE target text; role_name text; BEGIN
  FOREACH target IN ARRAY ARRAY[
    'ship_live_review_claims', 'ship_live_review_snoozes',
    'ship_live_recap_notes', 'ship_live_digest_schedules', 'ship_live_saved_views'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', target);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', target, role_name);
      END IF;
    END LOOP;
  END LOOP;
END $$;
