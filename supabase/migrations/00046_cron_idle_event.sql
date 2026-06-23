-- 00046 — cron_idle event for 0-active-algos heartbeat (SG.19)
--
-- The scan-active-algorithms cron + manage-positions cron only wrote
-- scan_completed / manage_tick when there was at least one active algo
-- to walk. With 0 active algos (the demo gap between Phase E + Phase G
-- un-pause) both crons returned silently — no activity_log row, no
-- dashboard heartbeat, and the GitHub Actions dead-man switch
-- (.github/workflows/dead-man.yml → last_scan_tick + last_manage_tick
-- RPCs) treated the silence as "cron is dead" and fired a false alert.
--
-- cron_idle is the explicit "ran, nothing to do" beat. The route picks
-- any user_id (single-operator app) and writes one row per tick with
-- details.cron in ('scan','manage') so each cron's freshness can be
-- isolated.
--
-- Also extends last_scan_tick() / last_manage_tick() to count their
-- respective cron_idle rows: an idle tick is just as valid a sign of
-- cron health as a workful one.

alter table public.activity_log
  drop constraint activity_log_event_type_check;

alter table public.activity_log
  add constraint activity_log_event_type_check
  check (event_type in (
    'scan_started',
    'scan_completed',
    'signal_detected',
    'signal_no_action',
    'position_opened',
    'position_closed',
    'stop_loss_hit',
    'take_profit_hit',
    'error',
    'pair_auto_paused',
    'daily_loss_halt',
    'portfolio_halt',
    'drift_halt',
    'divergence_halt',
    'live_order_placed',
    'live_order_failed',
    'live_order_closed',
    'live_close_failed',
    'scan_overdue',
    'broker_reconciliation_drift',
    'manage_tick',
    'cron_idle'
  ));

-- Replace last_scan_tick() to also count scan-cron idle ticks. The
-- JSONB filter is cheap (no index needed — there are O(100) rows/day
-- at most across both event types).
create or replace function public.last_scan_tick()
returns timestamptz
language sql
security definer
stable
set search_path = public
as $$
  select max(created_at) from public.activity_log
  where event_type = 'scan_completed'
     or (event_type = 'cron_idle' and details ->> 'cron' = 'scan');
$$;

-- Same for the manage cron.
create or replace function public.last_manage_tick()
returns timestamptz
language sql
security definer
stable
set search_path = public
as $$
  select max(created_at) from public.activity_log
  where event_type = 'manage_tick'
     or (event_type = 'cron_idle' and details ->> 'cron' = 'manage');
$$;

-- Permissions: SECURITY DEFINER functions are already callable by anon
-- per their original grants (00039 + 00041); re-issue defensively to
-- ensure replacement didn't drop them.
revoke all on function public.last_scan_tick() from public;
grant execute on function public.last_scan_tick() to anon;
revoke all on function public.last_manage_tick() from public;
grant execute on function public.last_manage_tick() to anon;

notify pgrst, 'reload schema';
