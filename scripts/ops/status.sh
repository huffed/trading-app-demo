#!/usr/bin/env bash
# scripts/ops/status.sh — runs ON THE VPS (copied there by `make status`). Read-only.
set -uo pipefail
APP=/opt/quanttrader
echo "host:        $(hostname), up $(uptime -p | sed 's/^up //'), $(date -u +%FT%TZ)"
echo "service:     $(systemctl is-active quanttrader) ($(systemctl is-enabled quanttrader 2> /dev/null)), since $(systemctl show quanttrader -p ActiveEnterTimestamp --value | cut -c1-25), restarts $(systemctl show quanttrader -p NRestarts --value)"
sha=$(git -C "$APP" -c safe.directory="$APP" rev-parse --short=12 HEAD 2> /dev/null || echo "?")
echo "deployed:    $sha; .nvmrc $(cat "$APP/.nvmrc" 2> /dev/null || echo none); $(grep -oE 'node/v[0-9.]+' /etc/systemd/system/quanttrader.service | head -1 || echo 'node: system')"
echo "last deploy: $(tail -n 1 /var/log/quanttrader/deploys.log 2> /dev/null || echo 'no deploys.log yet')"
for name in scan manage heartbeat; do
  line=$(grep 'http=' "/var/log/quanttrader/$name.log" 2> /dev/null | tail -n 1 | cut -c1-60)
  printf '%-13s%s\n' "$name:" "${line:-no log}"
done
echo "reboot:      $([ -f /var/run/reboot-required ] && echo 'REQUIRED (pending kernel/package update)' || echo 'not required')"
echo "disk:        $(df -h / | awk 'NR==2{print $5" used of "$2}')"
echo "crontab:     $(id -un) $(crontab -l 2> /dev/null | grep -c '^[^#]' || true) entries; root $(sudo -n crontab -l 2> /dev/null | grep -c '^[^#]' || echo '?') entries"
