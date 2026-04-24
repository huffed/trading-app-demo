-- Persist backtest results per watchlist ticker so they survive navigation
alter table public.algorithm_watchlist
  add column backtest_metrics jsonb;
