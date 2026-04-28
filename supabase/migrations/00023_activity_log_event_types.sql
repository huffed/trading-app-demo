-- 00023 — Activity log event_type expansion
--
-- The original CHECK constraint (00012) only allowed 9 event types from the
-- early scan engine. Since then the safety stack and live execution layer
-- have shipped 9 more event types that are written via logActivity() but
-- silently rejected by Postgres — every halt, drift, divergence and
-- live-order log entry has been thrown away because logActivity() awaits
-- the insert without checking its error.
--
-- Emitters not yet covered:
--   pair_auto_paused      lib/scan/engine.ts:420
--   daily_loss_halt       lib/scan/daily-halt.ts:108
--   divergence_halt       lib/scan/divergence.ts:93
--   portfolio_halt        lib/scan/portfolio-halt.ts:114
--   drift_halt            lib/scan/drift-detector.ts:165
--   live_order_placed     lib/scan/live-execution.ts:175
--   live_order_failed     lib/scan/live-execution.ts:196
--   live_order_closed     lib/scan/live-execution.ts:231
--   live_close_failed     lib/scan/live-execution.ts:244
--
-- Adding a new event type in code now requires extending this constraint
-- (or a successor migration) — keep the list authoritative.

alter table public.activity_log
  drop constraint activity_log_event_type_check;

alter table public.activity_log
  add constraint activity_log_event_type_check
  check (event_type in (
    -- Scan lifecycle
    'scan_started',
    'scan_completed',
    -- Signal evaluation
    'signal_detected',
    'signal_no_action',
    -- Position lifecycle
    'position_opened',
    'position_closed',
    'stop_loss_hit',
    'take_profit_hit',
    -- Generic
    'error',
    -- Safety stack (added 00023)
    'pair_auto_paused',
    'daily_loss_halt',
    'portfolio_halt',
    'drift_halt',
    'divergence_halt',
    -- Live execution (added 00023)
    'live_order_placed',
    'live_order_failed',
    'live_order_closed',
    'live_close_failed'
  ));
