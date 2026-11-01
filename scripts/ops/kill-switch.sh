#!/usr/bin/env bash
# scripts/ops/kill-switch.sh — runs ON THE VPS as `ops`, streamed by `make kill-switch` from the
# workstation's local copy of origin/dev (no fetch: the switch must not depend on GitHub).
#
#   kill-switch.sh [reason]      idempotent; safe to run twice; the only VPS change allowed in market hours
#
# Order, every step attempted even if an earlier one failed (fail closed):
#   1. pause every ACTIVE algorithm (Supabase REST with the service role read from .env.local on
#      the host) so no new entries can open; the ids it paused are saved for `make unpause`;
#   2. flatten the open PAPER positions of those algorithms through the app's own
#      /api/admin/flatten-algo route on loopback (exit_reason "manual");
#   3. stop the service and disable the crontab (saved to /var/lib/quanttrader/crontab.disabled);
#   4. alert (ntfy, urgent) and write a KILL line to /var/log/quanttrader/deploys.log saying
#      what succeeded and what did not.
# If the database or the app is unreachable, steps 1–2 fail and 3–4 still run: nothing can
# trade with the service stopped and the crons gone. Secrets are read on the host and passed
# to curl through stdin headers, never printed. Resume: scripts/ops/resume.sh; un-pause:
# scripts/ops/unpause.sh (a deliberate operator act, never part of resume).
set -uo pipefail

APP=/opt/quanttrader
LOGDIR=/var/log/quanttrader
LEDGER=$LOGDIR/deploys.log
STATE=/var/lib/quanttrader
ENV_FILE=$APP/.env.local
REASON=${1:-operator}
[[ "$REASON" =~ ^[A-Za-z0-9_.-]{1,40}$ ]] || REASON=operator
T0=$(date -u +%FT%TZ)
errors=()
paused="?"
flattened="?"

log() { printf '[%s] kill-switch: %s\n' "$(date -u +%FT%TZ)" "$*"; }
envval() { grep -E "^$1=" "$ENV_FILE" 2> /dev/null | head -n 1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }
ids_from_json() { python3 -c 'import json,sys; print("\n".join(r["id"] for r in json.load(sys.stdin)))' 2> /dev/null; }

mkdir -p "$STATE" 2> /dev/null || true
log "engaged by $REASON at $T0 on $(hostname)"

# 1. pause every active algorithm
SB_URL=$(envval NEXT_PUBLIC_SUPABASE_URL)
SB_KEY=$(envval SUPABASE_SERVICE_ROLE_KEY)
ids=""
if [ -n "$SB_URL" ] && [ -n "$SB_KEY" ]; then
  ids=$(printf 'apikey: %s\nAuthorization: Bearer %s\n' "$SB_KEY" "$SB_KEY" \
    | curl -fsS --max-time 15 -H @- "$SB_URL/rest/v1/algorithms?status=eq.active&select=id" | ids_from_json) || { errors+=("list-active"); ids=""; }
  if [ -n "$ids" ]; then
    printf '%s\n' "$ids" > "$STATE/kill-switch.paused-ids" 2> /dev/null || errors+=("save-ids")
    if printf 'apikey: %s\nAuthorization: Bearer %s\nContent-Type: application/json\nPrefer: return=minimal\n' "$SB_KEY" "$SB_KEY" \
      | curl -fsS --max-time 15 -H @- -X PATCH "$SB_URL/rest/v1/algorithms?status=eq.active" -d '{"status":"paused"}' > /dev/null; then
      paused=$(printf '%s\n' "$ids" | grep -c .)
      log "paused $paused active algorithm(s); ids saved to $STATE/kill-switch.paused-ids"
    else
      errors+=("pause"); paused="FAILED"
      log "pause FAILED (database unreachable?) — continuing"
    fi
  else
    [ ${#errors[@]} -eq 0 ] && { paused=0; log "no active algorithm to pause"; }
  fi
else
  errors+=("no-supabase-credentials"); paused="FAILED"
  log "Supabase URL/service key not found in $ENV_FILE — cannot pause; continuing"
fi
unset SB_KEY

# 2. flatten open paper positions of the algorithms that were active
CRON_SECRET=$(envval CRON_SECRET)
if [ -n "$ids" ] && [ -n "$CRON_SECRET" ]; then
  total=0
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    out=$(printf 'Authorization: Bearer %s\n' "$CRON_SECRET" \
      | curl -fsS --max-time 60 -H @- -X POST "http://127.0.0.1:3000/api/admin/flatten-algo?id=$id") \
      || { errors+=("flatten:${id:0:8}"); log "flatten FAILED for ${id:0:8} (app unreachable?)"; continue; }
    n=$(grep -o '"flattened":[0-9]*' <<< "$out" | head -n 1 | cut -d: -f2)
    total=$((total + ${n:-0}))
  done <<< "$ids"
  flattened=$total
  log "flattened $flattened open paper position(s)"
elif [ -z "$ids" ]; then
  flattened=0
else
  errors+=("no-cron-secret"); flattened="FAILED"
fi
unset CRON_SECRET

# 3. stop the service and disable the crontab (idempotent: an empty crontab keeps the saved copy)
current=$(crontab -l 2> /dev/null || true)
if [ -n "$current" ]; then
  printf '%s\n' "$current" > "$STATE/crontab.disabled" && crontab -r && log "crontab disabled (saved to $STATE/crontab.disabled)" || { errors+=("crontab"); log "crontab disable FAILED"; }
else
  log "crontab already empty"
fi
if sudo -n systemctl stop quanttrader; then
  log "service stopped"
else
  errors+=("stop-service"); log "systemctl stop FAILED"
fi
service_state=$(systemctl is-active quanttrader 2> /dev/null || true)

# 4. alert and ledger
summary="KILL SWITCH ($REASON) at $T0: paused=$paused flattened=$flattened service=$service_state crons=disabled errors=${errors[*]:-none}"
NTFY_TOPIC=$(envval NTFY_TOPIC)
NTFY_TOKEN=$(envval NTFY_TOKEN)
alert="no-topic"
if [ -n "$NTFY_TOPIC" ]; then
  if { [ -n "$NTFY_TOKEN" ] && printf 'Authorization: Bearer %s\n' "$NTFY_TOKEN" || printf 'X-Unused: 1\n'; } \
    | curl -fsS --max-time 15 -H @- -H "Title: quanttrader-prod KILL SWITCH" -H "Priority: urgent" -H "Tags: rotating_light" -d "$summary" "https://ntfy.sh/$NTFY_TOPIC" > /dev/null; then
    alert="sent"
  else
    alert="FAILED"; errors+=("alert")
  fi
fi
unset NTFY_TOKEN
printf '%s KILL reason=%s paused=%s flattened=%s service=%s crons=disabled alert=%s errors=%s\n' \
  "$(date -u +%FT%TZ)" "$REASON" "$paused" "$flattened" "$service_state" "$alert" "${errors[*]:-none}" >> "$LEDGER" 2> /dev/null || log "ledger write FAILED"
log "$summary alert=$alert"
echo "KILL_RESULT=$([ ${#errors[@]} -eq 0 ] && echo OK || echo PARTIAL)"
echo "KILL_ERRORS=${errors[*]:-none}"
echo "resume: make resume   (service + crons back; algorithms stay paused)   un-pause: make unpause"
