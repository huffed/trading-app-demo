#!/usr/bin/env bash
# scripts/ops/unpause.sh — runs ON THE VPS as `ops`, streamed by `make unpause`: the operator's
# deliberate act that re-activates exactly the algorithms the kill switch paused (the ids it saved),
# never every paused algorithm. Refuses while the service is not active (resume first). Writes an
# UNPAUSE line with the number of rows actually changed, how many algorithms the engagement also targeted
# stay paused (left_paused: an earlier engagement paused them and a fresh one did not save them), what the
# failed-broker list held, and the mirroring state of the saved ids, and ends the engagement: the saved id
# list, the flatten list and the failed-broker list go. A broker position on that list may still be open,
# so it says so before the list goes, also when there is nothing to un-pause. When the PATCH fails it may
# still have committed (a timeout after the commit), so it writes an UNPAUSE result=unknown line and keeps
# them all. Exit status is non-zero on either failure.
set -uo pipefail
trap '' HUP INT PIPE
APP=/opt/quanttrader
LEDGER=/var/log/quanttrader/deploys.log
STATE=/var/lib/quanttrader
ENV_FILE=$APP/.env.local
log() { printf '[%s] unpause: %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a /var/log/quanttrader/kill-switch.log 2> /dev/null; }
envval() { grep -E "^$1=" "$ENV_FILE" 2> /dev/null | head -n 1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }
mirroring_of() { # $1 comma list of ids → "<on>/<total>" algorithms with live_trading_enabled, "?" when unreadable
  local body
  if body=$(printf 'apikey: %s\nAuthorization: Bearer %s\n' "$SB_KEY" "$SB_KEY" | curl -fsS --max-time 15 -H @- "$SB_URL/rest/v1/algorithms?id=in.($1)&select=live_trading_enabled"); then
    python3 -c 'import json,sys
r=json.load(sys.stdin)
print("%d/%d" % (sum(1 for x in r if x.get("live_trading_enabled")), len(r)))' <<< "$body" 2> /dev/null || echo "?"
  else
    echo "?"
  fi
}
# Ends the engagement. With keep-broker the failed-broker list stays: its contents are not in the ledger yet, and
# it is the only reminder of broker positions that may still be open.
end_engagement() {
  rm -f "$STATE/kill-switch.paused-ids" "$STATE/kill-switch.flatten-ids" "$STATE/kill-switch.engaged"
  [ "${1:-}" = keep-broker ] || rm -f "$STATE/kill-switch.broker-failed"
}
# The failed-broker list: "<id> <positions not closed>", or "<id> ?" when a flatten's answer was lost (kill-switch.sh).
BROKER_FILE=$STATE/kill-switch.broker-failed
broker_n=0; broker_unknown=0
if [ -f "$BROKER_FILE" ]; then
  broker_n=$(awk '$2 ~ /^[0-9]+$/ {n += $2} END {print n + 0}' "$BROKER_FILE" 2> /dev/null)
  broker_unknown=$(awk '$2 == "?" {print $1}' "$BROKER_FILE" 2> /dev/null | sort -u | grep -c . || true)
fi
warn_broker() { # said before end_engagement removes the list, which until then reminded every kill-switch run
  [ "${broker_n:-0}" = 0 ] && [ "${broker_unknown:-0}" = 0 ] && return 0
  log "the failed-broker list held ${broker_n:-0} broker position(s) the switch could not close and ${broker_unknown:-0} algorithm(s) whose flatten answer was lost ($(awk '{print $1}' "$BROKER_FILE" 2> /dev/null | sort -u | paste -sd' ' -)): they may still be open, so check the broker account; this list now goes and no later run will remind you"
}
still_paused() { # $1 comma list of ids → "<how many are paused> <their ids, comma list>", "?" when unreadable
  local body
  if body=$(printf 'apikey: %s\nAuthorization: Bearer %s\n' "$SB_KEY" "$SB_KEY" | curl -fsS --max-time 15 -H @- "$SB_URL/rest/v1/algorithms?id=in.($1)&status=eq.paused&select=id"); then
    python3 -c 'import json,sys
r=[x["id"] for x in json.load(sys.stdin)]
print(len(r), ",".join(r))' <<< "$body" 2> /dev/null || echo "?"
  else
    echo "?"
  fi
}
[ "$(id -un)" = ops ] || { echo "unpause: run as ops; refusing as $(id -un)" >&2; exit 2; }
[ "$(systemctl is-active quanttrader 2> /dev/null || true)" = active ] || { log "the service is not active — run make resume first"; echo "UNPAUSE_RESULT=FAIL"; exit 1; }
if ! [ -s "$STATE/kill-switch.paused-ids" ]; then
  # nothing to wake, but an engagement's other lists may remain: say what goes, and record it when anything did
  left=$(for f in kill-switch.engaged kill-switch.flatten-ids kill-switch.broker-failed; do [ -e "$STATE/$f" ] && echo "$f"; done | paste -sd, - || true)
  warn_broker
  log "nothing to un-pause: $STATE/kill-switch.paused-ids is missing or empty${left:+; clearing $left}"
  # the ledger line first: when it cannot be written, the failed-broker list stays
  if [ -n "$left" ] && ! printf '%s UNPAUSE result=nothing cleared=%s broker_failed_cleared=%s broker_unknown_cleared=%s\n' "$(date -u +%FT%TZ)" "$left" "${broker_n:-0}" "${broker_unknown:-0}" >> "$LEDGER" 2> /dev/null; then
    end_engagement keep-broker; log "ledger write FAILED; the failed-broker list is kept"; echo "UNPAUSE_RESULT=PARTIAL"; exit 1
  fi
  end_engagement
  echo "UNPAUSE_RESULT=NOTHING"; exit 0
fi
ids=$(grep -E '^[0-9a-f-]{36}$' "$STATE/kill-switch.paused-ids")
[ -n "$ids" ] || { log "the saved id list holds no valid ids"; echo "UNPAUSE_RESULT=FAIL"; exit 1; }
SB_URL=$(envval NEXT_PUBLIC_SUPABASE_URL); SB_KEY=$(envval SUPABASE_SERVICE_ROLE_KEY)
[ -n "$SB_URL" ] && [ -n "$SB_KEY" ] || { log "Supabase URL/service key not found in $ENV_FILE"; echo "UNPAUSE_RESULT=FAIL"; exit 1; }
list=$(paste -sd, - <<< "$ids")
if body=$(printf 'apikey: %s\nAuthorization: Bearer %s\nContent-Type: application/json\nPrefer: return=representation\n' "$SB_KEY" "$SB_KEY" \
  | curl -fsS --max-time 15 -H @- -X PATCH "$SB_URL/rest/v1/algorithms?status=eq.paused&id=in.($list)&select=id" -d '{"status":"active"}'); then
  mirroring=$(mirroring_of "$list")
  # the engagement's other targets, which this un-pause does not wake: how many of them stay paused (DEBT D-35)
  others=$(grep -E '^[0-9a-f-]{36}$' "$STATE/kill-switch.flatten-ids" 2> /dev/null | sort -u | comm -23 - <(sort -u <<< "$ids") | paste -sd, - || true)
  left_paused=0; left_ids=""
  [ -z "$others" ] || read -r left_paused left_ids <<< "$(still_paused "$others")"
  unset SB_KEY
  n=$(python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' <<< "$body" 2> /dev/null || echo "?")
  warn_broker
  result=OK
  # the ledger line first: when it cannot be written, the failed-broker list stays
  if printf '%s UNPAUSE algorithms=%s of %s saved left_paused=%s broker_failed_cleared=%s broker_unknown_cleared=%s mirroring=%s\n' "$(date -u +%FT%TZ)" "$n" "$(grep -c . <<< "$ids")" "$left_paused" "${broker_n:-0}" "${broker_unknown:-0}" "$mirroring" >> "$LEDGER" 2> /dev/null; then
    end_engagement
  else
    end_engagement keep-broker; result=PARTIAL; log "ledger write FAILED; the failed-broker list is kept"
  fi
  log "re-activated $n of the $(grep -c . <<< "$ids") algorithm(s) the kill switch had saved (the rest were already active, or are gone); live_trading_enabled on/total: $mirroring"
  case "$left_paused" in
    0) ;;
    "?") log "could not read whether the engagement's other targets are still paused: check the algorithms page" ;;
    *) log "$left_paused algorithm(s) this engagement also targeted stay paused ($left_ids): an earlier engagement paused them and a fresh one did not save them; activate them in the app if they should trade" ;;
  esac
  echo "UNPAUSE_RESULT=$result"
  [ "$result" = OK ] || exit 1
else
  mirroring=$(mirroring_of "$list")
  unset SB_KEY
  log "PATCH FAILED (database unreachable, or a timeout after it committed): the algorithms may be active; the saved id list is kept — check the database, then make unpause again"
  printf '%s UNPAUSE result=unknown algorithms=? of %s saved mirroring=%s\n' "$(date -u +%FT%TZ)" "$(grep -c . <<< "$ids")" "$mirroring" >> "$LEDGER" 2> /dev/null || log "ledger write FAILED"
  echo "UNPAUSE_RESULT=FAIL"; exit 1
fi
