#!/usr/bin/env bash
# scripts/ops/resume.sh — runs ON THE VPS as `ops`, streamed by `make resume`. Reverses the kill
# switch's step 3 only: starts the service, waits for /login 200, restores the crontab saved by the
# kill switch, then waits for the next manage, heartbeat and scan ticks to log http=200 (≤ 25 min),
# alerts and writes a RESUME line to the ledger. Algorithms stay paused — un-pausing them is the
# operator's deliberate act (scripts/ops/unpause.sh). Idempotent.
set -uo pipefail

APP=/opt/quanttrader
LOGDIR=/var/log/quanttrader
LEDGER=$LOGDIR/deploys.log
STATE=/var/lib/quanttrader
ENV_FILE=$APP/.env.local
errors=()
log() { printf '[%s] resume: %s\n' "$(date -u +%FT%TZ)" "$*"; }
envval() { grep -E "^$1=" "$ENV_FILE" 2> /dev/null | head -n 1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }
http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" || true; }

T0=$(date -u +%FT%TZ)
if sudo -n systemctl start quanttrader; then log "service started"; else errors+=("start-service"); log "systemctl start FAILED"; fi
code=000
for _ in $(seq 1 45); do
  code=$(http_code http://127.0.0.1:3000/login)
  [ "$code" = 200 ] && break
  sleep 2
done
[ "$code" = 200 ] && log "/login 200" || { errors+=("login:$code"); log "/login answered $code"; }

if [ -z "$(crontab -l 2> /dev/null || true)" ]; then
  if [ -s "$STATE/crontab.disabled" ]; then
    crontab "$STATE/crontab.disabled" && log "crontab restored ($(grep -c '^[0-9*]' "$STATE/crontab.disabled") entries)" || { errors+=("crontab"); log "crontab restore FAILED"; }
  else
    errors+=("no-saved-crontab"); log "no saved crontab at $STATE/crontab.disabled — install ops/crontab from the repo"
  fi
else
  log "crontab already installed ($(crontab -l | grep -c '^[0-9*]') entries)"
fi

# the next manage, heartbeat and scan ticks after T0 must log http=200
deadline=$(($(date +%s) + 25 * 60))
for name in manage heartbeat scan; do
  while :; do
    line=$(tail -n 40 "$LOGDIR/$name.log" 2> /dev/null | grep 'http=' | tail -n 1 || true)
    stamp=${line:1:20}
    if [ -n "$stamp" ] && [[ "$stamp" > "$T0" ]]; then
      if grep -q 'http=200' <<< "$line"; then log "$name tick at $stamp: http=200"; else errors+=("$name-tick"); log "$name tick at $stamp: ${line:22:100}"; fi
      break
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then errors+=("$name-tick-missing"); log "no $name tick within 25 min"; break; fi
    sleep 10
  done
done

service_state=$(systemctl is-active quanttrader 2> /dev/null || true)
summary="RESUMED at $T0: service=$service_state crons=$(crontab -l 2> /dev/null | grep -c '^[0-9*]') ticks checked; algorithms still paused (make unpause); errors=${errors[*]:-none}"
NTFY_TOPIC=$(envval NTFY_TOPIC); NTFY_TOKEN=$(envval NTFY_TOKEN); alert="no-topic"
if [ -n "$NTFY_TOPIC" ]; then
  if { [ -n "$NTFY_TOKEN" ] && printf 'Authorization: Bearer %s\n' "$NTFY_TOKEN" || printf 'X-Unused: 1\n'; } \
    | curl -fsS --max-time 15 -H @- -H "Title: quanttrader-prod resumed" -H "Priority: default" -d "$summary" "https://ntfy.sh/$NTFY_TOPIC" > /dev/null; then alert="sent"; else alert="FAILED"; errors+=("alert"); fi
fi
unset NTFY_TOKEN
printf '%s RESUME service=%s crons=%s alert=%s errors=%s\n' "$(date -u +%FT%TZ)" "$service_state" "$(crontab -l 2> /dev/null | grep -c '^[0-9*]')" "$alert" "${errors[*]:-none}" >> "$LEDGER" 2> /dev/null || log "ledger write FAILED"
log "$summary alert=$alert"
echo "RESUME_RESULT=$([ ${#errors[@]} -eq 0 ] && echo OK || echo PARTIAL)"
echo "RESUME_ERRORS=${errors[*]:-none}"
