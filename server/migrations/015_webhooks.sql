-- Outbound webhooks: endpoints, a transactional event outbox, deliveries, and
-- flap cooldowns. Inbound endpoints accept external JSON for a team. Service
-- Health incidents record each period a probe was down.
CREATE TABLE ship_live_webhooks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES ship_live_workspaces(id) ON DELETE CASCADE,
  creator_user_id uuid NOT NULL REFERENCES ship_live_auth_users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  preset text NOT NULL,
  -- Chat webhook URLs are credentials; the hint is the host and a masked path.
  url_encrypted text NOT NULL,
  url_hint text NOT NULL,
  method text NOT NULL CHECK (method IN ('POST','PUT','PATCH')),
  content_type text NOT NULL,
  template text NOT NULL,
  headers_encrypted text,
  secret_encrypted text,
  -- ship: X-Ship-Signature header; lark: timestamp and sign in the body.
  signing text NOT NULL DEFAULT 'ship' CHECK (signing IN ('ship','lark')),
  -- Some services answer 200 with an error code in the body, so success can
  -- also require a JSON value in the response, such as Lark's code = 0.
  success_json_path text,
  success_json_value jsonb,
  events text[] NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}',
  cooldown_seconds integer NOT NULL DEFAULT 0 CHECK (cooldown_seconds BETWEEN 0 AND 86400),
  -- The creator's repositories when saved; fan-out intersects them with the
  -- creator's current access, like share links.
  repository_ids bigint[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  paused_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ship_live_webhooks_workspace_idx ON ship_live_webhooks(workspace_id);

CREATE TABLE ship_live_webhook_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES ship_live_workspaces(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL,
  dedupe_key text NOT NULL,
  repository_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  routed_at timestamptz,
  UNIQUE (workspace_id, dedupe_key)
);
CREATE INDEX ship_live_webhook_events_unrouted_idx
  ON ship_live_webhook_events(created_at) WHERE routed_at IS NULL;
CREATE INDEX ship_live_webhook_events_created_idx
  ON ship_live_webhook_events(created_at);

CREATE TABLE ship_live_webhook_deliveries (
  id uuid PRIMARY KEY,
  webhook_id uuid NOT NULL REFERENCES ship_live_webhooks(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES ship_live_webhook_events(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending','succeeded','failed','dead','skipped')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease uuid,
  lease_until timestamptz,
  request_body text,
  response_status integer,
  response_body text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (webhook_id, event_id)
);
CREATE INDEX ship_live_webhook_deliveries_due_idx
  ON ship_live_webhook_deliveries(next_attempt_at) WHERE status = 'pending';
CREATE INDEX ship_live_webhook_deliveries_log_idx
  ON ship_live_webhook_deliveries(webhook_id, created_at DESC);
CREATE INDEX ship_live_webhook_deliveries_created_idx
  ON ship_live_webhook_deliveries(created_at);

CREATE TABLE ship_live_webhook_cooldowns (
  webhook_id uuid NOT NULL REFERENCES ship_live_webhooks(id) ON DELETE CASCADE,
  key text NOT NULL,
  until timestamptz NOT NULL,
  PRIMARY KEY (webhook_id, key)
);

CREATE TABLE ship_live_inbound_hooks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES ship_live_workspaces(id) ON DELETE CASCADE,
  creator_user_id uuid NOT NULL REFERENCES ship_live_auth_users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  token_hash text NOT NULL UNIQUE,
  secret_encrypted text,
  mapping jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_received_at timestamptz,
  UNIQUE (workspace_id, slug)
);

CREATE TABLE ship_live_inbound_receipts (
  id uuid PRIMARY KEY,
  hook_id uuid NOT NULL REFERENCES ship_live_inbound_hooks(id) ON DELETE CASCADE,
  received_at timestamptz NOT NULL DEFAULT now(),
  accepted boolean NOT NULL,
  summary text,
  error text
);
CREATE INDEX ship_live_inbound_receipts_hook_idx
  ON ship_live_inbound_receipts(hook_id, received_at DESC);

CREATE TABLE ship_live_health_incidents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES ship_live_workspaces(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES ship_live_health_services(id) ON DELETE CASCADE,
  probe_id uuid NOT NULL REFERENCES ship_live_health_probes(id) ON DELETE CASCADE,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  reason text NOT NULL
);
-- At most one open incident per probe.
CREATE UNIQUE INDEX ship_live_health_incidents_open_idx
  ON ship_live_health_incidents(probe_id) WHERE resolved_at IS NULL;
CREATE INDEX ship_live_health_incidents_workspace_idx
  ON ship_live_health_incidents(workspace_id, opened_at DESC);

CREATE TABLE ship_live_digest_runs (
  workspace_id uuid NOT NULL REFERENCES ship_live_workspaces(id) ON DELETE CASCADE,
  week_start date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, week_start)
);

DO $$
DECLARE
  table_name text;
  role_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'ship_live_webhooks', 'ship_live_webhook_events',
    'ship_live_webhook_deliveries', 'ship_live_webhook_cooldowns',
    'ship_live_inbound_hooks', 'ship_live_inbound_receipts',
    'ship_live_health_incidents', 'ship_live_digest_runs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', table_name);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', table_name, role_name);
      END IF;
    END LOOP;
  END LOOP;
END $$;
