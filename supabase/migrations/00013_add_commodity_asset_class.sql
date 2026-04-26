-- Allow 'commodity' as a valid asset_class on algorithms and trades
-- so users can track and build strategies for gold, silver, oil, etc.

ALTER TABLE public.algorithms
  DROP CONSTRAINT IF EXISTS algorithms_asset_class_check;

ALTER TABLE public.algorithms
  ADD CONSTRAINT algorithms_asset_class_check
  CHECK (asset_class IN ('equity', 'option', 'future', 'forex', 'crypto', 'commodity'));

ALTER TABLE public.trades
  DROP CONSTRAINT IF EXISTS trades_asset_class_check;

ALTER TABLE public.trades
  ADD CONSTRAINT trades_asset_class_check
  CHECK (asset_class IN ('equity', 'option', 'future', 'forex', 'crypto', 'commodity'));
