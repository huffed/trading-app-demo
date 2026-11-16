#!/usr/bin/env bash
# scripts/ops/unpause.sh — runs ON THE VPS as `ops`, streamed by `make unpause`: the operator's
# deliberate act that re-activates exactly the algorithms the kill switch paused (the ids it saved),
# never every paused algorithm. Refuses while the service is not active (resume first). Writes an
# UNPAUSE line with the number of rows actually changed, how many algorithms the engagement also targeted
# stay paused (left_paused: un-pause wakes only the ids it saved), what the
# failed-broker list held, and the mirroring state of the saved ids, and ends the engagement: the saved id
# list, the flatten list and the failed-broker list go. An engagement that only the ledger records (a KILL line after
# the last UNPAUSE line, when the switch could create no file) ends the same way. A broker position on that list may
# still be open, so it says so before the list goes, also when there is nothing to un-pause. When the PATCH fails it may
# still have committed (a timeout after the commit), so it writes an UNPAUSE result=unknown line and keeps
# them all. After a switch whose last run could not confirm its pause (its KILL line says paused=FAILED or unknown, or it
# left its marker and no KILL line), it ends nothing when no list remains, or when none of the saved ids was still
# paused: the algorithms may be active. After a last run that could not read the active algorithms (paused=FAILED) it
# ends nothing either: that run saved no list, so the one left is an earlier run's.
# Exit status is non-zero on any failure.
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
# Ends the engagement. With keep-records, used when the ledger line was not written, the failed-broker list and the
# engagement marker stay: the broker list is the only reminder of broker positions that may still be open, and the
# marker lets the next un-pause end the engagement in the ledger, which resume reads. The ids this run saved leave the
# flatten list, because the switch flattens every id on it whatever its status; the other targets stay on it, for a
# later switch and the next un-pause's count. When the flatten list cannot be rewritten (a full disk) it is set aside
# whole as kill-switch.flatten-ids.kept, which the switch does not read; a rename needs no free block, and when even
# that fails the list goes, and with it only a count. The saved list goes: what this run woke is in kill-switch.log and
# its output, not in the ledger (DEBT D-35); an empty kill-switch.woken says it woke them, so that the run asked to
# repeat it can end the engagement whatever the switch's KILL line says, and the next switch removes it.
set_aside() { # $1 file: appended to, or renamed to, $1.kept, else removed
  { cat "$1" >> "$1.kept" 2> /dev/null && rm -f "$1"; } || mv -f "$1" "$1.kept" 2> /dev/null || rm -f "$1"
}
end_engagement() {
  local f=$STATE/kill-switch.flatten-ids saved=$STATE/kill-switch.paused-ids
  rm -f "$STATE/crontab.unsaved"
  if [ "${1:-}" != keep-records ]; then
    rm -f "$saved" "$f" "$f.kept" "$STATE/kill-switch.broker-failed" "$STATE/kill-switch.engaged" "$STATE/kill-switch.woken"
    return 0
  fi
  [ -s "$saved" ] || return 0
  true >> "$STATE/kill-switch.woken" 2> /dev/null \
    || log "could not leave $STATE/kill-switch.woken: if the next make unpause is refused, create that file as ops (touch) and run make unpause again, rather than the switch, which would flatten the positions of what this run woke"
  if [ -e "$f" ]; then
    if comm -23 <(sort -u "$f") <(sort -u "$saved") > "$f.new" 2> /dev/null; then
      if [ ! -s "$f.new" ]; then rm -f "$f.new" "$f"; elif ! mv -f "$f.new" "$f" 2> /dev/null; then rm -f "$f.new"; set_aside "$f"; fi
    else
      rm -f "$f.new"; set_aside "$f"
    fi
  fi
  rm -f "$saved"
}
# the engagement's targets: the flatten list, and one an un-pause set aside whole
targets_of() { cat "$STATE/kill-switch.flatten-ids" "$STATE/kill-switch.flatten-ids.kept" 2> /dev/null | grep -E '^[0-9a-f-]{36}$' | sort -u; }
# The failed-broker list: "<id> <positions not closed>", or "<id> ?" when a flatten's answer was lost (kill-switch.sh).
BROKER_FILE=$STATE/kill-switch.broker-failed
broker_n=0; broker_unknown=0
if [ -f "$BROKER_FILE" ]; then
  broker_n=$(awk '$2 ~ /^[0-9]+$/ {n += $2} END {print n + 0}' "$BROKER_FILE" 2> /dev/null)
  broker_unknown=$(awk 'NF && $2 !~ /^[0-9]+$/ {print $1}' "$BROKER_FILE" 2> /dev/null | sort -u | grep -c . || true)
fi
# the failed-broker list's ids, short, for the ledger line, which outlives the rotated kill-switch.log
broker_ids=$(awk 'NF {print substr($1, 1, 8)}' "$BROKER_FILE" 2> /dev/null | sort -u | paste -sd, - || true)
warn_broker() { # $1 gone or kept: whether the list goes now, which until then reminded every kill-switch run
  [ "${broker_n:-0}" = 0 ] && [ "${broker_unknown:-0}" = 0 ] && return 0
  local after="this list now goes and no later run will remind you"
  [ "$1" = kept ] && after="the list is kept, because the ledger line that records it was not written"
  log "the failed-broker list held ${broker_n:-0} broker position(s) the switch could not close and ${broker_unknown:-0} algorithm(s) whose flatten answer was unknown ($(awk '{print $1}' "$BROKER_FILE" 2> /dev/null | sort -u | paste -sd' ' -)): they may still be open, so check the broker account; $after"
}
# why left_paused is "?", unless a later check says otherwise
unknown_why="could not read whether the engagement's other targets are still paused"
# the switch's last run could not confirm its pause: its list failed, its PATCH failed, or the database could not be
# read; or it left its marker and no KILL line to say. An un-pause since that run that woke its list
# (kill-switch.woken, which the next switch removes) showed the pause had committed.
switch_did_not_pause() {
  [ ! -e "$STATE/kill-switch.woken" ] || return 1
  if [ -z "$kill_lines" ]; then [ -e "$STATE/kill-switch.engaged" ]; return; fi
  tail -n 1 <<< "$kill_lines" | grep -qE ' paused=(FAILED|unknown) '
}
# the switch's last run could not read the active algorithms, so it saved no list: a list left is an earlier run's
switch_saved_none() { tail -n 1 <<< "$kill_lines" | grep -qE ' paused=FAILED '; }
not_paused_fail() { # $1 what this run found; $2 "app" when the saved list remains, so a pause in the app also works
  local way="run make kill-switch again, then make resume, then make unpause (the switch pauses what is active)"
  [ "${2:-}" != app ] || way="$way; if you activated them yourself, pause them in the app and run make unpause again"
  log "$1, and the kill switch's last run could not confirm its pause (its KILL line says paused=FAILED or unknown, or it left none), so algorithms may still be active: $way; this run ends nothing"
  echo "UNPAUSE_RESULT=FAIL"; exit 1
}
# a flatten list the switch could not save does not hold this engagement's targets, so none of them can be counted;
# nor can those of an earlier run that left no KILL line
unknown_if_unsaved() {
  if grep -qE '[= ]save-targets( |$)' <<< "$kill_lines"; then
    left_paused="?"; unknown_why="the kill switch could not save its flatten list, so which of its targets stay paused is not known"
  elif grep -qE '[= ]earlier-run-unrecorded( |$)' <<< "$kill_lines"; then
    left_paused="?"; unknown_why="an earlier kill switch run left no KILL line, so which algorithms it paused is not known"
  fi
}
report_left_paused() {
  case "$left_paused" in
    0) ;;
    "?") log "$unknown_why: check the algorithms page" ;;
    *) log "$left_paused algorithm(s) this engagement also targeted stay paused ($left_ids): un-pause wakes only the ids it saved, and these are not among them (an earlier engagement paused them and a fresh one did not save them, or this one could not save its list); activate them in the app if they should trade" ;;
  esac
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
# the engagement's KILL lines: those after the last UNPAUSE line in the ledger that ended one (a result=unknown line
# ends nothing), which say what a switch could not do
kill_lines=$(grep -E ' (KILL|UNPAUSE) ' "$LEDGER" 2> /dev/null | awk '/ UNPAUSE / {if ($0 !~ / result=unknown /) k = ""; next} {k = k $0 "\n"} END {printf "%s", k}' || true)
# 1 when an UNPAUSE result=unknown line follows the last KILL line: an un-pause's PATCH may have committed since
unpause_unknown=$(grep -E ' (KILL|UNPAUSE) ' "$LEDGER" 2> /dev/null | awk '/ KILL / {u = 0} / UNPAUSE result=unknown / {u = 1} END {print u + 0}' || true)
if ! [ -s "$STATE/kill-switch.paused-ids" ]; then
  # nothing to wake, but an engagement may remain: in its other lists, or only in the ledger as a KILL line after the
  # last UNPAUSE line, when the switch could create no file (resume reads that line too). Say what goes, and record it
  # when anything did, so the engagement ends.
  # a switch whose last run could not pause left its algorithms active with no list of them: ending its engagement here
  # would let resume take them for algorithms un-paused on purpose
  switch_did_not_pause && not_paused_fail "no list of what the kill switch paused remains"
  left=$({
    for f in kill-switch.engaged kill-switch.flatten-ids kill-switch.flatten-ids.kept kill-switch.broker-failed; do [ -e "$STATE/$f" ] && echo "$f"; done
    [ -z "$kill_lines" ] || echo ledger-kill
  } | paste -sd, - || true)
  log "nothing to un-pause: $STATE/kill-switch.paused-ids is missing or empty${left:+; clearing $left}"
  # the engagement's targets wake with nothing here: say how many stay paused (DEBT D-35)
  left_paused=0; left_ids=""
  targets=$(targets_of | paste -sd, - || true)
  if [ -n "$targets" ]; then
    SB_URL=$(envval NEXT_PUBLIC_SUPABASE_URL); SB_KEY=$(envval SUPABASE_SERVICE_ROLE_KEY)
    if [ -n "$SB_URL" ] && [ -n "$SB_KEY" ]; then read -r left_paused left_ids <<< "$(still_paused "$targets")"; else left_paused="?"; fi
    unset SB_KEY
    unknown_if_unsaved
    report_left_paused
  elif { [ -e "$STATE/kill-switch.engaged" ] && [ -z "$kill_lines" ]; } || grep -qE '[= ](save-ids|save-targets|earlier-run-unrecorded)( |$)' <<< "$kill_lines"; then
    # the switch could not save its lists, or a run left no KILL line to say whether it did; one that found nothing
    # to pause saved nothing, and its line says so
    left_paused="?"
    log "no list of what the kill switch paused remains (its KILL line names save-ids, save-targets or earlier-run-unrecorded, or is missing): check the algorithms page for algorithms it left paused"
  fi
  # the ledger line first: when it cannot be written, the failed-broker list stays
  # the broker counts first, as the daily summary shows the ledger's last line cut at 120 characters
  if [ -n "$left" ] && ! printf '%s UNPAUSE result=nothing broker_failed_cleared=%s broker_unknown_cleared=%s cleared=%s left_paused=%s broker_ids=%s mirroring=n/a\n' "$(date -u +%FT%TZ)" "${broker_n:-0}" "${broker_unknown:-0}" "$left" "$left_paused" "${broker_ids:-none}" >> "$LEDGER" 2> /dev/null; then
    warn_broker kept; end_engagement keep-records; log "ledger write FAILED: the engagement stays open; run make unpause again once the ledger can be written"; echo "UNPAUSE_RESULT=PARTIAL"; exit 1
  fi
  warn_broker gone
  end_engagement
  # broker positions that may still be open, or targets this run woke none of that may stay paused, are not a clean
  # end, whatever else went well
  if [ "${broker_n:-0}" != 0 ] || [ "${broker_unknown:-0}" != 0 ] || [ "$left_paused" != 0 ]; then echo "UNPAUSE_RESULT=PARTIAL"; exit 1; fi
  echo "UNPAUSE_RESULT=NOTHING"; exit 0
fi
ids=$(grep -E '^[0-9a-f-]{36}$' "$STATE/kill-switch.paused-ids")
[ -n "$ids" ] || { log "the saved id list holds no valid ids"; echo "UNPAUSE_RESULT=FAIL"; exit 1; }
# what the last run should have paused is in no list, and may be active: a pause in the app changes no KILL line
! switch_saved_none || not_paused_fail "the saved list is an earlier run's, since the last run could not read the active algorithms and saved none"
SB_URL=$(envval NEXT_PUBLIC_SUPABASE_URL); SB_KEY=$(envval SUPABASE_SERVICE_ROLE_KEY)
[ -n "$SB_URL" ] && [ -n "$SB_KEY" ] || { log "Supabase URL/service key not found in $ENV_FILE"; echo "UNPAUSE_RESULT=FAIL"; exit 1; }
list=$(paste -sd, - <<< "$ids")
if body=$(printf 'apikey: %s\nAuthorization: Bearer %s\nContent-Type: application/json\nPrefer: return=representation\n' "$SB_KEY" "$SB_KEY" \
  | curl -fsS --max-time 15 -H @- -X PATCH "$SB_URL/rest/v1/algorithms?status=eq.paused&id=in.($list)&select=id" -d '{"status":"active"}'); then
  mirroring=$(mirroring_of "$list")
  # the engagement's other targets, which this un-pause does not wake: how many of them stay paused (DEBT D-35)
  others=$(targets_of | comm -23 - <(sort -u <<< "$ids") | paste -sd, - || true)
  left_paused=0; left_ids=""
  [ -z "$others" ] || read -r left_paused left_ids <<< "$(still_paused "$others")"
  unknown_if_unsaved
  unset SB_KEY
  n=$(python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' <<< "$body" 2> /dev/null || echo "?")
  # none of them was still paused after a switch that could not confirm its pause: its PATCH most likely did not commit,
  # unless an earlier un-pause's PATCH, whose answer was lost, woke them
  [ "$n" != 0 ] || [ "${unpause_unknown:-0}" = 1 ] || ! switch_did_not_pause \
    || not_paused_fail "none of the $(grep -c . <<< "$ids") saved algorithm(s) was still paused" app
  result=OK
  # the ledger line first: when it cannot be written, the failed-broker list stays
  # the fields dev's line had, then the broker counts, come first, as the daily summary shows the ledger's last line cut
  # at 120 characters
  if printf '%s UNPAUSE algorithms=%s of %s saved mirroring=%s broker_failed_cleared=%s broker_unknown_cleared=%s left_paused=%s broker_ids=%s\n' "$(date -u +%FT%TZ)" "$n" "$(grep -c . <<< "$ids")" "$mirroring" "${broker_n:-0}" "${broker_unknown:-0}" "$left_paused" "${broker_ids:-none}" >> "$LEDGER" 2> /dev/null; then
    warn_broker gone; end_engagement
    { [ "${broker_n:-0}" = 0 ] && [ "${broker_unknown:-0}" = 0 ]; } || result=PARTIAL
  else
    warn_broker kept; end_engagement keep-records; result=PARTIAL; log "ledger write FAILED: the engagement stays open; run make unpause again once the ledger can be written"
  fi
  log "re-activated $n of the $(grep -c . <<< "$ids") algorithm(s) the kill switch had saved (the rest were already active, or are gone); live_trading_enabled on/total: $mirroring"
  report_left_paused
  echo "UNPAUSE_RESULT=$result"
  [ "$result" = OK ] || exit 1
else
  mirroring=$(mirroring_of "$list")
  unset SB_KEY
  log "PATCH FAILED (database unreachable, or a timeout after it committed): the algorithms may be active; the saved id list is kept — check the database, then make unpause again"
  printf '%s UNPAUSE result=unknown algorithms=? of %s saved mirroring=%s\n' "$(date -u +%FT%TZ)" "$(grep -c . <<< "$ids")" "$mirroring" >> "$LEDGER" 2> /dev/null || log "ledger write FAILED"
  echo "UNPAUSE_RESULT=FAIL"; exit 1
fi
