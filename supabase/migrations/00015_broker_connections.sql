-- Stores per-user broker connections so the app can pull live account state
-- (balance, equity, positions) and eventually place orders. Credentials are
-- protected by Supabase's at-rest encryption + RLS so only the owning user
-- can read them.

CREATE TABLE public.broker_connections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- User-facing label, e.g. "FTMO Demo $10k"
  label           TEXT NOT NULL,

  -- Which bridge talks to MT5/MT4. Today only "metaapi"; reserved space for
  -- future providers (alpaca, oanda, ctrader, etc.).
  provider        TEXT NOT NULL DEFAULT 'metaapi'
                    CHECK (provider IN ('metaapi', 'alpaca', 'oanda', 'ctrader')),

  -- MetaApi-specific identifiers. For other providers these slots get reused.
  api_token       TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  region          TEXT NOT NULL DEFAULT 'london',

  -- Display-only metadata (not used for auth)
  broker_name     TEXT,            -- e.g. "FTMO"
  server          TEXT,            -- e.g. "FTMO-Demo"
  account_login   TEXT,            -- e.g. "1513222670"

  -- Connection lifecycle
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'active', 'error', 'disabled')),
  last_error      TEXT,
  last_synced_at  TIMESTAMPTZ,

  -- Cached account snapshot — balance, equity, positions count, etc.
  -- Refreshed on demand or by a future background sync job.
  account_snapshot JSONB,

  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX uq_broker_connections_user_label
  ON public.broker_connections (user_id, label);

CREATE INDEX idx_broker_connections_user
  ON public.broker_connections (user_id);

CREATE TRIGGER broker_connections_updated_at
  BEFORE UPDATE ON public.broker_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.broker_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own broker connections"
  ON public.broker_connections FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own broker connections"
  ON public.broker_connections FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own broker connections"
  ON public.broker_connections FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own broker connections"
  ON public.broker_connections FOR DELETE USING (auth.uid() = user_id);
