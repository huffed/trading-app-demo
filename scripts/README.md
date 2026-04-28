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
| Hourly (`0 * * * *`) | `scan-cron.sh` | `/api/cron/scan-active-algorithms` | `/tmp/quanttrader-scan.log` |
| Daily 04:00 UTC (`0 4 * * *`) | `prune-sentiment-cache-cron.sh` | `/api/admin/prune-sentiment-cache?days=30` | `/tmp/quanttrader-prune.log` |

The hourly scan handles entry evaluation; the 5-minute manage tick only
walks open paper positions for SL/TP and signal-based exit checks. This
keeps intraday exit latency at ≤5 minutes without burning quote-API
budget on tickers with no open positions.

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

# Scan active algorithms every hour — entry evaluation
0 * * * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/scan-cron.sh >> /tmp/quanttrader-scan.log 2>&1

# Prune sentiment_cache rows older than 30 days, daily at 04:00 UTC
0 4 * * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/prune-sentiment-cache-cron.sh >> /tmp/quanttrader-prune.log 2>&1
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
