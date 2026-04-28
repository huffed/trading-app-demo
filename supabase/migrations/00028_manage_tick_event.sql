-- 00028 — manage_tick event for 5-min cron heartbeat
--
-- The manage-positions cron only logs to activity_log when it has real
-- work (close, SL hit, TP hit, live order op). Silent ticks meant the
-- operator couldn't tell at a glance whether "no log entry for 30 min"
-- meant "cron is dead" or "cron is alive but nothing to do." Adding
-- manage_tick gives a per-algo heartbeat per tick that touches at
-- least one open position.

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
    'manage_tick'
  ));
