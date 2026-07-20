#!/bin/bash
# Local cron entrypoint: 6-hourly broker health snapshot.
# Closes SG.9.1 — the live-broker-reality refresh that the SG.9 /reports
# Brokers tab depends on.
#
# What this does
# --------------
# Calls `snapshot-broker-health.ts` which iterates every metaapi
# broker_connections row, calls fetchAccountInfo per connection, and
# writes back last_synced_at + account_snapshot (success) or last_error
# (failure). The SG.9 Brokers tab reads these fields — without this
# cron, they only update when manage/scan crons touch the broker, which
# doesn't happen when all algos are paused.
#
# Per-connection failures are FIRST-CLASS DATA (recorded in last_error),
# not script failures. The wrapper exits 0 even when individual brokers
# fail — that's the whole point: the failure IS the signal.
#
# Exits non-zero only when:
#   - .env.local missing (script can't load Supabase creds)
#   - Supabase unreachable (catastrophic load query failure)
#   - script throws an uncaught exception
#
# Recommended cadence: every 6 hours (00:00, 06:00, 12:00, 18:00 UTC).
# Light enough to stay well inside MetaApi rate limits (4 ticks/day × N
# connections × 1 call/connection = trivial). Heavy enough to surface a
# token-expiry or account-suspension within hours.
#
# Usage: ./scripts/broker-health-snapshot-cron.sh
# To wire to macOS cron, run `crontab -e` and add:
#   0 */6 * * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/broker-health-snapshot-cron.sh >> /tmp/quanttrader-broker-health.log 2>&1
set -euo pipefail

# E2.29 — cron runs with a minimal PATH that omits pnpm/node, so this
# tsx-based cron failed silently with "pnpm: command not found" from
# 2026-07-17 (rc=127) — which is why the dead FTMO account + stale broker
# health went undetected. Restore pnpm + the latest nvm-installed node.
export PATH="$HOME/Library/pnpm:$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1):$PATH"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env.local"
TIMESTAMP="[$(date -u +%FT%TZ)]"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "$TIMESTAMP ERROR: .env.local not found at $ENV_FILE" >&2
  exit 1
fi

cd "$REPO_DIR"

echo "$TIMESTAMP --- broker-health snapshot start ---"
if pnpm dlx tsx scripts/canonical/snapshot-broker-health.ts; then
  echo "$TIMESTAMP --- broker-health snapshot end (rc=0) ---"
else
  RC=$?
  echo "$TIMESTAMP --- broker-health snapshot FAILED (rc=$RC — investigate) ---" >&2
  exit $RC
fi
