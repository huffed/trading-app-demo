-- Auto-pair-pruning: when a pair underperforms over a meaningful sample
-- (e.g. 0/8 WR like GBP/JPY on testing 3), the system automatically pauses
-- it from the live scan and logs the reason. The user can re-enable
-- manually if they want to override.
alter table algorithm_watchlist
  add column if not exists auto_paused boolean not null default false,
  add column if not exists auto_paused_at timestamp with time zone,
  add column if not exists auto_paused_reason text;

create index if not exists algorithm_watchlist_auto_paused_idx
  on algorithm_watchlist(algorithm_id, auto_paused);
