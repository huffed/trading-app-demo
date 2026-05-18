#!/bin/bash
# Local cron entrypoint: snapshots OANDA positioning into
# oanda_positioning_cache by hitting the admin endpoint on the running
# Next.js server. Designed to run every 20 min — OANDA's positionBook
# only refreshes on that cadence, so polling tighter wastes calls.
#
# Requires:
#   - `pnpm dev` or `pnpm start` running on localhost:3000
#   - .env.local in the repo root with CRON_SECRET and OANDA_API_KEY set
#
# Usage: ./scripts/oanda-positioning-cron.sh
# Override instruments via env: INSTRUMENTS="XAU_USD,EUR_USD"
# To wire to macOS cron, run `crontab -e` and add:
#   */20 * * * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/oanda-positioning-cron.sh >> /tmp/quanttrader-oanda-positioning.log 2>&1
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

INSTRUMENTS="${INSTRUMENTS:-XAU_USD}"
URL="${OANDA_POSITIONING_URL:-http://localhost:3000/api/admin/snapshot-oanda-positioning?instruments=$INSTRUMENTS}"
TIMESTAMP="[$(date -u +%FT%TZ)]"

echo "$TIMESTAMP snapshotting oanda positioning ($INSTRUMENTS)..."
RESPONSE=$(curl -sS -w "\n%{http_code}" -H "Authorization: Bearer $CRON_SECRET" "$URL" || echo -e "\n000")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

echo "$TIMESTAMP http=$HTTP_CODE body=$BODY"

if [[ "$HTTP_CODE" != "200" ]]; then
  exit 1
fi
