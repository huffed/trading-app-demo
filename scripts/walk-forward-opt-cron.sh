#!/bin/bash
# Local cron entrypoint: G.5 walk-forward optimization re-fit.
#
# Monthly, 1st of month at 06:00 UTC. For each active algo, re-runs the
# Layer B 96-variant geometry sweep on the rolling 12-month window
# ending today and proposes parameter updates when best-by-DSR differs
# from current by more than the buffer (default 0.05).
#
# DRY_RUN mode is the default — first 2-3 monthly cycles run dry so the
# operator can verify proposals don't flap month-to-month before letting
# them auto-apply. Flip to live by changing the URL query string in this
# script to `?dry_run=0` after stability is confirmed.
#
# Requires:
#   - `pnpm dev` or `pnpm start` running on localhost:3000
#   - .env.local in the repo root with CRON_SECRET set
#
# Usage: ./scripts/walk-forward-opt-cron.sh
# To wire to macOS cron, run `crontab -e` and add:
#   0 6 1 * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/walk-forward-opt-cron.sh >> /tmp/quanttrader-wfo.log 2>&1
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[$(date -u +%FT%TZ)] ERROR: .env.local not found at $ENV_FILE" >&2
  exit 1
fi

CRON_SECRET=$(grep -E '^CRON_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
if [[ -z "$CRON_SECRET" ]]; then
  echo "[$(date -u +%FT%TZ)] ERROR: CRON_SECRET not set in .env.local" >&2
  exit 1
fi

# DRY_RUN default — change to "?dry_run=0" after 2-3 DRY cycles confirm
# parameters don't flap. The route is conservatively gated: only the
# literal string "0" flips to live mode.
DRY_RUN_QUERY="${WFO_QUERY:-?dry_run=1}"
URL="${WFO_URL:-http://localhost:3000/api/cron/wfo}${DRY_RUN_QUERY}"
TIMESTAMP="[$(date -u +%FT%TZ)]"

echo "$TIMESTAMP running walk-forward-opt (${DRY_RUN_QUERY})..."
RESPONSE=$(printf 'Authorization: Bearer %s\n' "$CRON_SECRET" | curl -sS -w "\n%{http_code}" -H @- "$URL" || echo -e "\n000")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

echo "$TIMESTAMP http=$HTTP_CODE body=$BODY"

if [[ "$HTTP_CODE" != "200" ]]; then
  exit 1
fi
