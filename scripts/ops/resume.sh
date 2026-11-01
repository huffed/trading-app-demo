#!/usr/bin/env bash
# scripts/ops/resume.sh — runs ON THE VPS as `ops`, streamed by `make resume`. Reverses the kill
# switch's stop only: enables and starts the service, waits for /login 200, checks that NO algorithm
# is active (the switch may have failed to pause during an outage — then the crontab stays off and
# the operator re-runs the switch), restores the saved crontab, waits for the next manage, heartbeat
# and scan ticks to log http=200 (≤ 25 min), alerts and writes a RESUME line. Algorithms stay paused
# — un-pausing them is the operator's deliberate act (scripts/ops/unpause.sh). Idempotent. Exit
# status is non-zero when any step failed.
set -uo pipefail
trap '' HUP INT PIPE

APP=/opt/quanttrader
LOGDIR=/var/log/quanttrader
LEDGER=$LOGDIR/deploys.log
STATE=/var/lib/quanttrader
ENV_FILE=$APP/.env.local
errors=()
log() { printf '[%s] resume: %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOGDIR/kill-switch.log" 2> /dev/null; }
envval() { grep -E "^$1=" "$ENV_FILE" 2> /dev/null | head -n 1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }
http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" || true; }
ids_from_json() { python3 -c 'import json,sys; print("\n".join(r["id"] for r in json.load(sys.stdin)))' 2> /dev/null; }

[ "$(id -un)" = ops ] || { echo "resume: run as ops; refusing as $(id -un)" >&2; exit 2; }
T0=$(date -u +%FT%TZ)
if sudo -n systemctl enable --now quanttrader; then log "service enabled and started"; else errors+=("start-service"); log "systemctl enable --now FAILED"; fi
code=000
for _ in $(seq 1 45); do
  code=$(http_code http://127.0.0.1:3000/login)
  [ "$code" = 200 ] && break
  sleep 2
done
if [ "$code" = 200 ]; then log "/login 200"; else errors+=("login:$code"); log "/login answered $code"; fi

# no algorithm may be active before the schedulers come back
SB_URL=$(envval NEXT_PUBLIC_SUPABASE_URL)
SB_KEY=$(envval SUPABASE_SERVICE_ROLE_KEY)
active_n="?"
if [ -n "$SB_URL" ] && [ -n "$SB_KEY" ]; then
  if body=$(printf 'apikey: %s\nAuthorization: Bearer %s\n' "$SB_KEY" "$SB_KEY" | curl -fsS --max-time 15 -H @- "$SB_URL/rest/v1/algorithms?status=eq.active&select=id"); then
    active_n=$(ids_from_json <<< "$body" | grep -c . || true)
  else
    errors+=("algorithms-check-failed"); log "could not check for active algorithms (database unreachable?)"
  fi
else
  errors+=("no-supabase-credentials"); log "Supabase URL/service key not found in $ENV_FILE"
fi
unset SB_KEY
crons_n=$(crontab -l 2> /dev/null | grep -c '^[0-9*]' || true)
if [ "$active_n" = 0 ]; then
  if [ "$crons_n" = 0 ]; then
    if [ -s "$STATE/crontab.disabled" ]; then
      if crontab "$STATE/crontab.disabled"; then crons_n=$(crontab -l | grep -c '^[0-9*]' || true); log "crontab restored ($crons_n entries)"; else errors+=("crontab"); log "crontab restore FAILED"; fi
    else
      errors+=("no-saved-crontab"); log "no saved crontab at $STATE/crontab.disabled — install ops/crontab from the repo as ops"
    fi
  else
    log "crontab already installed ($crons_n entries)"
  fi
else
  errors+=("algorithms-active:$active_n"); log "$active_n algorithm(s) are ACTIVE — the switch did not pause them; the crontab stays off: run make kill-switch again, then make resume"
fi

# the next manage, heartbeat and scan ticks after T0 must log http=200 — only if the service came up and the crons are back
if [ "$code" = 200 ] && [ "$crons_n" != 0 ] && [ "$active_n" = 0 ]; then
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
else
  log "tick verification skipped (service or crons not back, or algorithms still active)"
fi

service_state=$(systemctl is-active quanttrader 2> /dev/null || true)
summary="RESUMED at $T0: service=$service_state crons=$crons_n active_algorithms=$active_n (still paused: make unpause) errors=${errors[*]:-none}"
NTFY_TOPIC=$(envval NTFY_TOPIC); NTFY_TOKEN=$(envval NTFY_TOKEN); alert="no-topic"
if [ -n "$NTFY_TOPIC" ]; then
  prio=default; [ ${#errors[@]} -eq 0 ] || prio=high
  if { [ -n "$NTFY_TOKEN" ] && printf 'Authorization: Bearer %s\n' "$NTFY_TOKEN" || printf 'X-Unused: 1\n'; } \
    | curl -fsS --max-time 15 -H @- -H "Title: quanttrader-prod resumed" -H "Priority: $prio" -d "$summary" "https://ntfy.sh/$NTFY_TOPIC" > /dev/null; then alert=sent; else alert=FAILED; errors+=("alert"); fi
fi
unset NTFY_TOKEN
printf '%s RESUME service=%s crons=%s active_algorithms=%s alert=%s errors=%s\n' "$(date -u +%FT%TZ)" "$service_state" "$crons_n" "$active_n" "$alert" "${errors[*]:-none}" >> "$LEDGER" 2> /dev/null || log "ledger write FAILED"
log "$summary alert=$alert"
echo "RESUME_RESULT=$([ ${#errors[@]} -eq 0 ] && echo OK || echo PARTIAL)"
echo "RESUME_ERRORS=${errors[*]:-none}"
[ ${#errors[@]} -eq 0 ] || exit 1
