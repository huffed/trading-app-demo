#!/usr/bin/env bash
# scripts/ops/unpause.sh — runs ON THE VPS as `ops`, streamed by `make unpause`: the operator's
# deliberate act that re-activates exactly the algorithms the kill switch paused (the ids it saved),
# never every paused algorithm. Refuses while the service is not active (resume first). Writes an
# UNPAUSE line with the number of rows actually changed and removes the saved id list.
set -uo pipefail
APP=/opt/quanttrader
LEDGER=/var/log/quanttrader/deploys.log
STATE=/var/lib/quanttrader
ENV_FILE=$APP/.env.local
log() { printf '[%s] unpause: %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a /var/log/quanttrader/kill-switch.log 2> /dev/null; }
envval() { grep -E "^$1=" "$ENV_FILE" 2> /dev/null | head -n 1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }
[ "$(id -un)" = ops ] || { echo "unpause: run as ops; refusing as $(id -un)" >&2; exit 2; }
[ "$(systemctl is-active quanttrader 2> /dev/null || true)" = active ] || { log "the service is not active — run make resume first"; echo "UNPAUSE_RESULT=FAIL"; exit 1; }
[ -s "$STATE/kill-switch.paused-ids" ] || { log "nothing to un-pause: $STATE/kill-switch.paused-ids is missing or empty"; echo "UNPAUSE_RESULT=NOTHING"; exit 0; }
ids=$(grep -E '^[0-9a-f-]{36}$' "$STATE/kill-switch.paused-ids")
[ -n "$ids" ] || { log "the saved id list holds no valid ids"; echo "UNPAUSE_RESULT=FAIL"; exit 1; }
SB_URL=$(envval NEXT_PUBLIC_SUPABASE_URL); SB_KEY=$(envval SUPABASE_SERVICE_ROLE_KEY)
[ -n "$SB_URL" ] && [ -n "$SB_KEY" ] || { log "Supabase URL/service key not found in $ENV_FILE"; echo "UNPAUSE_RESULT=FAIL"; exit 1; }
list=$(paste -sd, - <<< "$ids")
if body=$(printf 'apikey: %s\nAuthorization: Bearer %s\nContent-Type: application/json\nPrefer: return=representation\n' "$SB_KEY" "$SB_KEY" \
  | curl -fsS --max-time 15 -H @- -X PATCH "$SB_URL/rest/v1/algorithms?status=eq.paused&id=in.($list)&select=id" -d '{"status":"active"}'); then
  n=$(python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' <<< "$body" 2> /dev/null || echo "?")
  rm -f "$STATE/kill-switch.paused-ids"
  printf '%s UNPAUSE algorithms=%s of %s saved\n' "$(date -u +%FT%TZ)" "$n" "$(grep -c . <<< "$ids")" >> "$LEDGER" 2> /dev/null || log "ledger write FAILED"
  log "re-activated $n of the $(grep -c . <<< "$ids") algorithm(s) the kill switch had paused (the rest were already active)"
  echo "UNPAUSE_RESULT=OK"
else
  log "PATCH FAILED (database unreachable?) — the saved id list is kept"
  echo "UNPAUSE_RESULT=FAIL"; exit 1
fi
unset SB_KEY
