-- Inbound alerts are kept even without an outbound webhook listening, and a
-- team's Live activity reads its most recent ones.
CREATE INDEX ship_live_webhook_events_inbound_idx
  ON ship_live_webhook_events(workspace_id, created_at DESC)
  WHERE type LIKE 'inbound.%';
