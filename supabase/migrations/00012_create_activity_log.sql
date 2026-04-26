-- Activity log — append-only record of scan events, signals, and position changes.

CREATE TABLE public.activity_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  algorithm_id    UUID REFERENCES public.algorithms(id) ON DELETE SET NULL,
  position_id     UUID REFERENCES public.paper_positions(id) ON DELETE SET NULL,

  -- Event classification
  event_type      TEXT NOT NULL CHECK (event_type IN (
    'scan_started', 'scan_completed',
    'signal_detected', 'signal_no_action',
    'position_opened', 'position_closed',
    'stop_loss_hit', 'take_profit_hit',
    'error'
  )),

  -- Context
  ticker          TEXT,
  details         JSONB DEFAULT '{}',

  created_at      TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_activity_log_user_created
  ON public.activity_log (user_id, created_at DESC);

CREATE INDEX idx_activity_log_algorithm_created
  ON public.activity_log (algorithm_id, created_at DESC);

CREATE INDEX idx_activity_log_user_event
  ON public.activity_log (user_id, event_type);

-- RLS — append-only: SELECT + INSERT only
ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own activity"
  ON public.activity_log FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own activity"
  ON public.activity_log FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Add last_scanned_at to algorithms table
ALTER TABLE public.algorithms ADD COLUMN last_scanned_at TIMESTAMPTZ;
