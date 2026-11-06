#!/usr/bin/env bash
# scripts/ops/resume.sh — runs ON THE VPS as `ops`, streamed by `make resume`. Reverses the kill
# switch's stop only: enables and starts the service, waits for /login 200, checks that NO algorithm
# is active (the switch may have failed to pause during an outage — then the crontab stays off and
# the operator re-runs the switch; with the crontab already installed they are reported as an error),
# restores the saved crontab, waits for the next manage, heartbeat
# and scan ticks to log http=200 (≤ 25 min), alerts and writes a RESUME line with the mirroring state
# of the saved algorithms. Algorithms stay paused — un-pausing them is the operator's deliberate act
# (scripts/ops/unpause.sh). Idempotent. Exit status is non-zero when any step failed.
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
count_rows() { python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2> /dev/null; }

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
mirroring=n/a
if [ -n "$SB_URL" ] && [ -n "$SB_KEY" ]; then
  if body=$(printf 'apikey: %s\nAuthorization: Bearer %s\n' "$SB_KEY" "$SB_KEY" | curl -fsS --max-time 15 -H @- "$SB_URL/rest/v1/algorithms?status=eq.active&select=id"); then
    active_n=$(count_rows <<< "$body") || { active_n="?"; errors+=("algorithms-check-failed"); log "could not read the active-algorithm check"; }
  else
    errors+=("algorithms-check-failed"); log "could not check for active algorithms (database unreachable?)"
  fi
  saved=$(grep -E '^[0-9a-f-]{36}$' "$STATE/kill-switch.paused-ids" 2> /dev/null | paste -sd, - || true)
  if [ -n "$saved" ]; then
    mirroring="?"
    if body=$(printf 'apikey: %s\nAuthorization: Bearer %s\n' "$SB_KEY" "$SB_KEY" | curl -fsS --max-time 15 -H @- "$SB_URL/rest/v1/algorithms?id=in.($saved)&select=live_trading_enabled"); then
      mirroring=$(python3 -c 'import json,sys
r=json.load(sys.stdin)
print("%d/%d" % (sum(1 for x in r if x.get("live_trading_enabled")), len(r)))' <<< "$body" 2> /dev/null || echo "?")
    fi
    log "mirroring state of the saved algorithms (live_trading_enabled on/total): $mirroring"
  fi
else
  errors+=("no-supabase-credentials"); log "Supabase URL/service key not found in $ENV_FILE"
fi
unset SB_KEY
crons_n=$(crontab -l 2> /dev/null | grep -c '^[0-9*]' || true)
if [ "$crons_n" != 0 ]; then
  log "crontab already installed ($crons_n entries); active algorithms: $active_n"
  # the crontab never came off, so nothing holds these back: with the service up they trade (DEBT D-28)
  if [ "$active_n" != 0 ] && [ "$active_n" != "?" ]; then
    errors+=("algorithms-active:$active_n"); log "$active_n algorithm(s) are ACTIVE with the crontab installed — they can trade now: run make kill-switch to stop them"
  fi
elif [ "$active_n" = 0 ]; then
  if [ -s "$STATE/crontab.disabled" ]; then
    if crontab "$STATE/crontab.disabled"; then crons_n=$(crontab -l | grep -c '^[0-9*]' || true); log "crontab restored ($crons_n entries)"; else errors+=("crontab"); log "crontab restore FAILED"; fi
  else
    errors+=("no-saved-crontab"); log "no saved crontab at $STATE/crontab.disabled — install ops/crontab from the repo as ops"
  fi
elif [ "$active_n" = "?" ]; then
  log "the crontab stays off until the active-algorithm check can run: fix the database connection, then make resume again"
else
  errors+=("algorithms-active:$active_n"); log "$active_n algorithm(s) are ACTIVE — the switch did not pause them; the crontab stays off: run make kill-switch again, then make resume"
fi

# the next manage, heartbeat and scan ticks after T0 must log http=200 — only if the service came up and the crons are back
if [ "$code" = 200 ] && [ "$crons_n" != 0 ]; then
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
summary="RESUMED at $T0: service=$service_state crons=$crons_n active_algorithms=$active_n mirroring=$mirroring (still paused: make unpause) errors=${errors[*]:-none}"
NTFY_TOPIC=$(envval NTFY_TOPIC); NTFY_TOKEN=$(envval NTFY_TOKEN); alert="no-topic"
push() { # $1 priority, $2 text
  { [ -n "$NTFY_TOKEN" ] && printf 'Authorization: Bearer %s\n' "$NTFY_TOKEN" || printf 'X-Unused: 1\n'; } \
    | curl -fsS --max-time 15 -H @- -H "Title: quanttrader-prod resumed" -H "Priority: $1" -d "$2" "https://ntfy.sh/$NTFY_TOPIC" > /dev/null
}
if [ -n "$NTFY_TOPIC" ]; then
  prio=default; [ ${#errors[@]} -eq 0 ] || prio=high
  if push "$prio" "$summary"; then alert=sent; else alert=FAILED; errors+=("alert"); fi
fi
if ! printf '%s RESUME service=%s crons=%s active_algorithms=%s mirroring=%s alert=%s errors=%s\n' "$(date -u +%FT%TZ)" "$service_state" "$crons_n" "$active_n" "$mirroring" "$alert" "${errors[*]:-none}" >> "$LEDGER" 2> /dev/null; then
  errors+=("ledger"); log "ledger write FAILED"
  # the first push said errors as they stood before this one; without a ledger line this is the only record
  [ -z "$NTFY_TOPIC" ] || push high "RESUME: the ledger line was NOT written. errors=${errors[*]}" || log "the second push FAILED"
fi
unset NTFY_TOKEN
log "$summary alert=$alert"
echo "RESUME_RESULT=$([ ${#errors[@]} -eq 0 ] && echo OK || echo PARTIAL)"
echo "RESUME_ERRORS=${errors[*]:-none}"
[ ${#errors[@]} -eq 0 ] || exit 1
