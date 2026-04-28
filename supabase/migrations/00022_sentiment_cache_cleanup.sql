-- 00022 — Sentiment cache cleanup
--
-- Two follow-ups from the codebase audit:
--   1. The original sentiment_cache RLS only allowed SELECT and INSERT
--      (with UPDATE later added in 00006). DELETE was never granted, so
--      old rows can't be pruned by the user — even an admin script
--      running with a user JWT would 0-row the delete.
--   2. The cache had no TTL. We add a helper function + a recommendation
--      to call it from a daily cron. Default retention is 30 days, which
--      is plenty for the 6-hour read TTL the app uses while keeping the
--      table small.

create policy if not exists "Users can delete own sentiment cache"
  on public.sentiment_cache for delete
  using (auth.uid() = user_id);

-- prune_sentiment_cache(retention_days) deletes rows older than the
-- threshold and returns the count removed. SECURITY DEFINER so a cron
-- job invoked via the admin client can call it without RLS getting in
-- the way (the function itself is the gate). Defaults to 30 days.
create or replace function public.prune_sentiment_cache(retention_days int default 30)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  removed int;
begin
  delete from public.sentiment_cache
  where fetched_at < now() - make_interval(days => retention_days);
  get diagnostics removed = row_count;
  return removed;
end;
$$;

-- Restrict execution to the service role; user-scoped clients shouldn't
-- bulk-prune via a function call.
revoke execute on function public.prune_sentiment_cache(int) from public;
revoke execute on function public.prune_sentiment_cache(int) from anon, authenticated;
grant execute on function public.prune_sentiment_cache(int) to service_role;
