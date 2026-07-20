#!/bin/bash
# Local cron entrypoint: weekly pre-registration expiration sweep.
# Closes SG.3 — operator workflow for the B.2.9 warnings.
#
# Runs validate-preregistration.ts with STRICT_EXPIRED=1 so any expired
# entry causes a non-zero exit (cron flags it on the operator's daily log
# review). WARN_DAYS default (30) flags entries expiring within a month
# so the operator has a runway to re-register or kill before the entry
# silently falls back to default criteria.
#
# Unlike manage-cron.sh / scan-cron.sh, this does NOT hit a Next.js
# endpoint — the validator script loads .env.local directly + reads the
# JSON file synchronously. Works whether or not pnpm dev/start is running.
#
# Recommended cadence: weekly Monday 09:00 UTC (start-of-week operator
# review). The 4 currently-listed entries all expire 2026-09-18, so a
# weekly cadence gives at least 12 ticks of "EXPIRING SOON" warning
# before the actual expiry — ample runway to plan the re-registration
# walk-forward run.
#
# Usage: ./scripts/prereg-expiration-cron.sh
# To wire to macOS cron, run `crontab -e` and add:
#   0 9 * * 1 /Users/jack.jones/Documents/trading-app/demo-1/scripts/prereg-expiration-cron.sh >> /tmp/quanttrader-prereg.log 2>&1
#
# Exit codes (mirrors validate-preregistration.ts):
#   0 — all entries ACTIVE or EXPIRING SOON (warning-only); operator review optional
#   1 — JSON syntax error OR Zod schema validation failure (BAD config — fix immediately)
#   2 — STRICT_EXPIRED=1 + at least one entry EXPIRED (re-register or remove)
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

echo "$TIMESTAMP --- prereg-expiration sweep start ---"
# STRICT_EXPIRED=1: validator exits 2 on any EXPIRED entry → cron flags
#   the non-zero exit on the operator's daily log review.
# WARN_DAYS=30 (default): per-entry "EXPIRING SOON" tag for entries
#   expiring within a month. Override via env if operator wants different
#   lead time (e.g. WARN_DAYS=60 for more runway).
# Use if/else around the script invocation so `set -e` doesn't abort
# before the timestamp log writes.
if STRICT_EXPIRED=1 pnpm dlx tsx scripts/canonical/validate-preregistration.ts; then
  echo "$TIMESTAMP --- prereg-expiration sweep end (rc=0 — all entries valid) ---"
else
  RC=$?
  echo "$TIMESTAMP --- prereg-expiration sweep end (rc=$RC — ACTION NEEDED) ---" >&2
  exit $RC
fi
