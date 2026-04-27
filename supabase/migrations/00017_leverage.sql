-- Phase D: leverage modelling. Algorithms now carry an explicit leverage
-- ratio so the backtest engine can simulate lot-based position sizing the
-- way real prop accounts work. Default 30:1 — middle of the road for
-- forex/commodity. FTMO offers up to 1:100 forex and 1:30 commodities.

ALTER TABLE public.algorithms
  ADD COLUMN IF NOT EXISTS leverage INTEGER NOT NULL DEFAULT 30
    CHECK (leverage >= 1 AND leverage <= 500);
