-- Algorithm watchlist: tickers linked to algorithms for monitoring and signal checking

create table public.algorithm_watchlist (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  algorithm_id uuid references public.algorithms(id) on delete cascade not null,
  ticker text not null,
  name text not null default '',
  added_by text not null default 'user' check (added_by in ('user', 'ai', 'csv')),
  notes text,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

-- Indexes
create index idx_watchlist_algorithm_id on public.algorithm_watchlist (algorithm_id);
create index idx_watchlist_user_id on public.algorithm_watchlist (user_id);

-- Prevent duplicate tickers per algorithm
alter table public.algorithm_watchlist
  add constraint uq_watchlist_algorithm_ticker unique (algorithm_id, ticker);

-- Reuse existing updated_at trigger function
create trigger algorithm_watchlist_updated_at
  before update on public.algorithm_watchlist
  for each row execute function update_updated_at();

-- Row Level Security
alter table public.algorithm_watchlist enable row level security;

create policy "Users can view own watchlist items"
  on public.algorithm_watchlist for select
  using (auth.uid() = user_id);

create policy "Users can insert own watchlist items"
  on public.algorithm_watchlist for insert
  with check (auth.uid() = user_id);

create policy "Users can update own watchlist items"
  on public.algorithm_watchlist for update
  using (auth.uid() = user_id);

create policy "Users can delete own watchlist items"
  on public.algorithm_watchlist for delete
  using (auth.uid() = user_id);
