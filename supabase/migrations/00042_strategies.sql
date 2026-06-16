-- 00042 — strategy umbrellas (A1 of A1-A2-A4 staged rollout).
--
-- One strategy row per "family" (e.g. FVG-DailyBias, Dip-Buyer,
-- Coil-Breakout). Each algorithm instance points to its strategy via
-- nullable FK; instance-level rules continue to override strategy-level
-- rules_template via deep-merge at scan time.
--
-- This migration is PURELY ADDITIVE — no behavior change. Strategy
-- consumption (merged rules at scan time) is A3 (deferred). UI grouping
-- + cohort report by strategy is A4 (separate PR).
--
-- Status + live_trading_enabled exist at BOTH levels:
--   - strategy.status / strategy.live_trading_enabled are defaults
--   - algorithm.status / algorithm.live_trading_enabled override per-instance
-- This lets you flip "all FVG-DailyBias paper → live" at the umbrella
-- (A4 UI) while keeping per-instance override for slow-promote workflows.

create table public.strategies (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,

  -- Metadata
  name                  text not null,
  description           text not null default '',

  -- Shared rules template. Per-instance algorithms.rules JSONB
  -- overrides this via deep-merge at scan time (A3, deferred).
  -- Examples of what lives here: entry_conditions, entry_logic,
  -- take_profit (when shared across instances), stagnant_exit,
  -- prop_firm envelope. What stays per-instance: instrument-specific
  -- geometry (stop_loss varies between gold sa-0.10/4 and forex
  -- pct-0.30), per-instance gates, watchlist.
  rules_template        jsonb not null default '{}',

  -- Umbrella defaults — algorithm.status / algorithm.live_trading_enabled
  -- override per-instance.
  status                text not null default 'draft'
                          check (status in ('draft', 'active', 'paused', 'archived')),

  -- Timestamps
  created_at            timestamptz default now() not null,
  updated_at            timestamptz default now() not null
);

-- Unique strategy name per user.
alter table public.strategies
  add constraint uq_strategies_user_name unique (user_id, name);

-- Indexes
create index idx_strategies_user_id on public.strategies (user_id);
create index idx_strategies_user_status on public.strategies (user_id, status);

-- Reuse existing updated_at trigger.
create trigger strategies_updated_at
  before update on public.strategies
  for each row execute function public.update_updated_at();

-- Row Level Security — mirror algorithms table.
alter table public.strategies enable row level security;

create policy "Users can view own strategies"
  on public.strategies for select using (auth.uid() = user_id);

create policy "Users can insert own strategies"
  on public.strategies for insert with check (auth.uid() = user_id);

create policy "Users can update own strategies"
  on public.strategies for update using (auth.uid() = user_id);

create policy "Users can delete own strategies"
  on public.strategies for delete using (auth.uid() = user_id);

-- Algorithms gain nullable strategy_id FK. Null = standalone algo
-- (back-compat). Once A2 runs, all 15 deployed library algos will be
-- linked to their strategy; new algos can be created standalone or
-- under a strategy as preferred.
--
-- on delete: SET NULL — deleting a strategy doesn't delete its
-- instances; they become standalone. Operator decides whether to
-- re-link or archive them.
alter table public.algorithms
  add column strategy_id uuid references public.strategies(id) on delete set null;

create index idx_algorithms_strategy_id on public.algorithms (strategy_id);
