-- 00036 — Track when broker truth (close fill + realized P&L) has been
-- written onto a closed paper_position.
--
-- Background. When *our* engine triggers a close (signal exit, SL hit,
-- TP hit, stagnant cut), `executeLiveExit` calls the broker's
-- closePosition then immediately stamps `broker_close_price` with our
-- LOCAL closePrice. The broker's actual fill — which differs by spread,
-- commission, and swap — is only available after the deal record settles
-- (typically <60s, sometimes longer on MetaApi). The result was that
-- `displayedPnl()` mixed broker-truth entry with our-local exit and
-- under/overstated the broker's realized P&L by the close-side spread.
--
-- This column is the marker that the broker's closed-deal record HAS
-- been fetched and written back. `executeLiveExit` sets it on success;
-- the deferred reconciliation pass in the manage cron picks up rows
-- where it's still NULL and retries `fetchClosedDealForPosition` until
-- the deal lands.
--
-- NULL on closed broker-mirrored rows = needs broker truth fetch.
-- NULL on paper-only / open rows = doesn't apply (never reconciled).

alter table public.paper_positions
  add column if not exists broker_realized_synced_at timestamptz;
