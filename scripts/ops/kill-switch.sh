#!/usr/bin/env bash
# scripts/ops/kill-switch.sh — runs ON THE VPS as `ops`, streamed by `make kill-switch` from the
# workstation's local copy of origin/dev (no fetch: the switch must not depend on GitHub). On the
# host itself (after a deploy has put it in the checkout): sudo -u ops bash /opt/quanttrader/scripts/ops/kill-switch.sh <reason>
#
#   kill-switch.sh [reason]      idempotent; safe to run twice; allowed in market hours
#
# Order — every step attempted even if an earlier one failed (fail closed), nothing here waits on
# the database or the app before the schedulers are gone:
#   1. disable the crontab (saved to /var/lib/quanttrader/crontab.disabled; removed even when that copy
#      cannot be written, because no new tick matters more than an exact restore) — no new ticks;
#   2. pause every ACTIVE algorithm (Supabase REST, service role read from .env.local on the host);
#      the ids are saved for `make unpause`, and while the crontab is already empty (the same
#      engagement) they are merged with the ids a previous run saved;
#   3. flatten the open positions of those algorithms, and of every id this engagement has targeted
#      (kill-switch.flatten-ids, kept until `make unpause`), through the app's own
#      /api/admin/flatten-algo route on loopback — paper rows, and the broker side of any position
#      that carries a broker_position_id; a broker position that did not close is an error even though
#      the route answers 200, in this run and in every later run until `make unpause`; so is a flatten
#      whose answer was lost after it may have run (a timeout, a dropped reply, a 5xx, an unreadable 200),
#      recorded as unknown; after the app stops answering (connection refused / timeout) the remaining
#      ids are skipped, not waited on;
#   4. stop AND disable the service (a reboot must not bring trading back);
#   5. count every open position, split into those the switch targeted (open_after) and those it did
#      not (open_untargeted, for example an algorithm alpha-decay paused, whose ids it prints), both
#      errors; read their
#      mirroring state, alert (ntfy, urgent) and write a KILL line to /var/log/quanttrader/deploys.log
#      that says exactly what succeeded and what did not.
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
TARGETS_FILE=$STATE/kill-switch.flatten-ids
BROKER_FILE=$STATE/kill-switch.broker-failed
REASON=${1:-operator}
[[ "$REASON" =~ ^[A-Za-z0-9_.-]{1,40}$ ]] || REASON=operator
T0=$(date -u +%FT%TZ)
errors=()
paused="?"
flattened="?"
crons="?"
open_after="?"
open_untargeted="?"

log() { printf '[%s] kill-switch: %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOGDIR/kill-switch.log" 2> /dev/null; }
envval() { grep -E "^$1=" "$ENV_FILE" 2> /dev/null | head -n 1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }
ids_from_json() { python3 -c 'import json,sys; print("\n".join(r["id"] for r in json.load(sys.stdin)))' 2> /dev/null; }
valid_ids() { grep -E '^[0-9a-f-]{36}$'; }
save_ids() { # $1 file, ids on stdin: replaced whole or not at all, so a full disk cannot empty a saved list
  valid_ids | sort -u > "$1.new" && mv "$1.new" "$1"
}
sb_get() { # $1 path+query → body on stdout; needs SB_URL/SB_KEY
  printf 'apikey: %s\nAuthorization: Bearer %s\n' "$SB_KEY" "$SB_KEY" | curl -fsS --max-time 15 -H @- "$SB_URL/rest/v1/$1"
}
# the route's {"flattened":N,"results":[…]} → "<touched> <broker positions not closed>": the paper row
# closes whatever the broker answered, and paper-only on a row with a broker id means no adapter or
# connection was found, so the close was never attempted (DEBT D-25)
flatten_counts() {
  python3 -c 'import json,sys
r=json.load(sys.stdin)["results"]
def stuck(x):
    s=str(x.get("status",""))
    return s.startswith("broker-failed:") or (s=="paper-only" and x.get("broker_position_id"))
print(len(r), sum(1 for x in r if stuck(x)))' 2> /dev/null
}
open_split() { # $1 target ids, stdin rows with algorithm_id → "<on a target> <on anything else> [their algorithm ids]"
  python3 -c 'import json,sys
t=set(sys.argv[1].split())
r=json.load(sys.stdin)
on=sum(1 for x in r if x["algorithm_id"] in t)
print(on, len(r)-on, *sorted({x["algorithm_id"] for x in r if x["algorithm_id"] not in t}))' "$1" 2> /dev/null
}
# A flatten whose answer was lost may have closed paper rows whose broker close failed: the route closes the
# paper row whatever the broker answered. So the id goes on the broker list as unknown (DEBT D-35).
lost() { # $1 id
  if printf '%s ?\n' "$1" >> "$BROKER_FILE" 2> /dev/null; then
    log "flatten for ${1:0:8}: its answer was lost after the route may have run; any broker close that failed is unknown, recorded in $BROKER_FILE"
  else
    errors+=("save-broker-failed"); log "flatten for ${1:0:8}: its answer was lost, and recording that in $BROKER_FILE FAILED: check the broker account"
  fi
}
mirroring_of() { # $1 comma list of ids → "<on>/<total>" algorithms with live_trading_enabled, "?" when unreadable
  local body
  if body=$(sb_get "algorithms?id=in.($1)&select=live_trading_enabled"); then
    python3 -c 'import json,sys
r=json.load(sys.stdin)
print("%d/%d" % (sum(1 for x in r if x.get("live_trading_enabled")), len(r)))' <<< "$body" 2> /dev/null || echo "?"
  else
    echo "?"
  fi
}
push() { # $1 text
  { [ -n "$NTFY_TOKEN" ] && printf 'Authorization: Bearer %s\n' "$NTFY_TOKEN" || printf 'X-Unused: 1\n'; } \
    | curl -fsS --max-time 15 -H @- -H "Title: quanttrader-prod KILL SWITCH" -H "Priority: urgent" -H "Tags: rotating_light" -d "$1" "https://ntfy.sh/$NTFY_TOPIC" > /dev/null
}

[ "$(id -un)" = ops ] || { echo "kill-switch: run as ops (sudo -u ops bash $0 <reason>); refusing as $(id -un)" >&2; exit 2; }
mkdir -p "$STATE" 2> /dev/null || true
# The engagement is marked first, before anything can fail: an empty file needs no data blocks, so it is there even
# on a full disk. resume.sh reads it so that a running engine the switch could not stop is never taken for a healthy
# one, and only make unpause removes it (DEBT D-35).
true >> "$STATE/kill-switch.engaged" 2> /dev/null || errors+=("mark-engaged")
log "engaged by $REASON at $T0 on $(hostname)"

# 1. no new ticks: disable the crontab (idempotent — an empty crontab keeps the saved copy). The copy is written
# beside the old one and moved over it, so a full disk never truncates an earlier copy, and the crontab goes even
# when the copy fails: ops/crontab is in the repo (DEBT D-35).
current=$(crontab -l 2> /dev/null || true)
if [ -n "$current" ]; then
  # crontab.unsaved says the saved copy is not this crontab, for resume, until a later copy is saved; an empty
  # file needs no data blocks
  if printf '%s\n' "$current" > "$STATE/crontab.disabled.new" 2> /dev/null && mv "$STATE/crontab.disabled.new" "$STATE/crontab.disabled" 2> /dev/null; then
    saved=disabled; copy="$(grep -c '^[0-9*]' <<< "$current") entries saved to $STATE/crontab.disabled"
    rm -f "$STATE/crontab.unsaved" 2> /dev/null
  else
    saved=disabled-unsaved
    rm -f "$STATE/crontab.disabled.new" 2> /dev/null
    true >> "$STATE/crontab.unsaved" 2> /dev/null || errors+=("mark-unsaved")
    errors+=("save-crontab")
    if [ -s "$STATE/crontab.disabled" ]; then
      copy="its copy NOT saved (full disk?): make resume would restore an OLDER copy; if it differs from ops/crontab, replace $STATE/crontab.disabled with ops/crontab first (never install the live crontab), then make resume, which reports older-crontab unless the copy then equals ops/crontab"
    else
      copy="its copy NOT saved (full disk?) and there is none: run make resume, and once it reports no-saved-crontab, install ops/crontab as ops (runbook, Rollback); make deploy does not see this stop, so do not deploy until then"
    fi
  fi
  if crontab -r; then
    crons=$saved; log "crontab disabled; $copy"
  else
    # the crons are still on, so resume restores nothing and the hints above do not apply
    crons=FAILED; errors+=("crontab")
    [ "$saved" = disabled ] || copy="its copy NOT saved either"
    log "crontab disable FAILED, so the crons are still on: run make kill-switch again; $copy"
  fi
else
  crons=already-empty; log "crontab already empty"
fi

# 2. pause every active algorithm; remember the ids
SB_URL=$(envval NEXT_PUBLIC_SUPABASE_URL)
SB_KEY=$(envval SUPABASE_SERVICE_ROLE_KEY)
ids=""
# Two lists, because a crontab that is back does not end an engagement: make resume restores it (DEBT
# D-27). The flatten list holds every id this engagement targeted and only make unpause clears it. The
# un-pause list is narrower: a fresh engagement replaces it, so an un-pause never wakes algorithms that
# were paused on purpose after the last one, and it keeps old ids only while the crontab is still empty.
saved_ids=$(cat "$IDS_FILE" "$TARGETS_FILE" 2> /dev/null | valid_ids | sort -u || true)
keep_ids=""
[ "$crons" = already-empty ] && keep_ids=$(cat "$IDS_FILE" 2> /dev/null | valid_ids || true)
if [ -n "$SB_URL" ] && [ -n "$SB_KEY" ]; then
  if active=$(sb_get "algorithms?status=eq.active&select=id" | ids_from_json); then
    ids=$active
    if [ -n "$ids" ]; then
      # save BEFORE the PATCH: a PATCH that commits but times out must still be un-pausable
      printf '%s\n' "$ids" "$keep_ids" | save_ids "$IDS_FILE" 2> /dev/null || { errors+=("save-ids"); log "saving the ids FAILED"; }
      if printf 'apikey: %s\nAuthorization: Bearer %s\nContent-Type: application/json\nPrefer: return=minimal\n' "$SB_KEY" "$SB_KEY" \
        | curl -fsS --max-time 15 -H @- -X PATCH "$SB_URL/rest/v1/algorithms?status=eq.active" -d '{"status":"paused"}' > /dev/null; then
        paused=$(grep -c . <<< "$ids")
        log "paused $paused active algorithm(s); ids saved to $IDS_FILE"
      else
        paused=unknown; errors+=("pause"); log "pause FAILED, or timed out after it committed — continuing (ids saved)"
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
targets=$(printf '%s\n' "$ids" "$saved_ids" | valid_ids | sort -u || true)
if [ -n "$targets" ]; then
  save_ids "$TARGETS_FILE" <<< "$targets" 2> /dev/null || { errors+=("save-targets"); log "saving the flatten list FAILED"; }
fi

# 3. flatten the positions of those algorithms through the app (paper rows + any broker side)
# the broker list from earlier runs: "<id> <positions not closed>", or "<id> ?" when a flatten's answer was lost; a
# line whose count is not a number (a short write on a full disk) counts as unknown
earlier_n=0; earlier_unknown=0; earlier_ids=""
if [ -f "$BROKER_FILE" ]; then
  earlier_n=$(awk '$2 ~ /^[0-9]+$/ {n += $2} END {print n + 0}' "$BROKER_FILE" 2> /dev/null)
  earlier_unknown=$(awk 'NF && $2 !~ /^[0-9]+$/ {print $1}' "$BROKER_FILE" 2> /dev/null | sort -u | grep -c . || true)
  earlier_ids=$(awk '{print $1}' "$BROKER_FILE" 2> /dev/null | sort -u | paste -sd' ' - || true)
fi
CRON_SECRET=$(envval CRON_SECRET)
if [ -z "$targets" ]; then
  flattened=SKIPPED; log "no algorithm ids to flatten (nothing active and nothing saved${errors:+; see errors})"
elif [ "$(systemctl is-active quanttrader 2> /dev/null || true)" != active ]; then
  flattened=SKIPPED; log "the service is not active (already stopped by an earlier run?); flatten skipped — open_after decides"
elif [ -z "$CRON_SECRET" ]; then
  flattened=FAILED; errors+=("no-cron-secret"); log "CRON_SECRET not found in $ENV_FILE — cannot flatten"
else
  total=0; nfail=0; nbroker=0; skipped=0
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    if [ "$skipped" = 1 ]; then errors+=("flatten-skipped:${id:0:8}"); continue; fi
    if out=$(printf 'Authorization: Bearer %s\n' "$CRON_SECRET" | curl -sS --max-time 60 -H @- -X POST -w '\n%{http_code}' "http://127.0.0.1:3000/api/admin/flatten-algo?id=$id" 2> /dev/null); then
      code=${out##*$'\n'}; body=${out%$'\n'*}
      if [ "$code" = 200 ]; then
        if counts=$(flatten_counts <<< "$body") && [ -n "$counts" ]; then
          touched=${counts% *}; failed=${counts#* }
          total=$((total + touched - failed)); nbroker=$((nbroker + failed))
          if [ "$failed" != 0 ]; then
            errors+=("broker-failed:${id:0:8}:$failed"); log "flatten for ${id:0:8}: $failed broker position(s) NOT closed; the paper rows closed anyway"
            printf '%s %s\n' "$id" "$failed" >> "$BROKER_FILE" 2> /dev/null || errors+=("save-broker-failed")
          fi
        else
          nfail=$((nfail + 1)); errors+=("flatten:${id:0:8}:unreadable"); log "flatten for ${id:0:8} answered 200 with an unreadable body"
          lost "$id"
        fi
      else
        nfail=$((nfail + 1)); errors+=("flatten:${id:0:8}:http$code"); log "flatten for ${id:0:8} answered $code"
        case "$code" in 5*) lost "$id" ;; esac # a 4xx refused before the route ran
      fi
    else
      rc=$?; nfail=$((nfail + 1)); errors+=("flatten:${id:0:8}:curl$rc"); log "flatten for ${id:0:8} failed (curl $rc)"
      [ "$rc" = 7 ] || lost "$id" # a refused connection never reached the route; a timeout or a dropped reply may have
      case "$rc" in 7 | 28) skipped=1; log "the app is not answering; skipping the remaining ids" ;; esac
    fi
  done <<< "$targets"
  if [ "$nfail" = 0 ] && [ "$skipped" = 0 ] && [ "$nbroker" = 0 ]; then
    flattened=$total
  else
    flattened="$total ($nfail failed, $nbroker broker-failed$([ "$skipped" = 1 ] && echo ', rest skipped'))"
  fi
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
if [ "${earlier_n:-0}" != 0 ] || [ "${earlier_unknown:-0}" != 0 ]; then
  [ "${earlier_n:-0}" = 0 ] || errors+=("broker-failed-earlier:$earlier_n")
  [ "${earlier_unknown:-0}" = 0 ] || errors+=("broker-unknown-earlier:$earlier_unknown")
  log "earlier runs could not close ${earlier_n:-0} broker position(s) and lost the flatten answer for ${earlier_unknown:-0} algorithm(s) ($earlier_ids): they may still be open, so check the broker account; make unpause clears this list and says what it held"
fi
mirroring=n/a
if [ -n "$SB_URL" ] && [ -n "$SB_KEY" ]; then
  if [ -n "$targets" ]; then
    mirroring=$(mirroring_of "$(paste -sd, - <<< "$targets")")
    log "mirroring state of those algorithms (live_trading_enabled on/total): $mirroring"
  fi
  if body=$(sb_get "paper_positions?status=eq.open&select=algorithm_id") && counts=$(open_split "$targets" <<< "$body") && [ -n "$counts" ]; then
    read -r open_after open_untargeted untargeted_ids <<< "$counts"
    [ "$open_after" = 0 ] || { errors+=("open-after:$open_after"); log "$open_after position(s) still open on the targeted algorithms — resume, then run the switch again"; }
    [ "$open_untargeted" = 0 ] || { errors+=("open-untargeted:$open_untargeted"); log "$open_untargeted open position(s) on algorithms the switch did not target ($untargeted_ids), and nothing manages a paused algorithm's position — resume, then close them through the flatten route for each of those algorithms"; }
  else
    errors+=("open-after-check"); log "could not count open positions (database unreachable?)"
  fi
fi
unset SB_KEY
summary="KILL SWITCH ($REASON) at $T0: crons=$crons paused=$paused flattened=$flattened service=$service_state open_after=$open_after open_untargeted=$open_untargeted mirroring=$mirroring errors=${errors[*]:-none}"
NTFY_TOPIC=$(envval NTFY_TOPIC)
NTFY_TOKEN=$(envval NTFY_TOKEN)
alert="no-topic"
if [ -n "$NTFY_TOPIC" ]; then
  if push "$summary"; then alert=sent; else alert=FAILED; errors+=("alert"); fi
fi
if ! printf '%s KILL reason=%s crons=%s paused=%s flattened=%s service=%s open_after=%s open_untargeted=%s mirroring=%s alert=%s errors=%s\n' \
  "$(date -u +%FT%TZ)" "$REASON" "$crons" "$paused" "$flattened" "$service_state" "$open_after" "$open_untargeted" "$mirroring" "$alert" "${errors[*]:-none}" >> "$LEDGER" 2> /dev/null; then
  errors+=("ledger"); log "ledger write FAILED"
  # the first push said errors as they stood before this one; without a ledger line this is the only record
  [ -z "$NTFY_TOPIC" ] || push "KILL SWITCH ($REASON): the ledger line was NOT written. errors=${errors[*]}" || log "the second push FAILED"
fi
unset NTFY_TOKEN
log "$summary alert=$alert"
echo "KILL_RESULT=$([ ${#errors[@]} -eq 0 ] && echo OK || echo PARTIAL)"
echo "KILL_ERRORS=${errors[*]:-none}"
echo "resume: make resume   (service + crons back; algorithms stay paused)   un-pause: make unpause"
[ ${#errors[@]} -eq 0 ] || exit 1
