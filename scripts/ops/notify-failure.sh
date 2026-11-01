#!/usr/bin/env bash
# scripts/ops/notify-failure.sh — run by quanttrader-failure.service (OnFailure= of the app unit).
# Posts one urgent ntfy message naming the failed unit with its last journal lines. NTFY_TOPIC and
# NTFY_TOKEN come from /opt/quanttrader/.env.local on the host and are never printed.
set -uo pipefail
UNIT=${1:-quanttrader}
ENV_FILE=/opt/quanttrader/.env.local
envval() { grep -E "^$1=" "$ENV_FILE" 2> /dev/null | head -n 1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }
NTFY_TOPIC=$(envval NTFY_TOPIC)
NTFY_TOKEN=$(envval NTFY_TOKEN)
[ -n "$NTFY_TOPIC" ] || { echo "notify-failure: NTFY_TOPIC unset; nothing sent"; exit 0; }
tail=$(journalctl -u "$UNIT" -n 8 --no-pager -o cat 2> /dev/null | cut -c1-200 | tr '\n' ' ')
{ [ -n "$NTFY_TOKEN" ] && printf 'Authorization: Bearer %s\n' "$NTFY_TOKEN" || printf 'X-Unused: 1\n'; } \
  | curl -fsS --max-time 15 -H @- -H "Title: quanttrader-prod: $UNIT FAILED" -H "Priority: urgent" -H "Tags: rotating_light" \
    -d "$(hostname) $(date -u +%FT%TZ): systemd reports $UNIT failed. Last lines: ${tail:-none}. make status / make logs LOG=manage N=5" \
    "https://ntfy.sh/$NTFY_TOPIC" > /dev/null && echo "notify-failure: sent" || echo "notify-failure: push FAILED"
