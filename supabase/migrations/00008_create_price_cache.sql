-- Cache Alpha Vantage price data to avoid burning 25 req/day quota on repeat backtests

create table public.price_cache (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  ticker text not null,
  output_size text not null default 'compact',
  bars jsonb not null default '[]',
  bar_count integer not null default 0,
  fetched_at timestamptz default now() not null
);

create index idx_price_cache_ticker on public.price_cache (ticker, output_size);
create index idx_price_cache_user on public.price_cache (user_id);

-- One cached response per user + ticker + output_size
alter table public.price_cache
  add constraint uq_price_cache_ticker unique (user_id, ticker, output_size);

alter table public.price_cache enable row level security;

create policy "Users can view own price cache"
  on public.price_cache for select
  using (auth.uid() = user_id);

create policy "Users can insert own price cache"
  on public.price_cache for insert
  with check (auth.uid() = user_id);

create policy "Users can update own price cache"
  on public.price_cache for update
  using (auth.uid() = user_id);
