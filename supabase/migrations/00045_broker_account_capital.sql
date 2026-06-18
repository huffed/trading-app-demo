-- Phase B.1 fidelity: portfolio-level capital basis for portfolio-halt + risk-pool
-- gates. Each broker_connection represents one FTMO account (or generic broker
-- account). The account_capital column captures the account's starting balance
-- so backtest portfolio-halt can use the REAL account capital (e.g. $100K) as
-- the DLL reference, not per-algo allocation ($10K × N algos sharing the broker).
--
-- Setting this enables correct portfolio-halt + risk-pool semantics when
-- multiple algos share a broker_connection_id:
--   - sibling_daily_pnl is summed within the broker group only
--   - DLL = daily_loss_limit_pct × account_capital (not per-algo capital)
--
-- Nullable so existing rows don't fail validation; validate-algo falls back to
-- the per-algo conservative capital when null.

ALTER TABLE public.broker_connections
  ADD COLUMN IF NOT EXISTS account_capital NUMERIC
  CHECK (account_capital IS NULL OR account_capital > 0);

COMMENT ON COLUMN public.broker_connections.account_capital IS
  'Account starting capital in USD. Used by validate-algo + portfolio-halt + risk-pool gates as the per-broker reference_capital. Null = fall back to per-algo capital (conservative).';
