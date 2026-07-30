#!/bin/bash
# Local cron entrypoint: G.4 alpha decay monitoring.
#
# Daily 09:00 UTC. Hits /api/cron/alpha-decay, which computes rolling
# 30d / 90d Sharpe for every active algo vs in-sample baseline, and
# AUTO-PAUSES (status='paused' + live_trading_enabled=false) any algo
# whose current Sharpe < 0.5 × baseline sustained across both windows.
# The pause writes an alpha_decay_pause activity_log event so the
# operator has a durable audit trail of WHEN + WHY each pause fired.
#
# Operator manually un-pauses after review (no auto-recovery). A
# false-positive decay should trigger deliberate operator review before
# resumption.
#
# Requires:
#   - `pnpm dev` or `pnpm start` running on localhost:3000
#   - .env.local in the repo root with CRON_SECRET set
#
# Usage: ./scripts/alpha-decay-cron.sh
# To wire to macOS cron, run `crontab -e` and add:
#   0 9 * * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/alpha-decay-cron.sh >> /tmp/quanttrader-alpha-decay.log 2>&1
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

URL="${ALPHA_DECAY_URL:-http://localhost:3000/api/cron/alpha-decay}"
TIMESTAMP="[$(date -u +%FT%TZ)]"

echo "$TIMESTAMP checking alpha decay..."
RESPONSE=$(printf 'Authorization: Bearer %s\n' "$CRON_SECRET" | curl -sS -w "\n%{http_code}" -H @- "$URL" || echo -e "\n000")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

echo "$TIMESTAMP http=$HTTP_CODE body=$BODY"

if [[ "$HTTP_CODE" != "200" ]]; then
  exit 1
fi
