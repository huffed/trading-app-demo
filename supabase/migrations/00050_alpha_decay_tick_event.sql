-- 00050 — alpha_decay_tick heartbeat + last_alpha_decay_tick() RPC.
--
-- The G.4 alpha-decay auto-pause cron (daily 09:00 UTC) is a SAFETY NET:
-- it computes rolling 30d/90d Sharpe vs the in-sample baseline and pauses
-- any active algo whose edge has decayed. Before this migration it logged
-- NOTHING on a normal (no-pause) run and nothing at all on a 0-algo run,
-- so a silently-dead alpha-decay cron had no liveness signal — the
-- .github/workflows/dead-man.yml switch watches only scan/manage. During
-- the 2026-07-13→17 outage the alpha-decay cron failed for days unnoticed
-- (E2.25.i security finding). This closes that gap: the route now emits
-- `alpha_decay_tick` on EVERY successful run, and last_alpha_decay_tick()
-- lets the dead-man assert freshness (< 26h, since it runs daily).
--
-- Mirrors the manage_tick / last_manage_tick() pattern (migration 00046).

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
    'cron_idle',
    'alpha_decay_pause',
    'wfo_rules_updated',
    'regime_route_switched',
    'alpha_decay_tick'
  ));

-- Freshness of the alpha-decay safety net. Counts the per-run heartbeat
-- AND the workful pause event (a pause IS a successful run). Anon-exec
-- SECURITY DEFINER so the GitHub-Actions dead-man can call it with only
-- the anon key, exactly like last_manage_tick / last_scan_tick.
create or replace function public.last_alpha_decay_tick()
returns timestamptz
language sql
security definer
stable
set search_path = public
as $$
  select max(created_at) from public.activity_log
  where event_type in ('alpha_decay_tick', 'alpha_decay_pause');
$$;

grant execute on function public.last_alpha_decay_tick() to anon, authenticated;
