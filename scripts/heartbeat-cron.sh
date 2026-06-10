#!/bin/bash
# Local cron entrypoint: dead-man's switch for the whole trading pipeline.
#
# Hits the heartbeat route (which detects stale algo scans) and, ONLY when
# the result is fully healthy (HTTP 200 + zero stale algos), pings
# HEARTBEAT_PING_URL — an inverted uptime monitor (healthchecks.io free
# tier, or an UptimeRobot heartbeat monitor). The monitor alerts when pings
# STOP arriving, which catches every failure mode in one signal: Mac
# asleep, dev server down, cron daemon dead, Supabase paused/erroring, or
# the scan cron silently stale.
#
# Incident this exists for (2026-06-10 review): the Mac cron died
# 2026-05-24 unnoticed; weeks of zero DB traffic led Supabase's free tier
# to auto-pause the project. A dead-man alert would have flagged it within
# minutes.
#
# Requires:
#   - `pnpm dev` or `pnpm start` running on localhost:3000
#   - .env.local in the repo root with CRON_SECRET set
#   - optional: HEARTBEAT_PING_URL in .env.local (no ping sent if unset)
#
# Usage: ./scripts/heartbeat-cron.sh
# To wire to macOS cron, run `crontab -e` and add:
#   */5 * * * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/heartbeat-cron.sh >> /tmp/quanttrader-heartbeat.log 2>&1
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

HEARTBEAT_PING_URL=$(grep -E '^HEARTBEAT_PING_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)

URL="${HEARTBEAT_URL:-http://localhost:3000/api/cron/heartbeat}"
TIMESTAMP="[$(date -u +%FT%TZ)]"

RESPONSE=$(curl -sS -w "\n%{http_code}" -H "Authorization: Bearer $CRON_SECRET" "$URL" || echo -e "\n000")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

echo "$TIMESTAMP http=$HTTP_CODE body=$BODY"

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "$TIMESTAMP unhealthy (server/auth failure) — withholding dead-man ping"
  exit 1
fi

# Parse stale_count from the route's JSON without a jq dependency.
STALE_COUNT=$(echo "$BODY" | grep -o '"stale_count":[0-9]*' | head -1 | cut -d: -f2)
if [[ "${STALE_COUNT:-missing}" != "0" ]]; then
  echo "$TIMESTAMP unhealthy (stale_count=${STALE_COUNT:-unparseable}) — withholding dead-man ping"
  exit 1
fi

if [[ -n "$HEARTBEAT_PING_URL" ]]; then
  if curl -fsS -m 10 "$HEARTBEAT_PING_URL" >/dev/null; then
    echo "$TIMESTAMP healthy — dead-man ping sent"
  else
    echo "$TIMESTAMP healthy locally but dead-man ping FAILED (network?)" >&2
    exit 1
  fi
else
  echo "$TIMESTAMP healthy — HEARTBEAT_PING_URL not set, no ping sent"
fi
