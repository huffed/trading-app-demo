-- Add `interval` to price_cache so we can cache intraday bars (1h, 4h)
-- alongside daily bars without colliding on the unique key.

ALTER TABLE public.price_cache
  ADD COLUMN IF NOT EXISTS interval TEXT NOT NULL DEFAULT '1day'
    CHECK (interval IN ('1h', '4h', '1day'));

-- The old (user, ticker, output_size) constraint becomes (user, ticker, output_size, interval).
ALTER TABLE public.price_cache
  DROP CONSTRAINT IF EXISTS uq_price_cache_ticker;

ALTER TABLE public.price_cache
  ADD CONSTRAINT uq_price_cache_ticker_interval
    UNIQUE (user_id, ticker, output_size, interval);

CREATE INDEX IF NOT EXISTS idx_price_cache_ticker_interval
  ON public.price_cache (ticker, output_size, interval);
