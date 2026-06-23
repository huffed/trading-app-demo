-- 00047 — alpha_decay_pause event for the G.4 auto-pause path.
--
-- The alpha-decay cron (src/lib/cohort/alpha-decay.ts +
-- /api/cron/alpha-decay) computes rolling 30d / 90d Sharpe per live
-- algo against the in-sample baseline (algorithms.backtest_results.
-- sharpe_ratio). When BOTH windows agree current Sharpe < 0.5 × baseline
-- (≥30 days sustained low alpha), it sets algorithms.status='paused' +
-- live_trading_enabled=false and writes this event so the operator
-- has an audit trail of WHEN + WHY the auto-pause fired.
--
-- We intentionally do NOT log warn-severity events daily (would create
-- churn — the /reports drift tab surfaces warn state from a live read).
-- Only the state-transition into auto-pause is durable.

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
    'alpha_decay_pause'
  ));
