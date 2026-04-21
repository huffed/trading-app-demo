-- AI-generated trading algorithms
CREATE TABLE public.algorithms (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Metadata
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',

  -- User preferences
  asset_class       TEXT NOT NULL DEFAULT 'equity'
                      CHECK (asset_class IN ('equity', 'option', 'future', 'forex', 'crypto')),
  risk_level        TEXT NOT NULL DEFAULT 'moderate'
                      CHECK (risk_level IN ('conservative', 'moderate', 'aggressive')),
  time_horizon      TEXT NOT NULL DEFAULT '1d',
  capital           NUMERIC NOT NULL DEFAULT 10000 CHECK (capital > 0),
  user_hints        TEXT,

  -- AI-generated
  rules             JSONB NOT NULL DEFAULT '{}',
  ai_analysis       TEXT,
  backtest_results  JSONB,

  -- Status
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'active', 'paused', 'archived')),

  -- Timestamps
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_algorithms_user_id ON public.algorithms(user_id);
CREATE INDEX idx_algorithms_user_status ON public.algorithms(user_id, status);
CREATE INDEX idx_algorithms_user_created ON public.algorithms(user_id, created_at DESC);

-- Reuse updated_at trigger
CREATE TRIGGER algorithms_updated_at
  BEFORE UPDATE ON public.algorithms
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Row Level Security
ALTER TABLE public.algorithms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own algorithms"
  ON public.algorithms FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own algorithms"
  ON public.algorithms FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own algorithms"
  ON public.algorithms FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own algorithms"
  ON public.algorithms FOR DELETE USING (auth.uid() = user_id);
