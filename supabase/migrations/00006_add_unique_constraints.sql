-- Add unique constraints across tables to prevent duplicate data.

-- Algorithms: one name per user (prevents confusion when listing)
alter table public.algorithms
  add constraint uq_algorithms_user_name unique (user_id, name);

-- Sentiment cache: one entry per user+ticker+topics per timestamp
-- Use a hash of the topics array to keep the constraint simple
-- In practice, prevent exact duplicate fetches within the same second
alter table public.sentiment_cache
  add constraint uq_sentiment_cache_fetch unique (user_id, ticker, fetched_at);

-- Profiles: email uniqueness (auth.users enforces this, but belt-and-suspenders)
alter table public.profiles
  add constraint uq_profiles_email unique (email);

-- Sentiment cache needs update policy for upsert to work
create policy "Users can update own sentiment cache"
  on public.sentiment_cache for update
  using (auth.uid() = user_id);
