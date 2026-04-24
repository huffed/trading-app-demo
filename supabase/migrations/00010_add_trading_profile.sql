-- Add trading profile JSONB column to profiles table.
-- Stores beginner onboarding wizard answers + derived trading parameters.
-- NULL = wizard not completed or skipped.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS trading_profile JSONB DEFAULT NULL;

COMMENT ON COLUMN public.profiles.trading_profile IS
  'Onboarding wizard answers mapped to trading parameters. NULL = not completed.';
