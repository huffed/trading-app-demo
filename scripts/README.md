# Cron scripts

**Production cron runs on the operator's local macOS machine via the system
`cron` daemon.** Each scheduled script loads `CRON_SECRET` from
`.env.local`, sends a Bearer-auth request to a locally-running Next.js
server, and exits non-zero on HTTP failure so cron flags it.

This is intentional — there's no separate cron host. The trade-off is
that the Mac and the dev server must be up for any scheduled task to
fire. Mac sleep, a closed lid without "prevent sleep on AC", or a
crashed `pnpm dev` all stall the schedule until the next tick.

## Current schedule

The list below mirrors `crontab -l`. The crontab itself isn't checked
into the repo (the absolute path is `$HOME`-specific, varies per
operator), but the schedule should be kept in sync with this table.

| Cadence | Script | Endpoint | Log |
|---|---|---|---|
| Every 5 min (`*/5 * * * *`) | `manage-cron.sh` | `/api/cron/manage-positions` | `/tmp/quanttrader-manage.log` |
| **Every 15 min (`*/15 * * * *`)** | `scan-cron.sh` | `/api/cron/scan-active-algorithms` | `/tmp/quanttrader-scan.log` |
| Daily 04:00 UTC (`0 4 * * *`) | `prune-sentiment-cache-cron.sh` | `/api/admin/prune-sentiment-cache?days=30` | `/tmp/quanttrader-prune.log` |
| Every 20 min (`*/20 * * * *`) | `oanda-positioning-cron.sh` | `/api/admin/snapshot-oanda-positioning?instruments=XAU_USD` | `/tmp/quanttrader-oanda-positioning.log` |

The 15-min scan cadence is chosen to align with bar-close moments
across 15m, 1h, and 4h primary timeframes simultaneously. At `*/15 * *
* *` the cron fires at `:00 :15 :30 :45` past each hour, catching
every 15m bar close within seconds AND every 1h bar close at exactly
`:00`. Previously the scan ran hourly (`0 * * * *`) which meant 15m
signals were missed entirely (3 of every 4 bars) and 1h signals had up
to 60 min latency to entry.

When 1d primary-timeframe algos go live, add a separate daily cron
entry aligned to the daily bar close (00:00 UTC for forex/gold)
rather than scanning at finer granularity than needed (saves
price-cache misses).

The 5-minute manage tick still walks open paper positions for SL/TP
and signal-based exit checks. This keeps intraday exit latency at ≤5
minutes without burning quote-API budget on tickers with no open
positions.

Both scripts are idempotent — running more often than the cadence above
is safe; the underlying endpoints just do less work.

## Pre-requisites

- `.env.local` at the repo root with `CRON_SECRET=...` set.
- A Next.js server running on `localhost:3000` (`pnpm dev` or `pnpm
  start`). Use `pnpm start` for production cron — it's faster and
  doesn't recompile on disk changes.
- macOS Full Disk Access granted to `cron` if the scripts ever read
  files under protected paths (System Settings → Privacy & Security →
  Full Disk Access → add `/usr/sbin/cron`).

## Editing the schedule

```bash
crontab -e
```

Reference entries (swap `/Users/jack.jones/...` for your repo path):

```cron
# Manage open positions every 5 minutes — handles intraday SL/TP + signal exits
*/5 * * * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/manage-cron.sh >> /tmp/quanttrader-manage.log 2>&1

# Scan active algorithms every 15 minutes — entry evaluation aligned to
# 15m and 1h bar closes (00, 15, 30, 45 past each hour)
*/15 * * * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/scan-cron.sh >> /tmp/quanttrader-scan.log 2>&1

# Prune sentiment_cache rows older than 30 days, daily at 04:00 UTC
0 4 * * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/prune-sentiment-cache-cron.sh >> /tmp/quanttrader-prune.log 2>&1

# Snapshot OANDA positioning (XAU_USD by default) every 20 minutes —
# OANDA's positionBook itself only refreshes on a 20-min cadence
*/20 * * * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/oanda-positioning-cron.sh >> /tmp/quanttrader-oanda-positioning.log 2>&1
```

`crontab -l` shows the active list; `crontab -r` removes everything
(careful — there's no confirmation prompt).

## Verifying a job is running

- Tail the log: `tail -f /tmp/quanttrader-scan.log` (or the prune log).
- Each successful run prints `http=200 body=...`.
- Manual smoke test: just run the script directly —
  `./scripts/scan-cron.sh` and check the exit code.

If the log is silent past the expected tick, check:

1. Is `pnpm dev` / `pnpm start` running? (`curl http://localhost:3000`)
2. Is `cron` allowed to run? (macOS sometimes pauses the daemon on
   battery; plug in.)
3. Does the script run by hand? Run it directly to surface the error.

## Adding a new cron entrypoint

1. Add the route under `src/app/api/admin/` or `src/app/api/cron/`.
   Gate it with `verifyAdminAuth(request)` from `@/lib/api/admin-auth`.
2. Copy one of the existing scripts and swap the URL / log message.
   Make it executable: `chmod +x scripts/<new-script>.sh`.
3. Add a row to the **Current schedule** table above with the cadence,
   endpoint, and log path.
4. Add the crontab line via `crontab -e`. Reference it in the
   **Editing the schedule** snippet so future operators copy the right
   command on a fresh machine.

## Operator / research tooling

Non-cron scripts live alongside. Each takes `ALGO_ID` and other env
vars where applicable (`pnpm dlx tsx scripts/<name>.ts`). Run from the
repo root.

| Script | Purpose |
|---|---|
| `inspect-algo.ts` | Generalised backtest re-runner for any algorithm. Optional overlay of trailing stop / breakeven / DXY filter via env vars. Used to validate persisted rules against a fresh corpus. |
| `sweep-dxy-params.ts` | Sweeps DXY filter (lookback × pip_threshold × mode) on an algo's corpus. Output ranks by lowest DD with controlled return drag. |
| `sweep-sl-tp-variants.ts` | Sweeps structural SL/TP (swing_anchor × buffer × rr_multiple) via walk-forward. Used to find regime-adaptive SL/TP configs. |
| `rebuild-gold-stack.ts` | Multi-window validator. Tests strategy candidates against full walk-forward + last 6mo + last 60d. Used when our methodology needed a recency check after deploys disagreed with current regime. |
| `reconcile-broker-close.ts` | Operational fallback when a broker-side close isn't auto-reconciled by the manage cron. Reads MetaApi history-deals, writes the close back to `paper_positions`. |
| `replay-friend-trades.ts` | Replays a CSV of a real trader's trades and scores how often our pattern primitives reproduce their entries (≥30% overlap is the bar before claiming "clone"). Canonical replay tool. |
| `gold-search.ts` | Combinatorial search runner restricted to the gold (XAU/USD) universe. |
| `vet-search-candidates.ts` | Vet candidates emitted by `gold-search` against the long-corpus inspect harness before activation. |
| `dryrun-generate-from-search.ts` | Dry-run wrapper around the algorithm-generation flow seeded from search output. Inspect generated rules without writing the algorithms row. |
