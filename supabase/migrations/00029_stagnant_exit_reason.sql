-- 00029 — stagnant_no_excursion exit reason
--
-- Adds a new exit_reason value for the stagnant-loser early exit gate.
-- Trades cut by the gate are recorded with exit_reason =
-- 'stagnant_no_excursion' so analytics + UI can distinguish them from
-- stop-loss hits, take-profit hits, signal exits, and manual closes.

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
      'stagnant_no_excursion'
    )
  );
