-- A workspace's own name. NULL shows the default: the GitHub account for a
-- team, or "<name>'s journal" for a journal.
ALTER TABLE ship_live_workspaces
  ADD COLUMN display_name text CHECK (char_length(display_name) <= 80);
