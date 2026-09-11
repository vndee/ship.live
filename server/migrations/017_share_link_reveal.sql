-- Share links keep an encrypted copy of their token, sealed with
-- TOKEN_ENCRYPTION_KEY, so their creator can copy the active link again.
-- Links created earlier have only the hash and are shown only on creation.
ALTER TABLE ship_live_dashboard_shares ADD COLUMN token_encrypted text;
ALTER TABLE ship_live_health_shares ADD COLUMN token_encrypted text;
