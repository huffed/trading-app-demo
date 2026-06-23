-- 00049 — regime_route_switched event for the H.6-live-routing path.
--
-- Emitted by the scan engine (entry-open.ts) when an algo's
-- regime_routing config is enabled AND classifyRegime detected a
-- regime AND the override map had an entry for that regime AND
-- at least one override field type-matched the base rules. The
-- event captures (detected_regime, applied_fields, before/after
-- key fields) so the operator has a durable audit trail of which
-- trades used routed parameters vs base parameters.

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
    'regime_route_switched'
  ));
