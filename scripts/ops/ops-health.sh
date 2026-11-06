#!/usr/bin/env bash
# scripts/ops/ops-health.sh — daily host summary to the phone (D.4, decision 0009), run from the ops
# crontab at 07:05 UTC from /usr/local/lib/quanttrader/ (installed by the D.4 runbook, so it exists
# whatever commit the checkout holds). One ntfy message: service, crons, the live commit vs the last
# verified one and vs origin/dev (an HTTPS fetch as ops), Node, disk, memory, pending reboot, failed
# units, algorithms the kill switch still holds paused, the last good backup, the last ledger line.
# Priority high only when something needs a hand; "N commits behind dev" is information. Also prunes per-run deploy logs
# older than 30 days. Exit 1 when the push fails or no topic is set.
set -uo pipefail
APP=/opt/quanttrader
LOGDIR=/var/log/quanttrader
STATE=/var/lib/quanttrader
ENV_FILE=$APP/.env.local
envval() { grep -E "^$1=" "$ENV_FILE" 2> /dev/null | head -n 1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }
attention=()
disk=$(df -h / | awk 'NR==2{print $5}')
[ "${disk%\%}" -ge 80 ] && attention+=("disk $disk")
mem=$(free -m | awk '/^Mem:/{printf "%d/%dMB", $3, $2}')
reboot=$([ -f /var/run/reboot-required ] && echo "REQUIRED" || echo "no")
[ "$reboot" = REQUIRED ] && attention+=("reboot pending")
failed=$(systemctl --failed --no-legend --plain 2> /dev/null | awk '{print $1}' | tr '\n' ' ')
[ -n "$failed" ] && attention+=("failed units: $failed")
fetch=ok
git -C "$APP" fetch --quiet origin 2> /dev/null || fetch=FAILED
live=$(cat "$LOGDIR/live.sha" 2> /dev/null || echo "")
running=$(cat "$LOGDIR/running.sha" 2> /dev/null || echo "")
devhead=$(git -C "$APP" rev-parse origin/dev 2> /dev/null || echo "")
behind="?"
if [ -n "$live" ] && [ -n "$devhead" ]; then
  if git -C "$APP" merge-base --is-ancestor "$live" "$devhead" 2> /dev/null; then
    behind=$(git -C "$APP" rev-list --count "$live..$devhead" 2> /dev/null || echo "?")
  else
    attention+=("live ${live:0:7} is not on dev")
  fi
fi
[ -n "$live" ] && [ -n "$running" ] && [ "$live" != "$running" ] && attention+=("live ${live:0:7} ≠ verified ${running:0:7}")
[ "$fetch" = FAILED ] && attention+=("git fetch failed")
service=$(systemctl is-active quanttrader 2> /dev/null || true)
[ "$service" = active ] || attention+=("service $service")
restarts=$(systemctl show quanttrader -p NRestarts --value 2> /dev/null || echo "?")
[ "${restarts:-0}" = 0 ] || attention+=("service restarted $restarts time(s) since its last start")
crons=$(crontab -l 2> /dev/null | grep -c '^[0-9*]' || true)
held=$(grep -c . "$STATE/kill-switch.paused-ids" 2> /dev/null); held=${held:-0}
[ "$held" != 0 ] && attention+=("$held algorithm(s) paused by the kill switch: make unpause")
backup=n/a
if [ -f /usr/local/lib/quanttrader/backup.sh ]; then
  backup=$(cat "$STATE/backup.last-ok" 2> /dev/null || echo none)
  [ -n "$(find "$STATE/backup.last-ok" -mmin -1560 2> /dev/null)" ] || attention+=("no good backup in 26 h")
fi
last=$(tail -n 1 "$LOGDIR/deploys.log" 2> /dev/null | cut -c1-120)
pruned=$(find "$LOGDIR" -maxdepth 1 -name 'deploy-*.log' -mtime +30 -print -delete 2> /dev/null | wc -l | tr -d ' ')
summary="quanttrader-prod $(date -u +%F): service=$service restarts=$restarts crons=$crons live=${live:0:7} verified=${running:0:7} dev=${devhead:0:7} (behind by $behind, fetch $fetch) node=$(node -v 2> /dev/null) disk=$disk mem=$mem reboot=$reboot held-by-kill-switch=$held failed-units=${failed:-none} pruned-deploy-logs=$pruned backup=$backup; last ledger: ${last:-none}"
prio="default"; title="quanttrader-prod daily: OK"
if [ ${#attention[@]} -gt 0 ]; then prio="high"; title="quanttrader-prod daily: ${attention[*]}"; fi
echo "[$(date -u +%FT%TZ)] $summary"
NTFY_TOPIC=$(envval NTFY_TOPIC); NTFY_TOKEN=$(envval NTFY_TOKEN)
[ -n "$NTFY_TOPIC" ] || { echo "ops-health: NTFY_TOPIC unset; logged only" >&2; exit 1; }
if { [ -n "$NTFY_TOKEN" ] && printf 'Authorization: Bearer %s\n' "$NTFY_TOKEN" || printf 'X-Unused: 1\n'; } \
  | curl -fsS --max-time 15 -H @- -H "Title: $title" -H "Priority: $prio" -d "$summary" "https://ntfy.sh/$NTFY_TOPIC" > /dev/null; then
  echo "ops-health: sent ($prio)"
else
  echo "ops-health: push FAILED" >&2; exit 1
fi
