#!/usr/bin/env bash
# scripts/ops/deploy.sh — runs ON THE VPS, detached, started by scripts/ops/deploy-driver.sh
# (`make deploy`). The driver copies this file from a checkout whose scripts/ops/ equals
# origin/dev, resolves REF to a commit, and follows the run log.
#
#   deploy.sh <40-hex sha> [ref label]
#
# One run at a time (flock). Every phase is loud and every outcome is one line in
# /var/log/quanttrader/deploys.log (OK, or FAIL with the commit that is still running
# and the step that failed). Order: fetch → refuse a dirty tree → detached checkout →
# host Node must equal .nvmrc → pnpm install --frozen-lockfile → pnpm build (if either
# fails, the tree and the build of the running commit are restored: `next build` empties
# .next first) → wait for a gap between cron ticks with no wrapper running →
# systemctl restart → service active, its Node equals .nvmrc, /login 200 → the next
# manage, heartbeat (stale_count 0) and scan ticks log http=200 → running.sha → OK.
# No secret is read or printed: the cron wrappers authenticate the routes themselves.
# Root today (D.1); `ops` after D.2 with `sudo -n systemctl restart` as the privileged step.
set -euo pipefail

APP=/opt/quanttrader
LOGDIR=/var/log/quanttrader
LEDGER=$LOGDIR/deploys.log
RUNNING=$LOGDIR/running.sha # the verified running commit; written only after a verified restart
SHA=${1:-}
REF=${2:-${1:-}}
PREV="?"
PHASE=start # start | checked-out | restarted
RESTART_AT=""

log() { printf '[%s] deploy: %s\n' "$(date -u +%FT%TZ)" "$*"; }
ledger() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LEDGER" 2> /dev/null || true; }
fail() {
  trap - ERR
  set +e
  local step=$1
  ledger "FAIL ref=$REF sha=$SHA running=$PREV phase=$PHASE step=$step"
  log "FAILED ($PHASE): $step"
  case "$PHASE" in
    checked-out) restore_previous ;;
    restarted) log "the new build is live and failed verification; roll back now: make deploy REF=$PREV" ;;
  esac
  echo "DEPLOY_RESULT=FAIL"
  exit 1
}
restore_previous() {
  log "restoring the working tree and the build of ${PREV:0:12} (the running process was not restarted)"
  if git checkout --quiet --detach "$PREV" \
    && pnpm install --frozen-lockfile > "$LOGDIR/restore-install.log" 2>&1 \
    && pnpm build > "$LOGDIR/restore-build.log" 2>&1; then
    log "restored ${PREV:0:12} on disk; the service keeps running the same commit"
  else
    log "RESTORE FAILED: the running process has no build on disk; run  make deploy REF=$PREV  now (logs: $LOGDIR/restore-*.log)"
  fi
}
sec_into_tick() { echo $(((10#$(date +%M) % 5) * 60 + 10#$(date +%S))); }
wrappers_running() { pgrep -f '/opt/quanttrader/scripts/[a-z-]*-cron\.sh' > /dev/null; }
wait_for_gap() { # 20..200 s after a tick (manage + heartbeat every 5 min at :00, scan every 15) and no wrapper still running
  local s said=0
  while :; do
    s=$(sec_into_tick)
    if [ "$s" -ge 20 ] && [ "$s" -le 200 ]; then
      wrappers_running || return 0
      [ "$said" = 1 ] || { log "a cron wrapper is still running; waiting for it to finish"; said=1; }
    fi
    sleep 5
  done
}
avoid_tick_edge() { # never start a long step in the last minute before a tick or the first 20 s after one
  local s
  s=$(sec_into_tick)
  while [ "$s" -gt 240 ] || [ "$s" -lt 20 ]; do
    sleep 5
    s=$(sec_into_tick)
  done
}
http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" || true; }
service_node() { # the Node binary of the service's main process, e.g. v25.9.0
  local pid exe
  pid=$(systemctl show -p MainPID --value quanttrader)
  exe=$(readlink "/proc/$pid/exe" 2> /dev/null || true)
  if [ -n "$exe" ]; then "$exe" --version 2> /dev/null || echo "?"; else echo "?"; fi
}
wait_for_ticks() { # the next manage, heartbeat and scan ticks after the restart must log http=200 (heartbeat also stale_count 0)
  local deadline spec name need line stamp
  deadline=$(($(date +%s) + 17 * 60)) # scan runs every 15 minutes
  for spec in 'manage:' 'heartbeat:"stale_count":0' 'scan:'; do
    name=${spec%%:*}
    need=${spec#*:}
    while :; do
      line=$(tail -n 40 "$LOGDIR/$name.log" 2> /dev/null | grep 'http=' | tail -n 1 || true)
      stamp=${line:1:20}
      if [ -n "$stamp" ] && [[ "$stamp" > "$RESTART_AT" ]]; then
        grep -q 'http=200' <<< "$line" || fail "$name tick at $stamp logged: ${line:22:120}"
        if [ -n "$need" ]; then
          grep -qF -- "$need" <<< "$line" || fail "$name tick at $stamp answered 200 but is not healthy: ${line:22:160}"
        fi
        log "$name tick at $stamp: http=200${need:+ and $need}"
        break
      fi
      [ "$(date +%s)" -lt "$deadline" ] || fail "no $name tick logged within 17 min of the restart (is cron running?)"
      sleep 10
    done
  done
}

main() {
  local want have runtime code t0
  [[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || {
    echo "usage: deploy.sh <40-hex sha> [ref label] (the driver resolves names)" >&2
    exit 2
  }
  if [ "$(id -u)" = 0 ] && [ -s /root/.nvm/nvm.sh ]; then # root's toolchain today; gone after D.2
    set +u
    . /root/.nvm/nvm.sh
    set -u
  fi
  set -E
  trap 'fail "unexpected error at line $LINENO"' ERR
  export CI=1 # pnpm and next: non-interactive, no prompts
  exec 9> "$LOGDIR/.deploy.lock"
  flock -n 9 || fail "another deploy is running"
  cd "$APP" || fail "cd $APP"
  command -v node > /dev/null || fail "node is not on PATH"
  command -v pnpm > /dev/null || fail "pnpm is not on PATH"
  [ -z "$(git status --porcelain)" ] || fail "working tree is dirty; refusing to deploy over local changes"
  if [ -s "$RUNNING" ]; then
    PREV=$(cat "$RUNNING")
  else
    PREV=$(git rev-parse HEAD)
    log "no $RUNNING yet: taking the checked-out commit ${PREV:0:12} as the running one"
  fi
  git fetch --prune --quiet origin || fail "git fetch origin"
  git cat-file -e "${SHA}^{commit}" 2> /dev/null || fail "commit $SHA is not on origin"
  log "deploying ${SHA:0:12} ($REF); running ${PREV:0:12}; host node $(node -v), pnpm $(pnpm -v)"

  avoid_tick_edge # install and build rewrite node_modules and .next under the running server
  git checkout --quiet --detach "$SHA" || fail "git checkout $SHA"
  PHASE=checked-out
  if [ -f .nvmrc ]; then
    want=$(tr -d 'v[:space:]' < .nvmrc)
    have=$(node -v | tr -d 'v')
    [ "$have" = "$want" ] || fail "host Node is $have but .nvmrc at ${SHA:0:12} wants $want (docs/PHASE_D_PLAN.md D.2)"
  else
    want=""
    log "no .nvmrc at ${SHA:0:12}; it will run on the host's Node $(node -v)"
  fi
  log "pnpm install --frozen-lockfile"
  pnpm install --frozen-lockfile > "$LOGDIR/deploy-install.log" 2>&1 || {
    tail -n 20 "$LOGDIR/deploy-install.log"
    fail "pnpm install --frozen-lockfile ($LOGDIR/deploy-install.log)"
  }
  t0=$(date +%s)
  log "pnpm build"
  pnpm build > "$LOGDIR/deploy-build.log" 2>&1 || {
    tail -n 30 "$LOGDIR/deploy-build.log"
    fail "pnpm build ($LOGDIR/deploy-build.log)"
  }
  log "built in $(($(date +%s) - t0)) s"

  wait_for_gap
  RESTART_AT=$(date -u +%FT%TZ)
  log "restarting quanttrader (between ticks, no wrapper running)"
  if [ "$(id -u)" = 0 ]; then
    systemctl restart quanttrader || fail "systemctl restart quanttrader"
  else
    sudo -n systemctl restart quanttrader || fail "sudo -n systemctl restart quanttrader"
  fi
  PHASE=restarted
  sleep 3
  [ "$(systemctl is-active quanttrader)" = active ] || fail "service is '$(systemctl is-active quanttrader)' after the restart"
  runtime=$(service_node)
  if [ -n "$want" ] && [ "${runtime#v}" != "$want" ]; then
    fail "the service runs Node $runtime but .nvmrc wants $want (check ExecStart/PATH in the unit)"
  fi
  code=000
  for _ in $(seq 1 45); do
    code=$(http_code http://localhost:3000/login)
    [ "$code" = 200 ] && break
    sleep 2
  done
  [ "$code" = 200 ] || fail "/login answered $code (45 attempts, 2 s apart, 5 s timeout each)"
  log "service active on Node $runtime; /login 200; waiting for the next manage, heartbeat and scan ticks"
  wait_for_ticks

  printf '%s\n' "$SHA" > "$RUNNING"
  ledger "OK ref=$REF sha=$SHA prev=$PREV runtime=$runtime restart=$RESTART_AT"
  log "OK ${SHA:0:12} is live (was ${PREV:0:12}); rollback: make deploy REF=$PREV"
  echo "DEPLOYED_SHA=$SHA"
  echo "PREVIOUS_SHA=$PREV"
  echo "DEPLOY_RESULT=OK"
}
main "$@"
exit
