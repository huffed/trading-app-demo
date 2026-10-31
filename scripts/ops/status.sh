#!/usr/bin/env bash
# scripts/ops/status.sh — runs ON THE VPS, streamed in by `make status` from origin/dev. Read-only.
set -uo pipefail
APP=/opt/quanttrader
LOGDIR=/var/log/quanttrader
echo "host:        $(hostname), up $(uptime -p | sed 's/^up //'), $(date -u +%FT%TZ)"
echo "service:     $(systemctl is-active quanttrader) ($(systemctl is-enabled quanttrader 2> /dev/null)), since $(systemctl show quanttrader -p ActiveEnterTimestamp --value), restarts $(systemctl show quanttrader -p NRestarts --value)"
tree=$(git -C "$APP" -c safe.directory="$APP" rev-parse --short=12 HEAD 2> /dev/null || echo "?")
running=$(cut -c1-12 "$LOGDIR/running.sha" 2> /dev/null || echo "unrecorded (no verified deploy yet)")
echo "checkout:    $tree; verified running: $running; .nvmrc $(cat "$APP/.nvmrc" 2> /dev/null || echo none); unit node $(grep -oE 'node/v[0-9.]+' /etc/systemd/system/quanttrader.service | head -1 | cut -d/ -f2 || echo 'system')"
echo "last deploy: $(tail -n 1 "$LOGDIR/deploys.log" 2> /dev/null || echo 'no deploys.log yet')"
for name in scan manage heartbeat; do # the three ticks the deploy verifies; the other logs: make logs LOG=<name>
  line=$(grep 'http=' "$LOGDIR/$name.log" 2> /dev/null | tail -n 1 | cut -c1-60)
  printf '%-13s%s\n' "$name tick:" "${line:-no log}"
done
echo "reboot:      $([ -f /var/run/reboot-required ] && echo 'REQUIRED (pending kernel/package update)' || echo 'not required')"
echo "disk:        $(df -h / | awk 'NR==2{print $5" used of "$2}')"
echo "crontab:     $(id -un) $(crontab -l 2> /dev/null | grep -c '^[^#]' || true) entries; root $(sudo -n crontab -l 2> /dev/null | grep -c '^[^#]' || echo '?') entries"
