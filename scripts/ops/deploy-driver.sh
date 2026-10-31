#!/usr/bin/env bash
# scripts/ops/deploy-driver.sh — runs on the workstation; `make deploy [REF=…]`.
# 1. refuses unless scripts/ops/ in this checkout equals origin/dev: only the reviewed
#    scripts run on the host, never a branch or a working-tree edit;
# 2. resolves REF to a commit on origin/dev here (names are looked up on origin first,
#    so REF=dev means origin/dev), so the host never resolves a name;
# 3. copies deploy.sh to a per-run file on the host and starts it detached, its output in
#    /var/log/quanttrader/deploy-<stamp>.log, then follows that log — a dropped ssh does
#    not stop the run (re-attach: make logs LOG=deploy-<stamp> N=60);
# 4. appends a row to docs/decisions/deploys.md for every finished run, OK or FAIL (the
#    row is written before the pointer step and cannot be lost to it), then on OK moves
#    the production pointer main: create, fast-forward, a leased force-update for a
#    rollback to an ancestor, or left alone with a message when the histories diverge.
set -euo pipefail
REF=${1:-origin/dev}
HOST=${QT_HOST:-qt}
cd "$(git rev-parse --show-toplevel)"
LEDGER=docs/decisions/deploys.md
die() {
  echo "deploy: $*" >&2
  exit 1
}

[[ "$HOST" =~ ^[A-Za-z0-9._-]+$ ]] || die "QT_HOST must be an ssh host alias (letters, digits, . _ -)"
[[ "$REF" =~ ^[A-Za-z0-9_./-]+$ && "$REF" != -* && "$REF" != *..* ]] || die "REF must be a commit, tag or branch name"
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
echo "deploy: $REF = ${sha:0:12} → $HOST (run log on the host: $runlog)"
scp -q -o BatchMode=yes scripts/ops/deploy.sh "$HOST:$remote_script"
pid=$(ssh -o BatchMode=yes -- "$HOST" "sudo -n -H bash -c 'setsid nohup bash $remote_script $sha $REF > $runlog 2>&1 < /dev/null & echo \$!'")
[[ "$pid" =~ ^[0-9]+$ ]] || die "the host did not start the deploy (got: $pid)"
ssh -o BatchMode=yes -- "$HOST" "tail -n +1 -f --pid=$pid $runlog" \
  || echo "deploy: the follow connection ended; the host run continues (make logs LOG=deploy-$stamp N=60)"

result=""
for _ in $(seq 1 160); do # up to 40 minutes
  final=$(ssh -o BatchMode=yes -- "$HOST" "tail -n 5 $runlog" 2> /dev/null || true)
  result=$(sed -n 's/^DEPLOY_RESULT=//p' <<< "$final" | tail -n 1)
  [ -n "$result" ] && break
  sleep 15
done
now=$(date -u +%FT%TZ)
if [ "$result" != OK ]; then
  printf '| %s | deploy FAILED: %s → `%s` | `%s` | host ledger: `make logs LOG=deploys N=5`; run log: `make logs LOG=deploy-%s N=60` |\n' \
    "$now" "$REF" "${sha:0:7}" "$sha" "$stamp" >> "$LEDGER"
  die "the host reported '${result:-no result within 40 min}'; row appended to $LEDGER; main not moved"
fi
prev=$(sed -n 's/^PREVIOUS_SHA=//p' <<< "$final" | tail -n 1)
pointer="main not moved: the pointer step did not complete"
write_row() {
  printf '| %s | deploy `%s` → `%s` | `%s` | ref %s; verified: service active, /login 200, next manage + heartbeat (stale_count 0) + scan ticks 200; %s |\n' \
    "$now" "${prev:0:7}" "${sha:0:7}" "$sha" "$REF" "$pointer" >> "$LEDGER"
  echo "deploy: ${sha:0:12} is live on $HOST (was ${prev:0:12}); $pointer; row appended to $LEDGER — commit it in the next PR"
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
