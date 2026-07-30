#!/bin/bash
# Local cron entrypoint: prunes sentiment_cache rows older than $RETENTION_DAYS
# (default 30) by hitting the admin endpoint on the running Next.js server.
#
# Requires:
#   - `pnpm dev` or `pnpm start` running on localhost:3000
#   - .env.local in the repo root with CRON_SECRET set
#
# Usage: ./scripts/prune-sentiment-cache-cron.sh
# To wire to macOS cron, run `crontab -e` and add a daily entry:
#   0 4 * * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/prune-sentiment-cache-cron.sh >> /tmp/quanttrader-prune.log 2>&1
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

DAYS="${RETENTION_DAYS:-30}"
URL="${PRUNE_URL:-http://localhost:3000/api/admin/prune-sentiment-cache?days=$DAYS}"
TIMESTAMP="[$(date -u +%FT%TZ)]"

echo "$TIMESTAMP pruning sentiment_cache (>$DAYS days)..."
RESPONSE=$(printf 'Authorization: Bearer %s\n' "$CRON_SECRET" | curl -sS -w "\n%{http_code}" -H @- "$URL" || echo -e "\n000")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

echo "$TIMESTAMP http=$HTTP_CODE body=$BODY"

if [[ "$HTTP_CODE" != "200" ]]; then
  exit 1
fi
