#!/usr/bin/env bash
# scripts/ops/ops-health.sh — daily host summary to the phone (D.4, decision 0009), run from the ops
# crontab at 07:05 UTC. One ntfy message: disk, memory, pending reboot, failed systemd units, the
# running commit vs origin/dev (an HTTPS fetch as ops), whether the kill switch is engaged, and the
# last line of the host deploy ledger. Priority high only when something needs a hand.
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
git -C "$APP" fetch --quiet origin 2> /dev/null || true
running=$(cut -c1-7 "$LOGDIR/running.sha" 2> /dev/null || echo "?")
devhead=$(git -C "$APP" rev-parse --short=7 origin/dev 2> /dev/null || echo "?")
[ "$running" != "$devhead" ] && attention+=("running $running ≠ dev $devhead")
service=$(systemctl is-active quanttrader 2> /dev/null || true)
[ "$service" = active ] || attention+=("service $service")
crons=$(crontab -l 2> /dev/null | grep -c '^[0-9*]' || true)
kill=$([ -s "$STATE/kill-switch.paused-ids" ] && echo "ENGAGED (algorithms paused: $(grep -c . "$STATE/kill-switch.paused-ids"))" || echo "no")
[ "$kill" != no ] && attention+=("kill switch $kill")
last=$(tail -n 1 "$LOGDIR/deploys.log" 2> /dev/null | cut -c1-120)
summary="quanttrader-prod $(date -u +%F): service=$service crons=$crons running=$running dev=$devhead node=$(node -v 2> /dev/null) disk=$disk mem=$mem reboot=$reboot kill-switch=$kill failed-units=${failed:-none}; last ledger: ${last:-none}"
prio="default"; title="quanttrader-prod daily: OK"
if [ ${#attention[@]} -gt 0 ]; then prio="high"; title="quanttrader-prod daily: ${attention[*]}"; fi
echo "[$(date -u +%FT%TZ)] $summary"
NTFY_TOPIC=$(envval NTFY_TOPIC); NTFY_TOKEN=$(envval NTFY_TOKEN)
[ -n "$NTFY_TOPIC" ] || { echo "ops-health: NTFY_TOPIC unset; logged only"; exit 0; }
{ [ -n "$NTFY_TOKEN" ] && printf 'Authorization: Bearer %s\n' "$NTFY_TOKEN" || printf 'X-Unused: 1\n'; } \
  | curl -fsS --max-time 15 -H @- -H "Title: $title" -H "Priority: $prio" -d "$summary" "https://ntfy.sh/$NTFY_TOPIC" > /dev/null \
  && echo "ops-health: sent ($prio)" || echo "ops-health: push FAILED"
