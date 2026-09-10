ALTER TABLE ship_live_health_services ADD COLUMN display_order integer;

WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY workspace_id ORDER BY created_at, id) - 1 AS position
  FROM ship_live_health_services
)
UPDATE ship_live_health_services s SET display_order=ranked.position FROM ranked WHERE ranked.id=s.id;

ALTER TABLE ship_live_health_services ALTER COLUMN display_order SET NOT NULL;
ALTER TABLE ship_live_health_services ADD CONSTRAINT ship_live_health_services_workspace_order_key UNIQUE(workspace_id, display_order) DEFERRABLE INITIALLY IMMEDIATE;
