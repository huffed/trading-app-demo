-- Caches news sentiment API responses to build historical data and reduce API calls.
-- Each row is one fetch: a ticker + optional topics at a point in time.
-- Articles are stored as JSONB so we can replay sentiment conditions against historical data.

create table public.sentiment_cache (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  ticker text not null,
  topics text[] default '{}',
  fetched_at timestamptz default now() not null,
  avg_sentiment numeric not null,
  article_count integer not null,
  bullish_count integer not null,
  bearish_count integer not null,
  articles jsonb not null default '[]',
  topic_distribution jsonb not null default '{}'
);

-- Index for lookups: "get cached sentiment for QBTS from today"
create index idx_sentiment_cache_ticker_date on public.sentiment_cache (ticker, fetched_at desc);
create index idx_sentiment_cache_user on public.sentiment_cache (user_id);

-- RLS: users can only access their own cached data
alter table public.sentiment_cache enable row level security;

create policy "Users can view own sentiment cache"
  on public.sentiment_cache for select
  using (auth.uid() = user_id);

create policy "Users can insert own sentiment cache"
  on public.sentiment_cache for insert
  with check (auth.uid() = user_id);
