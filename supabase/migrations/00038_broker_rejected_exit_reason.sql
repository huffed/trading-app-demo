-- 00038 — broker_rejected exit reason
--
-- Adds a new exit_reason value for paper positions that were rolled
-- back because the broker rejected the order (e.g. market closed on
-- weekends, margin too low, instrument suspended, etc.). Before this
-- fix, the catch block in executeLiveEntry left the paper_positions
-- row open with status='open' but no broker_position_id, so the
-- manage cron treated it as a real live position and eventually
-- "triggered" paper SL/TP hits against an exposure that never existed.
--
-- Bug surfaced 2026-05-18: a Saturday 00:00 UTC entry from Gold Swing
-- 4h was rejected by MetaApi with TRADE_RETCODE_MARKET_CLOSED. The
-- position remained open in the DB and "lost" -$441 two days later
-- via paper-only SL math with zero real exposure.
--
-- The executeLiveEntry catch block now closes the paper_positions row
-- with exit_reason='broker_rejected', realized_pnl=0, closed_at=now,
-- and the broker rejection message captured in broker_error. This
-- lets analytics filter out voided positions cleanly and prevents
-- the manage cron from acting on them.

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
      'broker_rejected'
    )
  );
