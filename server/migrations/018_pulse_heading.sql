-- A workspace's own Pulse heading. NULL shows the default.
ALTER TABLE ship_live_workspaces
  ADD COLUMN pulse_title text CHECK (char_length(pulse_title) <= 80),
  ADD COLUMN pulse_subtitle text CHECK (char_length(pulse_subtitle) <= 200);
