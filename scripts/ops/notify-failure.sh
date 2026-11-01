#!/usr/bin/env bash
# scripts/ops/notify-failure.sh — ExecStopPost= hook of quanttrader.service (installed to
# /usr/local/lib/quanttrader/ by the D.4 runbook so it exists whatever commit the checkout holds).
# systemd runs it after every stop with SERVICE_RESULT / EXIT_CODE / EXIT_STATUS in the
# environment. A clean stop (a deploy's restart, the kill switch) is "success" and sends nothing;
# anything else pushes one urgent ntfy message, at most one every 10 minutes so a crash loop
# (Restart=always restarts every 5 s) does not flood the phone. The topic comes from the app's
# env file and is never printed. Exit 1 when a push was due and failed or no topic is set.
set -uo pipefail
UNIT=${1:-quanttrader}
ENV_FILE=/opt/quanttrader/.env.local
STAMP=/var/lib/quanttrader/notify-failure.last
result=${SERVICE_RESULT:-unknown}
[ "$result" = success ] && exit 0
now=$(date +%s)
last=$(cat "$STAMP" 2> /dev/null || echo 0)
if [ $((now - last)) -lt 600 ]; then echo "notify-failure: $UNIT $result (exit ${EXIT_CODE:-?}/${EXIT_STATUS:-?}); last push <10 min ago, not repeating"; exit 0; fi
envval() { grep -E "^$1=" "$ENV_FILE" 2> /dev/null | head -n 1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }
NTFY_TOPIC=$(envval NTFY_TOPIC)
NTFY_TOKEN=$(envval NTFY_TOKEN)
[ -n "$NTFY_TOPIC" ] || { echo "notify-failure: $UNIT $result (exit ${EXIT_CODE:-?}/${EXIT_STATUS:-?}); NTFY_TOPIC unset, nothing sent" >&2; exit 1; }
msg="$(hostname) $(date -u +%FT%TZ): $UNIT stopped with result=$result exit=${EXIT_CODE:-?}/${EXIT_STATUS:-?}. systemd restarts it every 5 s (Restart=always); if this repeats, the app is crash-looping: make status; make logs LOG=manage N=5; journalctl -u $UNIT -n 50"
if { [ -n "$NTFY_TOKEN" ] && printf 'Authorization: Bearer %s\n' "$NTFY_TOKEN" || printf 'X-Unused: 1\n'; } \
  | curl -fsS --max-time 15 -H @- -H "Title: quanttrader-prod: $UNIT $result" -H "Priority: urgent" -H "Tags: rotating_light" -d "$msg" "https://ntfy.sh/$NTFY_TOPIC" > /dev/null; then
  echo "$now" > "$STAMP" 2> /dev/null || true
  echo "notify-failure: sent ($result)"
else
  echo "notify-failure: push FAILED ($result)" >&2
  exit 1
fi
