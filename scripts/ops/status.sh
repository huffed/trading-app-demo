#!/usr/bin/env bash
# scripts/ops/status.sh — runs ON THE VPS, streamed in by `make status` from origin/dev. Read-only.
set -uo pipefail
APP=/opt/quanttrader
LOGDIR=/var/log/quanttrader
echo "host:        $(hostname), up $(uptime -p | sed 's/^up //'), $(date -u +%FT%TZ)"
echo "service:     $(systemctl is-active quanttrader) ($(systemctl is-enabled quanttrader 2> /dev/null)), since $(systemctl show quanttrader -p ActiveEnterTimestamp --value), restarts $(systemctl show quanttrader -p NRestarts --value)"
tree=$(git -C "$APP" -c safe.directory="$APP" rev-parse --short=12 HEAD 2> /dev/null || echo "?")
running=$(cut -c1-12 "$LOGDIR/running.sha" 2> /dev/null || echo "unrecorded (no verified deploy yet)")
live=$(cut -c1-12 "$LOGDIR/live.sha" 2> /dev/null || echo "unrecorded")
echo "checkout:    $tree; live since last restart: $live; verified: $running; .nvmrc $(cat "$APP/.nvmrc" 2> /dev/null || echo none); host node $(node -v 2> /dev/null || echo '?'); unit user $(systemctl show quanttrader -p User --value)"
echo "last deploy: $(tail -n 1 "$LOGDIR/deploys.log" 2> /dev/null || echo 'no deploys.log yet')"
for name in scan manage heartbeat; do # the three ticks the deploy verifies; the other logs: make logs LOG=<name>
  line=$(grep 'http=' "$LOGDIR/$name.log" 2> /dev/null | tail -n 1 | cut -c1-60)
  printf '%-13s%s\n' "$name tick:" "${line:-no log}"
done
echo "reboot:      $([ -f /var/run/reboot-required ] && echo 'REQUIRED (pending kernel/package update)' || echo 'not required')"
echo "disk:        $(df -h / | awk 'NR==2{print $5" used of "$2}')"
root_out=$(sudo -n crontab -u root -l 2>&1 || true)
case "$root_out" in
  *"no crontab for root"*) root_ct=0 ;;
  *sudo*|*password*) root_ct="? (sudo denied)" ;;
  *) root_ct=$(grep -c '^[0-9*]' <<< "$root_out" || true) ;;
esac
echo "crontab:     $(id -un) $(crontab -l 2> /dev/null | grep -c '^[0-9*]' || true) entries; root $root_ct entries (two schedulers = double ticks; after D.2 root must be 0)"
echo "listening:   $(ss -ltn 2> /dev/null | awk '$4 ~ /:3000$/ {print $4}' | tr '\n' ' ')"
echo "tailscale:   $(tailscale serve status 2> /dev/null | head -1 || echo 'no serve config')"
