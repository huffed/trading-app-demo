-- Trades table for manual entry and CSV imports
CREATE TABLE public.trades (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Instrument
  symbol          TEXT NOT NULL,
  asset_class     TEXT NOT NULL DEFAULT 'equity'
                    CHECK (asset_class IN ('equity', 'option', 'future', 'forex', 'crypto')),

  -- Position
  side            TEXT NOT NULL CHECK (side IN ('long', 'short')),
  quantity        NUMERIC NOT NULL CHECK (quantity > 0),

  -- Prices
  entry_price     NUMERIC NOT NULL CHECK (entry_price >= 0),
  exit_price      NUMERIC CHECK (exit_price >= 0),

  -- Timing
  entry_date      TIMESTAMPTZ NOT NULL,
  exit_date       TIMESTAMPTZ,

  -- Costs
  commission      NUMERIC DEFAULT 0 CHECK (commission >= 0),
  fees            NUMERIC DEFAULT 0 CHECK (fees >= 0),

  -- Metadata
  strategy        TEXT,
  tags            TEXT[] DEFAULT '{}',
  notes           TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  currency        TEXT DEFAULT 'USD',

  -- Computed P&L (stored for query performance)
  realized_pnl    NUMERIC GENERATED ALWAYS AS (
    CASE
      WHEN status = 'closed' AND exit_price IS NOT NULL THEN
        CASE side
          WHEN 'long' THEN (exit_price - entry_price) * quantity - COALESCE(commission, 0) - COALESCE(fees, 0)
          WHEN 'short' THEN (entry_price - exit_price) * quantity - COALESCE(commission, 0) - COALESCE(fees, 0)
        END
    END
  ) STORED,

  -- Timestamps
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX idx_trades_user_id ON public.trades(user_id);
CREATE INDEX idx_trades_user_status ON public.trades(user_id, status);
CREATE INDEX idx_trades_user_entry_date ON public.trades(user_id, entry_date DESC);
CREATE INDEX idx_trades_user_symbol ON public.trades(user_id, symbol);

-- Updated_at trigger (reuse if exists from profiles, otherwise create)
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trades_updated_at
  BEFORE UPDATE ON public.trades
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Row Level Security
ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own trades"
  ON public.trades FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own trades"
  ON public.trades FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own trades"
  ON public.trades FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own trades"
  ON public.trades FOR DELETE USING (auth.uid() = user_id);
