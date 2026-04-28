-- 00027 — Cache broker-reported unrealized P&L on paper_positions.
--
-- The UI was computing "broker P&L" client-side from broker_fill_price
-- and current_price (Twelve Data quote), which approximates but doesn't
-- match what the broker actually shows because:
--   1. Twelve Data quotes mid-price; brokers use bid for long exit and
--      ask for short exit (loses ~half the spread).
--   2. Broker P&L includes commission, swap fees, and any platform-side
--      adjustments the app can't see.
--   3. Twelve Data quote may be a few seconds stale relative to the
--      broker's live tick stream.
--
-- Cleanest fix: trust the broker. Store its reported `profit` field on
-- the row, refreshed each manage-positions tick (every ~5 min), and
-- display that in the UI when available. The synced_at column lets the
-- UI flag a stale read if the broker fetch ever fails for a stretch.
--
-- Both columns nullable — paper-only positions never get them populated.

alter table public.paper_positions
  add column if not exists broker_unrealized_pnl numeric,
  add column if not exists broker_pnl_synced_at timestamptz;
