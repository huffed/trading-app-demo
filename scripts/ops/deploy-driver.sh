#!/usr/bin/env bash
# scripts/ops/deploy-driver.sh — runs on the workstation; `make deploy REF=…`.
# 1. refuses in market hours (Sunday 22:00 to Friday 22:00 UK), and within the hour before
#    the Sunday open, unless QT_MARKET_HOURS_OK=1 — the operator's explicit call, recorded
#    as market_ok=1 in the host's ledger line and as "market-hours override" in the row here;
# 2. refuses unless scripts/ops/ in this checkout equals origin/dev, and streams the host
#    script from origin/dev itself: only the reviewed scripts run on the host;
# 3. resolves REF to a commit on origin/dev here (names are looked up on origin first, so
#    REF=dev means origin/dev), so the host never resolves a name;
# 4. starts the host script detached, its output in /var/log/quanttrader/deploy-<stamp>.log,
#    and follows that log — a dropped ssh or a Ctrl-C does not stop the run
#    (the run's log so far: make logs LOG=deploy-<stamp> N=60);
# 5. appends a row to docs/decisions/deploys.md for every finished or interrupted run — OK,
#    FAIL (saying whether the failed commit went live), UNKNOWN or INTERRUPTED — then, on
#    OK only, moves the production pointer main: create, fast-forward, a leased force-update
#    for a rollback to an ancestor, or left alone with a message when the histories diverge.
#    An EXIT trap writes the OK row, so the pointer step cannot lose it.
set -euo pipefail
REF=${1:-}
HOST=${QT_HOST:-qt}
MARKET_OK=${QT_MARKET_HOURS_OK:-0}
cd "$(git rev-parse --show-toplevel)"
LEDGER=docs/decisions/deploys.md
die() {
  echo "deploy: $*" >&2
  exit 1
}
in_market_hours_or_about_to_open() { # a run takes up to ~45 min, so the hour before the Sunday 22:00 open counts too
  local u h
  u=$(TZ=Europe/London date +%u)
  h=$((10#$(TZ=Europe/London date +%H)))
  case "$u" in
    1 | 2 | 3 | 4) return 0 ;;
    5) [ "$h" -lt 22 ] ;;
    7) [ "$h" -ge 21 ] ;;
    *) return 1 ;;
  esac
}

[ -n "$REF" ] || die "REF is empty; make deploy REF=<commit|branch|tag> (the Makefile's default is origin/dev)"
[[ "$HOST" =~ ^[A-Za-z0-9._-]+$ ]] || die "QT_HOST must be an ssh host alias (letters, digits, . _ -)"
[[ "$REF" =~ ^[A-Za-z0-9_./-]+$ && "$REF" != -* && "$REF" != *..* ]] || die "REF must be a commit, tag or branch name"
[[ "$MARKET_OK" =~ ^[01]$ ]] || die "QT_MARKET_HOURS_OK must be 0 or 1"
if in_market_hours_or_about_to_open && [ "$MARKET_OK" != 1 ]; then
  die "market hours (Sunday 22:00 to Friday 22:00 UK, and the hour before the open): no deploy; the kill switch is the only market-hours change. QT_MARKET_HOURS_OK=1 overrides — the operator's call, recorded in both ledgers"
fi
override_note=""
[ "$MARKET_OK" = 1 ] && override_note="; market-hours override used (QT_MARKET_HOURS_OK=1)"
git fetch --quiet --prune origin || die "git fetch origin failed"
if ! git diff --quiet origin/dev -- scripts/ops/ || [ -n "$(git ls-files --others --exclude-standard scripts/ops/)" ]; then
  die "scripts/ops/ in this checkout differs from origin/dev; merge first — only the reviewed scripts run on the host (decision 0005)"
fi
if [[ "$REF" =~ ^[0-9a-f]{7,40}$ ]]; then
  sha=$(git rev-parse --verify --quiet "${REF}^{commit}") || die "unknown commit: $REF"
else
  sha=$(git rev-parse --verify --quiet "origin/${REF#origin/}^{commit}" || git rev-parse --verify --quiet "${REF}^{commit}") || die "unknown ref: $REF"
fi
git merge-base --is-ancestor "$sha" origin/dev || die "${sha:0:12} is not on origin/dev; production runs commits that reached dev"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
remote_script=/tmp/qt-deploy-$stamp.sh
runlog=/var/log/quanttrader/deploy-$stamp.log
row() { printf '| %s | %s | `%s` | %s%s |\n' "$(date -u +%FT%TZ)" "$1" "$sha" "$2" "$override_note" >> "$LEDGER"; }
echo "deploy: $REF = ${sha:0:12} → $HOST (run log on the host: $runlog)"
git show origin/dev:scripts/ops/deploy.sh | ssh -o BatchMode=yes -- "$HOST" "cat > $remote_script"
pid=$(ssh -o BatchMode=yes -- "$HOST" "sudo -n -H bash -c 'setsid nohup bash $remote_script $sha $REF $MARKET_OK > $runlog 2>&1 < /dev/null & echo \$!'")
[[ "$pid" =~ ^[0-9]+$ ]] || die "the host did not start the deploy (got: $pid)"
trap 'row "deploy INTERRUPTED on the workstation: $REF → \`${sha:0:7}\`" "the host run continues: make logs LOG=deploy-$stamp N=60; then make status"; echo "deploy: interrupted here; the host run continues (make logs LOG=deploy-$stamp N=60)" >&2; exit 130' INT TERM
ssh -o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -- "$HOST" "tail -n +1 -f --pid=$pid $runlog" \
  || echo "deploy: the follow connection ended; the host run continues (make logs LOG=deploy-$stamp N=60)"

result=""
for _ in $(seq 1 160); do # up to 40 minutes
  final=$(ssh -o BatchMode=yes -- "$HOST" "tail -n 8 $runlog" 2> /dev/null || true)
  result=$(sed -n 's/^DEPLOY_RESULT=//p' <<< "$final" | tail -n 1)
  [ -n "$result" ] && break
  sleep 15
done
trap - INT TERM
phase=$(sed -n 's/^DEPLOY_PHASE=//p' <<< "$final" | tail -n 1)
prev=$(sed -n 's/^PREVIOUS_SHA=//p' <<< "$final" | tail -n 1)
restore=$(sed -n 's/^DEPLOY_RESTORE=//p' <<< "$final" | tail -n 1)
runtime=$(sed -n 's/^DEPLOYED_RUNTIME=//p' <<< "$final" | tail -n 1)
if [ -z "$result" ]; then
  row "deploy RESULT UNKNOWN after 40 min: $REF → \`${sha:0:7}\`" "the host run may still finish: make logs LOG=deploy-$stamp N=60; make status; main not moved"
  die "no result from the host within 40 min; row appended to $LEDGER; main not moved"
fi
if [ "$result" != OK ]; then
  if [ "$phase" = restarted ]; then
    row "deploy FAILED after the restart: \`${prev:0:7}\` → \`${sha:0:7}\` is LIVE, unverified" "roll back now: make deploy REF=${prev:0:12}; run log: make logs LOG=deploy-$stamp N=60"
  else
    case "$restore" in
      ok) state="\`${prev:0:7}\` keeps running and was restored on disk" ;;
      failed) state="RESTORE FAILED: \`${prev:0:7}\` runs with no build on disk — run make deploy REF=${prev:0:12} now" ;;
      *) state="nothing was changed on the host; \`${prev:0:7}\` keeps running" ;;
    esac
    row "deploy FAILED before the restart (phase ${phase:-?}): $REF → \`${sha:0:7}\`" "$state; run log: make logs LOG=deploy-$stamp N=60"
    [ "$restore" = failed ] && echo "deploy: RESTORE FAILED on the host — run make deploy REF=${prev:0:12} now" >&2
  fi
  die "the host reported FAIL (phase ${phase:-?}); row appended to $LEDGER; main not moved"
fi
pointer="main not moved: the pointer step did not complete"
write_row() {
  row "deploy \`${prev:0:7}\` → \`${sha:0:7}\`" "ref $REF; verified: service active on Node ${runtime:-?}, /login 200, next manage + heartbeat (stale_count 0) + scan ticks 200; $pointer"
  echo "deploy: ${sha:0:12} is live and verified on $HOST (was ${prev:0:12}); $pointer; row appended to $LEDGER — commit it in the next PR"
}
trap write_row EXIT

if out=$(git ls-remote --exit-code origin refs/heads/main 2> /dev/null); then
  cur=${out%%[[:space:]]*}
  if git merge-base --is-ancestor "$cur" "$sha"; then
    git push --quiet origin "$sha:refs/heads/main" && pointer="main fast-forwarded ${cur:0:7} → ${sha:0:7}"
  elif git merge-base --is-ancestor "$sha" "$cur"; then
    git push --quiet --force-with-lease="refs/heads/main:$cur" origin "$sha:refs/heads/main" && pointer="main rolled back ${cur:0:7} → ${sha:0:7} (leased force-update)"
  else
    pointer="main left at ${cur:0:7}: ${sha:0:7} is neither its descendant nor its ancestor; deploy a commit on main's line or ask the operator"
  fi
elif [ $? -eq 2 ]; then
  git push --quiet origin "$sha:refs/heads/main" && pointer="main created at ${sha:0:7}"
else
  pointer="main not moved: git ls-remote failed"
fi
