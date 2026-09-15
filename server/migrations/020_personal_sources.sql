-- A personal dashboard's GitHub sources. NULL follows every installation its
-- owner connects; mine_only keeps only the owner's own GitHub activity.
ALTER TABLE ship_live_workspaces
  ADD COLUMN source_installation_ids bigint[],
  ADD COLUMN source_mine_only boolean NOT NULL DEFAULT true;
