-- Phase B: live trading. Algorithms can opt in to placing real broker orders
-- alongside their paper positions; paper positions track the matching real
-- order so we can reconcile fills and surface divergence.

ALTER TABLE public.algorithms
  ADD COLUMN IF NOT EXISTS broker_connection_id UUID
    REFERENCES public.broker_connections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS live_trading_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_algorithms_broker
  ON public.algorithms (broker_connection_id)
  WHERE broker_connection_id IS NOT NULL;

ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS broker_order_id   TEXT,
  ADD COLUMN IF NOT EXISTS broker_position_id TEXT,
  ADD COLUMN IF NOT EXISTS broker_fill_price NUMERIC,
  ADD COLUMN IF NOT EXISTS broker_close_id   TEXT,
  ADD COLUMN IF NOT EXISTS broker_close_price NUMERIC,
  ADD COLUMN IF NOT EXISTS broker_error      TEXT;
