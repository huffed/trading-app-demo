# Cron scripts

Self-hosted cron entrypoints. Each script loads `CRON_SECRET` from `.env.local`,
sends a Bearer-auth request to the local Next.js server, and exits non-zero on
HTTP failure so the cron daemon can flag it.

The Next.js server must be running (`pnpm dev` or `pnpm start`) for the URLs to
resolve. Override the URL with the script's matching env var if you point cron
at a remote host.

| Script | Endpoint | Default cadence | Override |
|---|---|---|---|
| `scan-cron.sh` | `/api/cron/scan-active-algorithms` | hourly | `SCAN_URL` |
| `prune-sentiment-cache-cron.sh` | `/api/admin/prune-sentiment-cache?days=30` | daily | `PRUNE_URL`, `RETENTION_DAYS` |

## Wiring to macOS cron

```bash
crontab -e
```

```cron
# Scan active algorithms every hour
0 * * * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/scan-cron.sh >> /tmp/quanttrader-scan.log 2>&1

# Prune sentiment_cache rows older than 30 days, daily at 04:00 UTC
0 4 * * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/prune-sentiment-cache-cron.sh >> /tmp/quanttrader-prune.log 2>&1
```

Both scripts are idempotent — running them more often than the cadence above is
safe; the underlying endpoints just do less work.

## Adding a new cron entrypoint

1. Add the route under `src/app/api/admin/` or `src/app/api/cron/` and gate it
   with `verifyAdminAuth(request)` from `@/lib/api/admin-auth`.
2. Copy one of the existing scripts and swap the URL / log message.
3. Document the cadence and override env vars in the table above.
4. Add the crontab line in your local `crontab -e` (the entry isn't checked
   into the repo because the absolute path includes `$HOME`).
