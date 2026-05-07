-- 00032 — initial_stop_loss_price on paper_positions
--
-- Preserves the SL distance the position was opened with. The existing
-- stop_loss_price column gets MUTATED when the LLM emits a "move_be"
-- decision (entry.ts moves it to entry_price), which destroys the
-- entry-to-SL distance needed to compute R-multiples on close.
--
-- Symptom: every BE-touched trade — including winners that ran on to
-- TP — recorded r_multiple = 0 in llm_decisions.trade_outcome (the
-- defensive `if (risk <= 0) return 0;` branch in computeRMultiple
-- triggers when entry == stop). The audit table silently lost the
-- attribution that the whole reflection-loop infrastructure depends on.
--
-- Fix: write-once column set at insert. Code paths that need 1R
-- (R-multiple computation, halts that gauge "is this a real loss")
-- read this instead of the live stop_loss_price. The live column
-- continues to drive SL-fill checks in manage.ts, since that's the
-- effective SL after BE moves.
--
-- Backfill: copy stop_loss_price into initial_stop_loss_price for any
-- existing rows. Pre-existing BE-moved CLOSED rows have already lost
-- their original SL; their r_multiple stays at 0 (unrecoverable). All
-- non-BE-moved rows get correct values.

alter table public.paper_positions
  add column if not exists initial_stop_loss_price numeric;

update public.paper_positions
  set initial_stop_loss_price = stop_loss_price
  where initial_stop_loss_price is null
    and stop_loss_price is not null;
