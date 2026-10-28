-- 00053 — widen the paper_positions.exit_reason and activity_log.event_type
-- CHECK constraints to the values the live code actually writes.
--
-- Why (review 2026-10-28, Phase 1 safety finding): the live constraint from
-- 00038 allows only {stop_loss, take_profit, exit_signal, manual,
-- stagnant_no_excursion, broker_rejected}, but the engine writes
--   'stagnant_exit'     (src/lib/scan/engine-position-mgmt.ts, E2.25.f rename)
--   'daily_loss_halt'   (src/lib/scan/daily-halt.ts → flatten.ts)
--   'portfolio_halt'    (src/lib/scan/portfolio-halt.ts → flatten.ts)
-- Each of those UPDATEs would be rejected by Postgres. A stagnant close
-- would fail every tick (and, because the stagnant check short-circuits the
-- SL/TP check, the position could never close), and a daily-loss or
-- portfolio halt flatten would fail silently while a close event was logged.
-- Likewise activity_log rejects three event types the code emits
-- ('dll_warning', 'broker_realized_synced', 'live_order_close_failed'),
-- so those audit rows were being dropped.
--
-- Legacy value 'stagnant_no_excursion' is retained so historical rows and
-- the old spelling stay valid. The TypeScript side of this contract is
-- src/types/position.ts EXIT_REASONS and src/types/activity.ts
-- ACTIVITY_EVENT_TYPES, pinned by src/lib/scan/db-check-contract.test.ts.

alter table public.paper_positions
  drop constraint if exists paper_positions_exit_reason_check;

alter table public.paper_positions
  add constraint paper_positions_exit_reason_check
  check (
    exit_reason is null
    or exit_reason in (
      'stop_loss',
      'take_profit',
      'exit_signal',
      'manual',
      'stagnant_no_excursion',
      'stagnant_exit',
      'daily_loss_halt',
      'portfolio_halt',
      'broker_rejected'
    )
  );

alter table public.activity_log
  drop constraint if exists activity_log_event_type_check;

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
    'live_order_close_failed',
    'scan_overdue',
    'broker_reconciliation_drift',
    'broker_realized_synced',
    'manage_tick',
    'cron_idle',
    'alpha_decay_pause',
    'alpha_decay_tick',
    'wfo_rules_updated',
    'regime_route_switched',
    'dll_warning'
  ));
