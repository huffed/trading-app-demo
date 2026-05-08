-- 00034 — OANDA positioning cache
--
-- Snapshots OANDA's retail client positioning per instrument every ~20
-- min via the v20 REST positionBook endpoint. Used as a contrarian /
-- crowd-sentiment input to the LLM-trader.
--
-- OANDA only exposes the *current* snapshot via API (no historical
-- positioning data). This table builds history forward from the moment
-- the cron starts running — a positioning gate / signal cannot be
-- backtested against historical windows; it has to be validated
-- post-hoc against captured live trades.
--
-- Columns:
--   instrument     OANDA naming, e.g. 'XAU_USD' (NOT 'XAUUSD')
--   oanda_time     snapshot timestamp reported by OANDA itself
--   fetched_at     when our cron made the request (lag visibility)
--   price          spot at snapshot
--   long_pct       sum of longCountPercent across buckets (0..100)
--   short_pct      sum of shortCountPercent across buckets (0..100)
--                  long_pct + short_pct should be ~100
--   bucket_width   price-bucket size used by OANDA for the breakdown
--   buckets        raw bucket array; preserved so we can reanalyse later
--                  without another fetch (price-bucketed distribution
--                  is more informative than the aggregate ratio alone).
--
-- Unique on (instrument, oanda_time) so re-running the cron in the same
-- 20-min window upserts cleanly instead of duplicating.

create table public.oanda_positioning_cache (
  id uuid primary key default gen_random_uuid(),
  instrument text not null,
  oanda_time timestamptz not null,
  fetched_at timestamptz not null default now(),
  price numeric not null,
  long_pct numeric not null,
  short_pct numeric not null,
  bucket_width numeric not null,
  buckets jsonb not null,
  created_at timestamptz not null default now(),
  unique (instrument, oanda_time)
);

create index idx_oanda_positioning_instrument_time
  on public.oanda_positioning_cache (instrument, oanda_time desc);

-- Service-role only. RLS enabled with no policies = denied for anon /
-- authenticated. The admin cron writes via the service-role client; any
-- future user-facing read goes through a server route that re-publishes
-- the latest row.
alter table public.oanda_positioning_cache enable row level security;
