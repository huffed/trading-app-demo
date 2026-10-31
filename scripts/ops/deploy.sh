#!/usr/bin/env bash
# scripts/ops/deploy.sh — runs ON THE VPS. `make deploy [REF=…]` copies the
# workstation's copy to /tmp/qt-deploy.sh and runs it as root (sudo -n -H), so
# the procedure is always the current one even when REF is an old commit.
#
#   deploy.sh [ref]            default origin/dev; any commit, tag or branch
#   deploy.sh <previous sha>   is the rollback: one command, the same path
#
# Idempotent; every step fails loudly and leaves a line in
# /var/log/quanttrader/deploys.log. In order: refuse a dirty tree → fetch →
# detached checkout of the exact commit → the host's Node must match .nvmrc →
# pnpm install --frozen-lockfile → pnpm build → restart between cron ticks →
# /login 200 → heartbeat route 200 with the host's CRON_SECRET (read on the
# host, never printed) → the next scheduled manage and heartbeat ticks log
# http=200 → ledger line. Prints DEPLOYED_SHA= and PREVIOUS_SHA= for the driver.
# Root today (D.1): the checkout, nvm and the service are root's. D.2 makes it
# `ops`, with `sudo -n systemctl restart quanttrader` as the only privileged step.
set -euo pipefail
REF=${1:-origin/dev}
APP=/opt/quanttrader
LOGDIR=/var/log/quanttrader
LEDGER=$LOGDIR/deploys.log
PREV="?"
SHA="?"
log() { printf '[%s] deploy: %s\n' "$(date -u +%FT%TZ)" "$*"; }
fail() {
  log "FAILED: $*"
  printf '%s FAIL ref=%s sha=%s prev=%s step=%s\n' "$(date -u +%FT%TZ)" "$REF" "$SHA" "$PREV" "$*" >> "$LEDGER" 2>/dev/null || true
  exit 1
}
# manage + heartbeat fire at :00 :05 :10 …, scan on the quarter hours (all within a few seconds)
sec_into_tick() { echo $(( (10#$(date +%M) % 5) * 60 + 10#$(date +%S) )); }
wait_for_window() { # 20..200 s after a tick: the wrappers are done and the next tick is ≥ 100 s away
  local s; s=$(sec_into_tick)
  while [ "$s" -lt 20 ] || [ "$s" -gt 200 ]; do sleep 5; s=$(sec_into_tick); done
}
avoid_tick_edge() { # never start a long step in the last minute before a tick or the first 20 s after one
  local s; s=$(sec_into_tick)
  while [ "$s" -gt 240 ] || [ "$s" -lt 20 ]; do sleep 5; s=$(sec_into_tick); done
}
restart_service() { if [ "$(id -u)" = 0 ]; then systemctl restart quanttrader; else sudo -n systemctl restart quanttrader; fi; }
http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" || true; }

cd "$APP" || fail "cd $APP"
if [ "$(id -u)" = 0 ] && [ -s /root/.nvm/nvm.sh ]; then
  set +u # nvm.sh is not clean under set -u
  # shellcheck disable=SC1091
  . /root/.nvm/nvm.sh
  set -u
fi
command -v node >/dev/null || fail "node is not on PATH"
command -v pnpm >/dev/null || fail "pnpm is not on PATH"
[ -z "$(git status --porcelain)" ] || fail "working tree is dirty; refusing to deploy over local changes"
PREV=$(git rev-parse HEAD)
git fetch --prune --quiet origin || fail "git fetch origin"
SHA=$(git rev-parse --verify --quiet "${REF}^{commit}") || fail "unknown ref: $REF"
log "ref $REF = ${SHA:0:12}; host is at ${PREV:0:12}"
git checkout --quiet --detach "$SHA" || fail "git checkout $SHA"

if [ -f .nvmrc ]; then
  want=$(tr -d 'v[:space:]' < .nvmrc)
  if [ "$(type -t nvm)" = function ]; then set +u; nvm use --silent "$want" > /dev/null 2>&1 || true; set -u; fi
  have=$(node -v | tr -d 'v')
  [ "$have" = "$want" ] || fail "host Node is $have but .nvmrc at ${SHA:0:12} wants $want; install it on the host first (docs/PHASE_D_PLAN.md D.2)"
  log "node $have matches .nvmrc"
else
  log "no .nvmrc at ${SHA:0:12}; host node $(node -v)"
fi

avoid_tick_edge # the build rewrites .next under the running server; keep a tick's worth of runway
log "pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile > /tmp/qt-install.log 2>&1 || { tail -n 20 /tmp/qt-install.log; fail "pnpm install --frozen-lockfile (log: /tmp/qt-install.log)"; }
t0=$(date +%s)
log "pnpm build"
pnpm build > /tmp/qt-build.log 2>&1 || { tail -n 30 /tmp/qt-build.log; fail "pnpm build (log: /tmp/qt-build.log)"; }
log "built in $(( $(date +%s) - t0 ))s"

wait_for_window
RESTART_AT=$(date -u +%FT%TZ)
log "restarting quanttrader"
restart_service || fail "systemctl restart quanttrader"
code=000
for _ in $(seq 1 45); do
  code=$(http_code http://localhost:3000/login)
  [ "$code" = 200 ] && break
  sleep 2
done
[ "$code" = 200 ] || fail "/login answered $code within 90 s of the restart"
secret=$(grep -E '^CRON_SECRET=' .env.local | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
[ -n "$secret" ] || fail "CRON_SECRET not found in .env.local on the host"
hb=$(printf 'Authorization: Bearer %s\n' "$secret" | curl -s -o /dev/null -w '%{http_code}' --max-time 15 -H @- http://localhost:3000/api/cron/heartbeat || true)
unset secret
[ "$hb" = 200 ] || fail "heartbeat route answered $hb"
log "service active; /login 200; heartbeat 200; waiting for the next scheduled ticks"

deadline=$(( $(date +%s) + 420 ))
for name in manage heartbeat; do
  while :; do
    line=$(tail -n 20 "$LOGDIR/$name.log" 2> /dev/null | grep 'http=' | tail -n 1)
    stamp=${line:1:20}
    if [[ "$stamp" > "$RESTART_AT" ]]; then
      grep -q 'http=200' <<< "$line" || fail "$name tick at $stamp logged: ${line:22:100}"
      log "$name tick at $stamp: 200"
      break
    fi
    [ "$(date +%s)" -lt "$deadline" ] || fail "no $name tick logged within 7 min of the restart (is cron running?)"
    sleep 10
  done
done

printf '%s OK ref=%s sha=%s prev=%s node=%s restart=%s\n' "$(date -u +%FT%TZ)" "$REF" "$SHA" "$PREV" "$(node -v)" "$RESTART_AT" >> "$LEDGER"
log "OK ${SHA:0:12} is live (was ${PREV:0:12}); rollback: make deploy REF=$PREV"
echo "DEPLOYED_SHA=$SHA"
echo "PREVIOUS_SHA=$PREV"
