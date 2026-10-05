-- 00052 — Index + rewrite the dead-man heartbeat RPCs off a full table scan.
--
-- Symptom (2026-10-05): the GitHub dead-man `check-scan-tick` job failed
-- intermittently (~87% of runs) with `curl: (22) ... error: 500` — NOT a
-- stale scan. The failure was in the RPC call itself: `last_scan_tick()`
-- did a Seq Scan over activity_log (109K+ rows, growing), which warm ran
-- ~126ms but, cold on the Supabase free-tier shared instance under load,
-- intermittently exceeded the statement timeout → PostgREST returned 500.
-- `curl -fsS` + `set -e` turned every transient 500 into a hard job
-- failure + alert email, training the operator to ignore the dead-man
-- (the exact alert-fatigue failure the switch exists to avoid).
--
-- Root cause: no index supported `(event_type, created_at)` lookups — the
-- only event_type index is composite with user_id, which these anon RPCs
-- don't filter on. And the scan/manage RPCs' `OR (event_type='cron_idle'
-- AND details->>'cron'=...)` branch defeats a single-column plan.
--
-- Fix: one composite index serving all three heartbeat RPCs, plus a
-- UNION-ALL rewrite of the two OR-functions so each branch is an indexed
-- `max()` (algebraically identical: max over (A OR B) = max(max A, max B),
-- and max() ignores NULL from an empty branch). last_alpha_decay_tick()'s
-- `event_type IN (...)` is already served directly by the new index, so
-- it is left unchanged.

create index if not exists idx_activity_log_event_created
  on public.activity_log (event_type, created_at desc);

create or replace function public.last_scan_tick()
  returns timestamptz
  language sql
  stable
  security definer
  set search_path to 'public'
as $function$
  select max(t) from (
    select max(created_at) as t
    from public.activity_log
    where event_type = 'scan_completed'
    union all
    select max(created_at)
    from public.activity_log
    where event_type = 'cron_idle' and details ->> 'cron' = 'scan'
  ) s;
$function$;

create or replace function public.last_manage_tick()
  returns timestamptz
  language sql
  stable
  security definer
  set search_path to 'public'
as $function$
  select max(t) from (
    select max(created_at) as t
    from public.activity_log
    where event_type = 'manage_tick'
    union all
    select max(created_at)
    from public.activity_log
    where event_type = 'cron_idle' and details ->> 'cron' = 'manage'
  ) s;
$function$;
