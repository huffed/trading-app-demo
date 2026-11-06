#!/usr/bin/env bash
# scripts/ops/unpause.sh — runs ON THE VPS as `ops`, streamed by `make unpause`: the operator's
# deliberate act that re-activates exactly the algorithms the kill switch paused (the ids it saved),
# never every paused algorithm. Refuses while the service is not active (resume first). Writes an
# UNPAUSE line with the number of rows actually changed and their mirroring state, and removes the
# saved id list. When the PATCH fails it may still have committed (a timeout after the commit), so it
# writes an UNPAUSE result=unknown line and keeps the list. Exit status is non-zero on either failure.
set -uo pipefail
trap '' HUP INT PIPE
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
  | curl -fsS --max-time 15 -H @- -X PATCH "$SB_URL/rest/v1/algorithms?status=eq.paused&id=in.($list)&select=id,live_trading_enabled" -d '{"status":"active"}'); then
  unset SB_KEY
  n=$(python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' <<< "$body" 2> /dev/null || echo "?")
  mirroring=$(python3 -c 'import json,sys
r=json.load(sys.stdin)
print("%d/%d" % (sum(1 for x in r if x.get("live_trading_enabled")), len(r)))' <<< "$body" 2> /dev/null || echo "?")
  rm -f "$STATE/kill-switch.paused-ids"
  result=OK
  if ! printf '%s UNPAUSE algorithms=%s of %s saved mirroring=%s\n' "$(date -u +%FT%TZ)" "$n" "$(grep -c . <<< "$ids")" "$mirroring" >> "$LEDGER" 2> /dev/null; then
    result=PARTIAL; log "ledger write FAILED"
  fi
  log "re-activated $n of the $(grep -c . <<< "$ids") algorithm(s) the kill switch had paused (the rest were already active); live_trading_enabled on/total: $mirroring"
  echo "UNPAUSE_RESULT=$result"
  [ "$result" = OK ] || exit 1
else
  unset SB_KEY
  log "PATCH FAILED (database unreachable, or a timeout after it committed): the algorithms may be active; the saved id list is kept — check the database, then make unpause again"
  printf '%s UNPAUSE result=unknown algorithms=? of %s saved\n' "$(date -u +%FT%TZ)" "$(grep -c . <<< "$ids")" >> "$LEDGER" 2> /dev/null || log "ledger write FAILED"
  echo "UNPAUSE_RESULT=FAIL"; exit 1
fi
