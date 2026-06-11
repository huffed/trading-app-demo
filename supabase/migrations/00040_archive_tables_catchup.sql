-- 00040 — archive-table schema catch-up. paper_positions gained
-- broker_realized_synced_at (00036) after the archive tables were
-- created (00033); archives must mirror live columns or era archival
-- (delete-returning → insert) fails on column-count mismatch.
--
-- Applied to the live project 2026-06-11 via Supabase MCP, immediately
-- before the old-era archive (38 positions / 1,923 decisions / 17,164
-- activity rows moved; old-era final net −$1,561.44; new era starts at
-- the comboC flip 2026-06-11 10:36 UTC).
alter table public.paper_positions_archive
  add column broker_realized_synced_at timestamptz;
