#!/bin/bash
# Local cron entrypoint: H.5 quarterly research cycle.
#
# Quarterly on 1st of Jan/Apr/Jul/Oct at 07:00 UTC. Hits /api/cron/
# quarterly-cycle which generates the 4-artifact report (feature
# library refresh + alpha library snapshot + decay report + new-
# hypothesis log template) and persists the markdown to
# /tmp/quanttrader-cycles/<cycle_id>-research-cycle.md.
#
# Operator-owned archival: review the file under /tmp/quanttrader-
# cycles/, copy worth-keeping cycles into the repo (e.g. under
# scripts/canonical/cycles/) and commit.
#
# Operator can ALSO curl this URL ad-hoc for an on-demand preview of
# the current cycle's state.
#
# Requires:
#   - `pnpm dev` or `pnpm start` running on localhost:3000
#   - .env.local in the repo root with CRON_SECRET set
#
# Usage: ./scripts/quarterly-research-cycle-cron.sh
# To wire to macOS cron, run `crontab -e` and add:
#   0 7 1 1,4,7,10 * /Users/jack.jones/Documents/trading-app/demo-1/scripts/quarterly-research-cycle-cron.sh >> /tmp/quanttrader-quarterly-cycle.log 2>&1
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

URL="${QUARTERLY_CYCLE_URL:-http://localhost:3000/api/cron/quarterly-cycle}"
TIMESTAMP="[$(date -u +%FT%TZ)]"

echo "$TIMESTAMP running quarterly research cycle..."
RESPONSE=$(curl -sS -w "\n%{http_code}" -H "Authorization: Bearer $CRON_SECRET" "$URL" || echo -e "\n000")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

echo "$TIMESTAMP http=$HTTP_CODE body=$BODY"

if [[ "$HTTP_CODE" != "200" ]]; then
  exit 1
fi
