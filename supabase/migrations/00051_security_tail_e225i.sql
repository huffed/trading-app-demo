-- E2.25.i residual security tail (2026-07-30). Applied via MCP same day.
-- NOTE: last_manage_tick / last_scan_tick / last_alpha_decay_tick stay
-- anon-executable BY DESIGN (GitHub dead-man probes them with anon key).
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon, authenticated, public;
-- Pinned to 'public' (not '') so unqualified refs in bodies keep resolving —
-- '' would break the auth signup trigger.
ALTER FUNCTION public.handle_new_user() SET search_path = 'public';
ALTER FUNCTION public.update_updated_at() SET search_path = 'public';
ALTER FUNCTION public.portfolios_set_updated_at() SET search_path = 'public';
CREATE INDEX IF NOT EXISTS idx_activity_log_position_id ON public.activity_log (position_id);
CREATE INDEX IF NOT EXISTS idx_llm_decisions_user_id ON public.llm_decisions (user_id);
