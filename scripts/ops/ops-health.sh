#!/usr/bin/env bash
# scripts/ops/ops-health.sh — daily host summary to the phone (D.4, decision 0009), run from the ops
# crontab at 07:05 UTC from /usr/local/lib/quanttrader/ (installed by the D.4 runbook, so it exists
# whatever commit the checkout holds). One ntfy message: service, crons, the live commit vs the last
# verified one and vs origin/dev (an HTTPS fetch as ops), Node, disk, memory, pending reboot, failed
# units, algorithms the kill switch still holds paused, watchlist pairs auto-paused on an active algorithm, the
# last good backup, the last ledger line.
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
# Watchlist pairs the pair-quality evaluator auto-paused on an active algorithm (src/lib/scan/pair-quality.ts: at least
# 8 closed trades and a win rate at or below 30%). The scan skips them without a word (src/lib/scan/engine.ts:85), so
# above zero needs a hand. Read through the backups' read-only role (decision 0011), the server verified as backup.sh
# does; the password reaches psql through its environment only. A read that fails is "?", never 0.
paused_pairs="?"
paused_list=$(
  url=$(envval BACKUP_DATABASE_URL)
  ca=/usr/local/lib/quanttrader/supabase-prod-ca-2021.crt
  { [ -n "$url" ] && [ -r "$ca" ]; } || exit 2
  parts=$(python3 -c 'import sys
from urllib.parse import urlsplit, unquote
u = urlsplit(sys.stdin.read().strip())
print("\x1f".join([u.hostname, str(u.port or 5432), unquote(u.username), unquote(u.password), u.path.lstrip("/") or "postgres"]))' <<< "$url" 2> /dev/null) || exit 2
  IFS=$'\x1f' read -r PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE <<< "$parts"
  export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE=verify-full PGSSLROOTCERT=$ca PGGSSENCMODE=disable PGCONNECT_TIMEOUT=20
  psql -X -q -A -t -v ON_ERROR_STOP=1 -c "select a.name || ' / ' || w.ticker || ' since ' || coalesce(to_char(w.auto_paused_at, 'YYYY-MM-DD'), '?') from public.algorithm_watchlist w join public.algorithms a on a.id = w.algorithm_id where w.auto_paused and a.status = 'active' order by a.name, w.ticker" 2> /dev/null
) && paused_pairs=$(grep -c . <<< "$paused_list")
paused_detail=""
if [ "$paused_pairs" = "?" ]; then
  attention+=("paused pairs not read")
elif [ "$paused_pairs" != 0 ]; then
  paused_detail=" ($(grep . <<< "$paused_list" | paste -sd ';' - | sed 's/;/; /g'))"
  attention+=("$paused_pairs pair(s) auto-paused$paused_detail")
fi
last=$(tail -n 1 "$LOGDIR/deploys.log" 2> /dev/null | cut -c1-120)
pruned=$(find "$LOGDIR" -maxdepth 1 -name 'deploy-*.log' -mtime +30 -print -delete 2> /dev/null | wc -l | tr -d ' ')
summary="quanttrader-prod $(date -u +%F): service=$service restarts=$restarts crons=$crons live=${live:0:7} verified=${running:0:7} dev=${devhead:0:7} (behind by $behind, fetch $fetch) node=$(node -v 2> /dev/null) disk=$disk mem=$mem reboot=$reboot held-by-kill-switch=$held paused-pairs=$paused_pairs$paused_detail failed-units=${failed:-none} pruned-deploy-logs=$pruned backup=$backup; last ledger: ${last:-none}"
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
