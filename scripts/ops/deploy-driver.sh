#!/usr/bin/env bash
# scripts/ops/deploy-driver.sh — runs on the workstation; `make deploy [REF=…]`.
# Copies scripts/ops/deploy.sh to the VPS, runs it as root, and only after it
# reports a verified deploy moves the production pointer `main` to the deployed
# commit (fast-forward; a rollback to an ancestor is a leased force-update; a
# divergent commit leaves main alone and says so) and appends a row to
# docs/decisions/deploys.md for the next PR to commit. QT_HOST defaults to the
# `qt` ssh alias.
set -euo pipefail
REF=${1:-origin/dev}
HOST=${QT_HOST:-qt}
cd "$(git rev-parse --show-toplevel)"
out=$(mktemp)
trap 'rm -f "$out"' EXIT

echo "deploy: $REF → $HOST (rollback afterwards: make deploy REF=<PREVIOUS_SHA printed below>)"
scp -q -o BatchMode=yes scripts/ops/deploy.sh "$HOST:/tmp/qt-deploy.sh"
ssh -o BatchMode=yes "$HOST" "sudo -n -H bash /tmp/qt-deploy.sh '$REF'" | tee "$out"
sha=$(sed -n 's/^DEPLOYED_SHA=//p' "$out")
prev=$(sed -n 's/^PREVIOUS_SHA=//p' "$out")
[ -n "$sha" ] || { echo "deploy: the host did not report DEPLOYED_SHA; main not moved, no ledger row" >&2; exit 1; }

git fetch --quiet origin
git cat-file -e "${sha}^{commit}" 2> /dev/null || { echo "deploy: $sha is not in this clone (fetch it); main not moved" >&2; exit 1; }
if cur=$(git ls-remote --exit-code origin refs/heads/main 2> /dev/null | cut -f1); then
  if git merge-base --is-ancestor "$cur" "$sha"; then
    git push --quiet origin "$sha:refs/heads/main"
    pointer="main fast-forwarded ${cur:0:7} → ${sha:0:7}"
  elif git merge-base --is-ancestor "$sha" "$cur"; then
    git push --quiet --force-with-lease="refs/heads/main:$cur" origin "$sha:refs/heads/main"
    pointer="main rolled back ${cur:0:7} → ${sha:0:7}"
  else
    pointer="main left at ${cur:0:7}: ${sha:0:7} is neither its descendant nor its ancestor — move it by hand"
  fi
else
  git push --quiet origin "$sha:refs/heads/main"
  pointer="main created at ${sha:0:7}"
fi
printf '| %s | deploy `%s` → `%s` | `%s` | ref %s; verified /login 200, heartbeat 200, next manage + heartbeat ticks 200; %s |\n' \
  "$(date -u +%FT%TZ)" "${prev:0:7}" "${sha:0:7}" "$sha" "$REF" "$pointer" >> docs/decisions/deploys.md
echo "deploy: ${sha:0:12} is live on $HOST; $pointer; row appended to docs/decisions/deploys.md (commit it in the next PR)"
