CREATE TABLE ship_live_organizations (
  organization text PRIMARY KEY,
  protected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ship_live_events (
  organization text NOT NULL REFERENCES ship_live_organizations (organization),
  event_id text NOT NULL,
  event jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  restricted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (organization, event_id)
);

CREATE INDEX ship_live_events_recent
  ON ship_live_events (organization, occurred_at DESC, event_id);

CREATE TABLE ship_live_deliveries (
  delivery_id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);
