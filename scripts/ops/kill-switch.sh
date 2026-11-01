#!/usr/bin/env bash
# scripts/ops/kill-switch.sh — runs ON THE VPS as `ops`, streamed by `make kill-switch` from the
# workstation's local copy of origin/dev (no fetch: the switch must not depend on GitHub). On the
# host itself (after a deploy has put it in the checkout): sudo -u ops bash /opt/quanttrader/scripts/ops/kill-switch.sh <reason>
#
#   kill-switch.sh [reason]      idempotent; safe to run twice; the only VPS change allowed in market hours
#
# Order — every step attempted even if an earlier one failed (fail closed), nothing here waits on
# the database or the app before the schedulers are gone:
#   1. disable the crontab (saved to /var/lib/quanttrader/crontab.disabled) — no new ticks;
#   2. pause every ACTIVE algorithm (Supabase REST, service role read from .env.local on the host);
#      the ids are saved for `make unpause`, merged with any ids a previous run saved;
#   3. flatten the open positions of those algorithms through the app's own /api/admin/flatten-algo
#      route on loopback — paper rows, and the broker side of any position that carries a
#      broker_position_id; after the app stops answering (connection refused / timeout) the remaining
#      ids are skipped, not waited on;
#   4. stop AND disable the service (a reboot must not bring trading back);
#   5. count positions still open for those algorithms, alert (ntfy, urgent) and write a KILL line to
#      /var/log/quanttrader/deploys.log that says exactly what succeeded and what did not.
# Signals from a dropped ssh session are ignored, and every line is also appended to
# /var/log/quanttrader/kill-switch.log, so the run finishes once started. Secrets are read on the
# host and passed to curl through stdin headers, never printed. Exit status is non-zero when any
# step failed. Resume: scripts/ops/resume.sh; un-pause: scripts/ops/unpause.sh (the operator's act).
set -uo pipefail
trap '' HUP INT PIPE

APP=/opt/quanttrader
LOGDIR=/var/log/quanttrader
LEDGER=$LOGDIR/deploys.log
STATE=/var/lib/quanttrader
ENV_FILE=$APP/.env.local
IDS_FILE=$STATE/kill-switch.paused-ids
REASON=${1:-operator}
[[ "$REASON" =~ ^[A-Za-z0-9_.-]{1,40}$ ]] || REASON=operator
T0=$(date -u +%FT%TZ)
errors=()
paused="?"
flattened="?"
crons="?"
open_after="?"

log() { printf '[%s] kill-switch: %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOGDIR/kill-switch.log" 2> /dev/null; }
envval() { grep -E "^$1=" "$ENV_FILE" 2> /dev/null | head -n 1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }
ids_from_json() { python3 -c 'import json,sys; print("\n".join(r["id"] for r in json.load(sys.stdin)))' 2> /dev/null; }
sb_get() { # $1 path+query → body on stdout; needs SB_URL/SB_KEY
  printf 'apikey: %s\nAuthorization: Bearer %s\n' "$SB_KEY" "$SB_KEY" | curl -fsS --max-time 15 -H @- "$SB_URL/rest/v1/$1"
}

[ "$(id -un)" = ops ] || { echo "kill-switch: run as ops (sudo -u ops bash $0 <reason>); refusing as $(id -un)" >&2; exit 2; }
mkdir -p "$STATE" 2> /dev/null || true
log "engaged by $REASON at $T0 on $(hostname)"

# 1. no new ticks: disable the crontab (idempotent — an empty crontab keeps the saved copy)
current=$(crontab -l 2> /dev/null || true)
if [ -n "$current" ]; then
  if printf '%s\n' "$current" > "$STATE/crontab.disabled" && crontab -r; then
    crons=disabled; log "crontab disabled ($(grep -c '^[0-9*]' <<< "$current") entries saved to $STATE/crontab.disabled)"
  else
    crons=FAILED; errors+=("crontab"); log "crontab disable FAILED"
  fi
else
  crons=already-empty; log "crontab already empty"
fi

# 2. pause every active algorithm; remember the ids (merged with a previous run's)
SB_URL=$(envval NEXT_PUBLIC_SUPABASE_URL)
SB_KEY=$(envval SUPABASE_SERVICE_ROLE_KEY)
ids=""
# a previous run's saved ids count only while that engagement is still on (crontab already empty);
# a fresh engagement replaces the list, so an un-pause never wakes algorithms paused on purpose in between
saved_ids=""
[ "$crons" = already-empty ] && saved_ids=$(grep -E '^[0-9a-f-]{36}$' "$IDS_FILE" 2> /dev/null || true)
if [ -n "$SB_URL" ] && [ -n "$SB_KEY" ]; then
  if active=$(sb_get "algorithms?status=eq.active&select=id" | ids_from_json); then
    ids=$active
    if [ -n "$ids" ]; then
      # save BEFORE the PATCH: a PATCH that commits but times out must still be un-pausable
      printf '%s\n' "$ids" "$saved_ids" | grep -E '^[0-9a-f-]{36}$' | sort -u > "$IDS_FILE" 2> /dev/null || { errors+=("save-ids"); log "saving the ids FAILED"; }
      if printf 'apikey: %s\nAuthorization: Bearer %s\nContent-Type: application/json\nPrefer: return=minimal\n' "$SB_KEY" "$SB_KEY" \
        | curl -fsS --max-time 15 -H @- -X PATCH "$SB_URL/rest/v1/algorithms?status=eq.active" -d '{"status":"paused"}' > /dev/null; then
        paused=$(grep -c . <<< "$ids")
        log "paused $paused active algorithm(s); ids saved to $IDS_FILE"
      else
        paused=FAILED; errors+=("pause"); log "pause FAILED (database unreachable?) — continuing (ids saved)"
      fi
    else
      paused=0; log "no active algorithm to pause"
    fi
  else
    paused=FAILED; errors+=("list-active"); log "listing active algorithms FAILED (database unreachable?) — continuing"
  fi
else
  paused=FAILED; errors+=("no-supabase-credentials"); log "Supabase URL/service key not found in $ENV_FILE — cannot pause; continuing"
fi
targets=$(printf '%s\n' "$ids" "$saved_ids" | grep -E '^[0-9a-f-]{36}$' | sort -u)

# 3. flatten the positions of those algorithms through the app (paper rows + any broker side)
CRON_SECRET=$(envval CRON_SECRET)
if [ -z "$targets" ]; then
  flattened=SKIPPED; log "no algorithm ids to flatten (nothing active and nothing saved${errors:+; see errors})"
elif [ "$(systemctl is-active quanttrader 2> /dev/null || true)" != active ]; then
  flattened=SKIPPED; log "the service is not active (already stopped by an earlier run?); flatten skipped — open_after decides"
elif [ -z "$CRON_SECRET" ]; then
  flattened=FAILED; errors+=("no-cron-secret"); log "CRON_SECRET not found in $ENV_FILE — cannot flatten"
else
  total=0; nfail=0; skipped=0
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    if [ "$skipped" = 1 ]; then errors+=("flatten-skipped:${id:0:8}"); continue; fi
    if out=$(printf 'Authorization: Bearer %s\n' "$CRON_SECRET" | curl -sS --max-time 60 -H @- -X POST -w '\n%{http_code}' "http://127.0.0.1:3000/api/admin/flatten-algo?id=$id" 2> /dev/null); then
      code=${out##*$'\n'}; body=${out%$'\n'*}
      if [ "$code" = 200 ]; then
        n=$(grep -o '"flattened":[0-9]*' <<< "$body" | head -n 1 | cut -d: -f2); total=$((total + ${n:-0}))
      else
        nfail=$((nfail + 1)); errors+=("flatten:${id:0:8}:http$code"); log "flatten for ${id:0:8} answered $code"
      fi
    else
      rc=$?; nfail=$((nfail + 1)); errors+=("flatten:${id:0:8}:curl$rc"); log "flatten for ${id:0:8} failed (curl $rc)"
      case "$rc" in 7 | 28) skipped=1; log "the app is not answering; skipping the remaining ids" ;; esac
    fi
  done <<< "$targets"
  if [ "$nfail" = 0 ] && [ "$skipped" = 0 ]; then flattened=$total; else flattened="$total ($nfail failed$([ "$skipped" = 1 ] && echo ', rest skipped'))"; fi
  log "flattened $flattened open position(s)"
fi
unset CRON_SECRET

# 4. stop and disable the service (disable: a reboot must not bring trading back)
if sudo -n systemctl disable --now quanttrader; then
  log "service stopped and disabled"
else
  errors+=("stop-service"); log "systemctl disable --now FAILED"
fi
service_state=$(systemctl is-active quanttrader 2> /dev/null || true)

# 5. what is still open, then alert and record
if [ -n "$targets" ] && [ -n "$SB_URL" ] && [ -n "$SB_KEY" ]; then
  list=$(paste -sd, - <<< "$targets")
  if body=$(sb_get "paper_positions?status=eq.open&algorithm_id=in.($list)&select=id"); then
    open_after=$(ids_from_json <<< "$body" | grep -c . || true)
    [ "$open_after" = 0 ] || { errors+=("open-after:$open_after"); log "$open_after position(s) still open for the paused algorithms — resume, then run the switch again"; }
  else
    open_after="?"; errors+=("open-after-check"); log "could not count open positions (database unreachable?)"
  fi
fi
unset SB_KEY
summary="KILL SWITCH ($REASON) at $T0: crons=$crons paused=$paused flattened=$flattened service=$service_state open_after=$open_after errors=${errors[*]:-none}"
NTFY_TOPIC=$(envval NTFY_TOPIC)
NTFY_TOKEN=$(envval NTFY_TOKEN)
alert="no-topic"
if [ -n "$NTFY_TOPIC" ]; then
  if { [ -n "$NTFY_TOKEN" ] && printf 'Authorization: Bearer %s\n' "$NTFY_TOKEN" || printf 'X-Unused: 1\n'; } \
    | curl -fsS --max-time 15 -H @- -H "Title: quanttrader-prod KILL SWITCH" -H "Priority: urgent" -H "Tags: rotating_light" -d "$summary" "https://ntfy.sh/$NTFY_TOPIC" > /dev/null; then
    alert=sent
  else
    alert=FAILED; errors+=("alert")
  fi
fi
unset NTFY_TOKEN
printf '%s KILL reason=%s crons=%s paused=%s flattened=%s service=%s open_after=%s alert=%s errors=%s\n' \
  "$(date -u +%FT%TZ)" "$REASON" "$crons" "$paused" "$flattened" "$service_state" "$open_after" "$alert" "${errors[*]:-none}" >> "$LEDGER" 2> /dev/null || log "ledger write FAILED"
log "$summary alert=$alert"
echo "KILL_RESULT=$([ ${#errors[@]} -eq 0 ] && echo OK || echo PARTIAL)"
echo "KILL_ERRORS=${errors[*]:-none}"
echo "resume: make resume   (service + crons back; algorithms stay paused)   un-pause: make unpause"
[ ${#errors[@]} -eq 0 ] || exit 1
