-- 00041 — anon-executable scan freshness probe for the GitHub Actions
-- dead-man switch (.github/workflows/dead-man.yml). Parallels
-- last_manage_tick() from 00039: exposes exactly ONE timestamp (latest
-- scan_completed) and nothing else; activity_log stays RLS-closed to
-- anon.
--
-- Why a second probe: manage_tick alone doesn't catch a scan-only
-- outage. The manage cron and scan cron are separate launchd/cron
-- entries; either can die without the other. 2026-06-15: scan cron
-- silently stopped at 18:45 UTC while manage_tick kept firing every
-- 5 min — the heartbeat dead-man stayed green, the flagship missed
-- its 20:00 UTC 4h bar-close LLM evaluation. This RPC + its dead-man
-- job catches that case.

create or replace function public.last_scan_tick()
returns timestamptz
language sql
security definer
stable
set search_path = public
as $$
  select max(created_at) from public.activity_log where event_type = 'scan_completed';
$$;

revoke all on function public.last_scan_tick() from public;
grant execute on function public.last_scan_tick() to anon;

notify pgrst, 'reload schema';
