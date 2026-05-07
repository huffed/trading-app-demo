-- 00033 — archive tables for paper_positions / llm_decisions / activity_log
--
-- Created 2026-05-07 evening as part of the fresh-from-zero dashboard
-- reset on the new $50K Swing demo broker. The live tables are emptied
-- (data copied here) so the dashboard's P&L starts at $0 with the new
-- 3-algo stack (v1 4h v2 + Intraday 30m v5 + 15m v5_15m).
--
-- Schema mirrors each original via LIKE INCLUDING DEFAULTS:
--   - All columns + types preserved
--   - Default values preserved (e.g. created_at = now())
--   - NOT NULL constraints preserved
--   - No FK / no PK on original id / no CHECK / no indexes on original
--     columns — archive is decoupled from live
--
-- Each archive table adds:
--   - archive_id  surrogate primary key (allows future re-archives without
--                 colliding with previously-archived rows that share id)
--   - archived_at when the row was moved to archive
--
-- RLS on, scoped to user_id like the originals. Policies are read-only
-- from the user side; the operator does any inserts/deletes via the
-- service-role client.

-- ---------------------------------------------------------------------------
-- paper_positions_archive
-- ---------------------------------------------------------------------------
create table public.paper_positions_archive (
  archive_id  uuid primary key default gen_random_uuid(),
  archived_at timestamptz not null default now(),
  like public.paper_positions including defaults
);

create index idx_pp_archive_user_algo
  on public.paper_positions_archive (user_id, algorithm_id);
create index idx_pp_archive_closed_at
  on public.paper_positions_archive (closed_at desc);
create index idx_pp_archive_archived_at
  on public.paper_positions_archive (archived_at desc);

alter table public.paper_positions_archive enable row level security;

create policy "Users can view own archived positions"
  on public.paper_positions_archive for select
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- llm_decisions_archive
-- ---------------------------------------------------------------------------
create table public.llm_decisions_archive (
  archive_id  uuid primary key default gen_random_uuid(),
  archived_at timestamptz not null default now(),
  like public.llm_decisions including defaults
);

create index idx_lld_archive_user_algo
  on public.llm_decisions_archive (user_id, algorithm_id);
create index idx_lld_archive_created_at
  on public.llm_decisions_archive (created_at desc);
create index idx_lld_archive_archived_at
  on public.llm_decisions_archive (archived_at desc);

alter table public.llm_decisions_archive enable row level security;

create policy "Users can view own archived decisions"
  on public.llm_decisions_archive for select
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- activity_log_archive
-- ---------------------------------------------------------------------------
create table public.activity_log_archive (
  archive_id  uuid primary key default gen_random_uuid(),
  archived_at timestamptz not null default now(),
  like public.activity_log including defaults
);

create index idx_al_archive_user_algo
  on public.activity_log_archive (user_id, algorithm_id);
create index idx_al_archive_created_at
  on public.activity_log_archive (created_at desc);
create index idx_al_archive_archived_at
  on public.activity_log_archive (archived_at desc);

alter table public.activity_log_archive enable row level security;

create policy "Users can view own archived activity"
  on public.activity_log_archive for select
  using (auth.uid() = user_id);
