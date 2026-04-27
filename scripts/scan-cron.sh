#!/bin/bash
# Local cron entrypoint: hits the scan route on the running Next.js server.
#
# Requires:
#   - `pnpm dev` or `pnpm start` running on localhost:3000
#   - .env.local in the repo root with CRON_SECRET set
#
# Usage: ./scripts/scan-cron.sh
# To wire to macOS cron, run `crontab -e` and add:
#   0 * * * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/scan-cron.sh >> /tmp/quanttrader-scan.log 2>&1
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[$(date -u +%FT%TZ)] ERROR: .env.local not found at $ENV_FILE" >&2
  exit 1
fi

# Load CRON_SECRET from .env.local (handles quoted/unquoted values).
CRON_SECRET=$(grep -E '^CRON_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
if [[ -z "$CRON_SECRET" ]]; then
  echo "[$(date -u +%FT%TZ)] ERROR: CRON_SECRET not set in .env.local" >&2
  exit 1
fi

URL="${SCAN_URL:-http://localhost:3000/api/cron/scan-active-algorithms}"
TIMESTAMP="[$(date -u +%FT%TZ)]"

echo "$TIMESTAMP scanning..."
RESPONSE=$(curl -sS -w "\n%{http_code}" -H "Authorization: Bearer $CRON_SECRET" "$URL" || echo -e "\n000")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

echo "$TIMESTAMP http=$HTTP_CODE body=$BODY"

if [[ "$HTTP_CODE" != "200" ]]; then
  exit 1
fi
