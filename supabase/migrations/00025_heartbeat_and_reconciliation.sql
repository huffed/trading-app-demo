-- 00025 — Heartbeat + broker reconciliation infrastructure
--
-- Wave 3 adds two new cron routes that need DB support:
--
--   /api/cron/heartbeat → emits scan_overdue when an active algorithm's
--     last_scanned_at is stale. Filters on (status='active' AND
--     last_scanned_at < threshold), so we want an index there.
--
--   /api/cron/reconcile-broker-positions → emits broker_reconciliation_drift
--     when the broker's open positions differ from paper_positions.
--
-- Both event types need to be allowed by the activity_log CHECK constraint
-- (00023 widened it but didn't anticipate these). Adding them now keeps
-- logActivity() honest — without this the same silent-drop bug we just
-- fixed in 00023 would re-emerge.

create index if not exists idx_algorithms_active_last_scanned
  on public.algorithms (last_scanned_at)
  where status = 'active';

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
    'broker_reconciliation_drift'
  ));
