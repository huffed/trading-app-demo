-- Paper positions — virtual trades placed by the scan engine.
-- Separate from the `trades` table (which holds real/manual trade history).

CREATE TABLE public.paper_positions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  algorithm_id      UUID NOT NULL REFERENCES public.algorithms(id) ON DELETE CASCADE,

  -- Instrument
  ticker            TEXT NOT NULL,
  side              TEXT NOT NULL DEFAULT 'long' CHECK (side IN ('long', 'short')),

  -- Sizing
  quantity          NUMERIC NOT NULL CHECK (quantity > 0),
  notional_value    NUMERIC NOT NULL CHECK (notional_value > 0),

  -- Prices
  entry_price       NUMERIC NOT NULL CHECK (entry_price > 0),
  exit_price        NUMERIC,
  current_price     NUMERIC,

  -- Timing
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at         TIMESTAMPTZ,

  -- P&L
  unrealized_pnl    NUMERIC DEFAULT 0,
  realized_pnl      NUMERIC,

  -- Why this position was opened (conditions that fired, signal result, confidence)
  entry_reason      JSONB NOT NULL DEFAULT '{}',
  -- Why it was closed
  exit_reason       TEXT CHECK (exit_reason IS NULL OR exit_reason IN (
    'stop_loss', 'take_profit', 'exit_signal', 'manual'
  )),

  -- Risk prices (absolute, calculated at entry from algorithm rules)
  stop_loss_price   NUMERIC,
  take_profit_price NUMERIC,

  -- Status
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),

  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_paper_positions_user_status
  ON public.paper_positions (user_id, status);

CREATE INDEX idx_paper_positions_user_algorithm
  ON public.paper_positions (user_id, algorithm_id);

CREATE INDEX idx_paper_positions_algorithm_status
  ON public.paper_positions (algorithm_id, status);

CREATE INDEX idx_paper_positions_user_opened
  ON public.paper_positions (user_id, opened_at DESC);

-- RLS
ALTER TABLE public.paper_positions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own positions"
  ON public.paper_positions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own positions"
  ON public.paper_positions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own positions"
  ON public.paper_positions FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own positions"
  ON public.paper_positions FOR DELETE
  USING (auth.uid() = user_id);

-- Reuse the shared updated_at trigger
CREATE TRIGGER update_paper_positions_updated_at
  BEFORE UPDATE ON public.paper_positions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
