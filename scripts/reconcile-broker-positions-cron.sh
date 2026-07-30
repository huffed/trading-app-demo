#!/bin/bash
# Local cron entrypoint: broker↔paper position reconciliation (E2.24.c.iii).
#
# What this does
# --------------
# Calls /api/cron/reconcile-broker-positions, which compares every OPEN
# paper_positions row against the broker's live open positions and emits
# `broker_reconciliation_drift` activity_log events for:
#   - paper_only  : paper thinks it's open, broker has no such position
#                   (the entry-orphan / voided-after-fill class — E2.24.c.i)
#   - broker_only : broker holds a position with no matching open paper row
#                   (the failed-close class — E2.24.c.ii; broker-side SL/TP
#                   still protect it, but it should not linger unseen)
#   - side_mismatch / volume_drift : direction or size divergence
#
# The volume comparison was units-buggy before E2.24.c (paper base-units
# vs broker lots → ~99% false drift on every gold position); now compares
# lots-to-lots via getContractSize, so drift events are real signal.
#
# This is READ-ONLY: it detects + logs, never mutates positions. Alerting
# on the drift events is the dead-man / dashboard's job.
#
# Recommended cadence: every 30 minutes (light — one fetchPositions call
# per broker connection). Wire via `crontab -e`:
#   */30 * * * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/reconcile-broker-positions-cron.sh >> /tmp/quanttrader-reconcile.log 2>&1
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env.local"
TIMESTAMP="[$(date -u +%FT%TZ)]"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "$TIMESTAMP ERROR: .env.local not found at $ENV_FILE" >&2
  exit 1
fi

CRON_SECRET=$(grep -E '^CRON_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
if [[ -z "$CRON_SECRET" ]]; then
  echo "$TIMESTAMP ERROR: CRON_SECRET not set in .env.local" >&2
  exit 1
fi

URL="${RECONCILE_URL:-http://localhost:3000/api/cron/reconcile-broker-positions}"

echo "$TIMESTAMP reconciling broker↔paper positions..."
RESPONSE=$(printf 'Authorization: Bearer %s\n' "$CRON_SECRET" | curl -sS -w "\n%{http_code}" -H @- "$URL" || echo -e "\n000")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

echo "$TIMESTAMP http=$HTTP_CODE body=$BODY"

if [[ "$HTTP_CODE" != "200" ]]; then
  exit 1
fi
