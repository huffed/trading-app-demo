-- 00048 — wfo_rules_updated event for the G.5 walk-forward-opt re-fit cron.
--
-- The walk-forward-opt cron (src/lib/algo-search/walk-forward-opt.ts +
-- /api/cron/wfo) runs monthly. For each active algo it re-runs the
-- Layer B 96-variant geometry sweep on a rolling 12-month window
-- ending today and picks the best-by-DSR variant. If the proposed
-- variant has DSR > current + 0.05 buffer AND its parameters differ,
-- it UPDATEs algorithms.rules JSONB (live mode only; DRY_RUN=1 default)
-- and writes this event row recording the before/after geometry + DSR
-- delta. The audit trail is critical because parameters update silently
-- in live mode — operator needs to see exactly when + why a re-fit
-- fired.

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
    'wfo_rules_updated'
  ));
