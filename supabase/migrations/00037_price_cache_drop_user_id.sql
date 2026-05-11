-- Drop user_id from price_cache: bar data isn't user-specific (XAU/USD bars
-- are identical for everyone), and the user-scoped RLS was silently blocking
-- the cron path from reading or writing the cache. Re-shape as a global
-- table keyed on (ticker, output_size, interval).
--
-- The cron HTTP route has no auth session, so the user-scoped RLS policies
-- on this table caused:
--   - getCachedPrices: RLS hides all rows on anonymous reads → always null
--   - savePricesToCache: explicit `if (!user) return` early-exit → silent skip
-- Result: 800+ unnecessary Twelve Data fetches/day, cache stuck at the
-- last user-context write (2026-05-07 in our case).

-- 1. Collapse per-user duplicates: keep the most-recent fetched_at per
--    (ticker, output_size, interval), drop the rest. With a single
--    operator there shouldn't actually be duplicates, but this is safe
--    regardless of how many users exist.
DELETE FROM public.price_cache p
USING public.price_cache q
WHERE p.ticker = q.ticker
  AND p.output_size = q.output_size
  AND p.interval = q.interval
  AND p.fetched_at < q.fetched_at;

-- 2. Replace the user-scoped unique constraint + indexes.
ALTER TABLE public.price_cache
  DROP CONSTRAINT IF EXISTS uq_price_cache_ticker_interval;

DROP INDEX IF EXISTS idx_price_cache_user;

-- 3. Drop the FK + user_id column. CASCADE removes the policies that
--    reference user_id (re-created below with the new semantics).
ALTER TABLE public.price_cache
  DROP CONSTRAINT IF EXISTS price_cache_user_id_fkey;

DROP POLICY IF EXISTS "Users can view own price cache" ON public.price_cache;
DROP POLICY IF EXISTS "Users can insert own price cache" ON public.price_cache;
DROP POLICY IF EXISTS "Users can update own price cache" ON public.price_cache;

ALTER TABLE public.price_cache
  DROP COLUMN IF EXISTS user_id;

-- 4. New global uniqueness.
ALTER TABLE public.price_cache
  ADD CONSTRAINT uq_price_cache_global
    UNIQUE (ticker, output_size, interval);

-- 5. RLS stays on. Any authenticated user can read the shared cache
--    (bar data isn't sensitive — it's the same data Twelve Data serves
--    publicly with an API key). Writes are deliberately not granted to
--    any role here; the cron + server actions use the service-role
--    client which bypasses RLS, so writes funnel through trusted server
--    paths only.
CREATE POLICY "Authenticated can view price cache"
  ON public.price_cache FOR SELECT
  TO authenticated
  USING (true);
