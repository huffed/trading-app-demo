-- 00031 — llm_decisions audit trail
--
-- Per-bar LLM-trader decision audit. Foundation for both operator
-- retracing ("what did the LLM see when it bought XAU at $4500?") and
-- Layer 3 in-context reflection ("of your last 10 HH-regime enter_long
-- decisions, X% were profitable" injected at decision time).
--
-- Background: the algorithm's prompt change (v1 → v2) improved aggregate
-- WF outcomes by +61% return / -66% DD, but the regime-flip cohort it
-- was designed to fix actually got slightly worse — and the LLM never
-- emitted explicit "exit" decisions in RANGING bars in either version.
-- That mismatch (outcomes better, mechanism unclear) is unanswerable
-- without queryable per-bar reasoning. The activity_log table already
-- captures engine-level events but not the LLM's full per-bar reasoning,
-- and ad-hoc backtest JSONLs aren't accessible from the dashboard.
--
-- Write paths:
--   live           — src/lib/scan/llm-trader.ts inserts a row after
--                     each LLM call (default for production).
--   backtest       — scripts/llm-trader-backtest.ts opt-in via
--                     PERSIST_DECISIONS_TO_DB=1 (JSONL files remain the
--                     default for ad-hoc backtest analysis).
--   walk_forward   — same opt-in for the WF orchestrator.
--
-- Outcome backfill: when a paper_position closes (manage.ts), we look
-- up the linking decision row(s) by paper_position_id and populate the
-- trade_outcome jsonb. Holds and exits without an opening position
-- never get an outcome.
--
-- Volume: ~6 rows/day/algo in live (4h timeframe). Backtests would add
-- ~1,250 rows per 6×40d WF run when opt-in is enabled — still trivial
-- for Postgres.

create table if not exists public.llm_decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  algorithm_id uuid references public.algorithms(id) on delete cascade not null,
  -- Bar being evaluated (UTC). For 4h algos this is the bar-close timestamp.
  bar_date timestamptz not null,
  -- Provenance
  prompt_version text not null,
  provider text not null,
  model text not null,
  -- Regime as the LLM saw it (D1 HH/LH/RANGING; n/a for thin daily history).
  regime text not null check (regime in ('HH', 'LH', 'RANGING', 'n/a')),
  -- LLM response
  decision text not null check (decision in ('enter_long', 'enter_short', 'hold', 'exit')),
  confidence integer,
  reasoning text,
  -- Full context the LLM saw — structured for query, not just blob.
  -- Keys: daily_bias, recent_bars, dxy, intermarket, position, user_message.
  context jsonb,
  -- Position state at decision time. 'flat' | 'long' | 'short'.
  had_position text not null,
  -- If this decision opened a position, link the row. Null for hold/exit.
  paper_position_id uuid references public.paper_positions(id) on delete set null,
  -- Backfilled when the linked position closes. Schema (when present):
  --   { r_multiple, exit_reason, regime_flipped_during_trade,
  --     exit_regime, hold_bars, realized_pnl, exit_date }
  -- Null until close. Null forever for non-entry decisions.
  trade_outcome jsonb,
  -- Source discriminator: keeps live and backtest data on the same table
  -- without conflating them in queries.
  source text not null check (source in ('live', 'backtest', 'walk_forward')),
  created_at timestamptz default now() not null
);

-- "Decisions" tab on the algorithm detail page reads this index.
create index if not exists llm_decisions_algorithm_bar_idx
  on public.llm_decisions (algorithm_id, bar_date desc);

-- Per-regime / per-decision-type queries (e.g. "all HH enter_long decisions").
create index if not exists llm_decisions_algorithm_regime_decision_idx
  on public.llm_decisions (algorithm_id, regime, decision);

-- Used by the outcome backfill path when a position closes.
create index if not exists llm_decisions_paper_position_idx
  on public.llm_decisions (paper_position_id)
  where paper_position_id is not null;

-- RLS — UI uses the session client; scoped to user_id. Scan engine
-- uses the admin client for live writes (bypasses RLS, intentional).
alter table public.llm_decisions enable row level security;

create policy "users access own llm_decisions" on public.llm_decisions
  for all
  using (auth.uid() = user_id);

comment on table public.llm_decisions is
  'Per-bar LLM-trader decision audit trail. Foundation for operator retracing and Layer 3 in-context reflection.';
