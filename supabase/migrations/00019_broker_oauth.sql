-- cTrader OAuth support: store the refresh token + expiry so we can
-- refresh access tokens when they age out (cTrader access_tokens are
-- typically valid for 30 days).
--
-- Existing columns repurposed for cTrader:
--   api_token       → OAuth access_token
--   account_id      → ctidTraderAccountId (numeric proto account id)
--   account_login   → human-readable cTrader account number (e.g. 17101660)
--
-- Existing MetaApi rows continue to use api_token as their MetaApi token
-- and ignore the new columns.
alter table broker_connections
  add column if not exists refresh_token text,
  add column if not exists token_expires_at timestamp with time zone;
