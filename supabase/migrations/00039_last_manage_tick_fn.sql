-- 00039 — anon-executable heartbeat probe for the GitHub Actions
-- dead-man switch (.github/workflows/dead-man.yml). Exposes exactly ONE
-- timestamp (latest manage_tick) and nothing else; activity_log itself
-- stays RLS-closed to anon.
--
-- Applied to the live project 2026-06-10 via Supabase MCP (alongside
-- 00034, which had never been applied — the OANDA positioning pipeline
-- collected zero data 2026-05-08 → 2026-06-10 because of that).

create or replace function public.last_manage_tick()
returns timestamptz
language sql
security definer
stable
set search_path = public
as $$
  select max(created_at) from public.activity_log where event_type = 'manage_tick';
$$;

revoke all on function public.last_manage_tick() from public;
grant execute on function public.last_manage_tick() to anon;

notify pgrst, 'reload schema';
