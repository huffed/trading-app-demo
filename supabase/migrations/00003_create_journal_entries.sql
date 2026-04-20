-- Journal entries for trade reflection and market observations
CREATE TABLE public.journal_entries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Content
  title             TEXT NOT NULL,
  content           TEXT NOT NULL DEFAULT '',

  -- Self-reflection
  emotion           TEXT NOT NULL DEFAULT 'neutral'
                      CHECK (emotion IN (
                        'confident', 'disciplined', 'calm', 'neutral',
                        'anxious', 'fearful', 'greedy', 'impulsive', 'frustrated'
                      )),
  self_rating       SMALLINT CHECK (self_rating >= 1 AND self_rating <= 5),

  -- Categorization
  tags              TEXT[] DEFAULT '{}',
  entry_type        TEXT NOT NULL DEFAULT 'reflection'
                      CHECK (entry_type IN (
                        'pre-market', 'reflection', 'review', 'lesson', 'strategy-idea'
                      )),

  -- Trade linking (no FK — graceful if trades deleted)
  linked_trade_ids  UUID[] DEFAULT '{}',

  -- AI analysis (populated in future iteration)
  ai_analysis       TEXT,
  ai_analyzed_at    TIMESTAMPTZ,

  -- Timestamps
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_journal_user_id ON public.journal_entries(user_id);
CREATE INDEX idx_journal_user_created ON public.journal_entries(user_id, created_at DESC);
CREATE INDEX idx_journal_user_emotion ON public.journal_entries(user_id, emotion);
CREATE INDEX idx_journal_user_type ON public.journal_entries(user_id, entry_type);

-- Reuse updated_at trigger function from trades migration
CREATE TRIGGER journal_entries_updated_at
  BEFORE UPDATE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Row Level Security
ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own journal entries"
  ON public.journal_entries FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own journal entries"
  ON public.journal_entries FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own journal entries"
  ON public.journal_entries FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own journal entries"
  ON public.journal_entries FOR DELETE USING (auth.uid() = user_id);
