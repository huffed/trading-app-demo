#!/usr/bin/env bash
# PreToolUse hook for Bash. Per simple command (quote-aware split), refuses:
#   - reads or writes of .env files other than .env.example, including through
#     interpreters, xargs, diff and redirects;
#   - writes into the pinned corpora (scripts/canonical/data) and the golden inputs;
#   - writes into live-runner paths (live-paths.txt) unless QT_ALLOW_LIVE_EDITS=1,
#     with a FENCE DOWN notice when it is set;
#   - force pushes, mirror pushes and branch deletions touching dev or main;
#   - git commit --no-verify / -n (the commit-msg and pre-commit hooks must run).
# Pattern-based and best-effort by nature (DEBT D-22): the permission deny rules
# are the hard stop for Claude's own file tools; the sandbox is the hard stop
# for subprocesses. Fails CLOSED on any inspection error.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
trap 'echo "guard-bash: internal error while inspecting the command; refusing" >&2; exit 2' ERR
command -v node >/dev/null || { echo "guard-bash: node not found; refusing" >&2; exit 2; }
input=$(cat)
segs=$(printf '%s' "$input" | node "$here/lib/hook-input.cjs" segments) || { echo "guard-bash: could not read the tool input; refusing" >&2; exit 2; }
[ -n "$segs" ] || exit 0

deny() { printf 'guard-bash: refusing "%s" — %s\n' "$1" "$2" >&2; exit 2; }

# live-path prefixes for command text, built from live-paths.txt (glob → regex):
# `dir/**` also matches the bare directory (a `cp x dir` or `git checkout -- dir` argument)
live_re=""
while IFS= read -r pattern; do
  case "$pattern" in ''|'#'*) continue;; esac
  r=$(printf '%s' "$pattern" | sed -E 's/[.]/\\./g; s#/\*\*$#(/.*)?#; s/\*\*/@@/g; s#\*#[^[:space:]/]*#g; s/@@/.*/g')
  live_re="${live_re:+$live_re|}$r"
done < "$here/live-paths.txt"

envfile='\.env([._-][A-Za-z0-9_.-]*)?'                  # .env .env.local .env-local .envrc …
pathprefix='([^[:space:];&|"'"'"']*/)?'
readers='(cat|less|more|head|tail|grep|rg|ag|sed|awk|cut|sort|diff|cmp|cp|mv|rm|tee|source|\.|vi|vim|nano|open|scp|rsync|base64|xxd|od|strings|dotenv|env|export|set|perl|python3?|node|ruby|php|bash|sh|zsh|xargs|wc|file|stat)'
# verbs that write wherever the path appears vs verbs whose DESTINATION is the last token
anywriters='(sed|perl|tee|rm|truncate|touch|chmod|chown|mkdir|rmdir|node|python3?|ruby|php|bash|sh|zsh)'
destwriters='(cp|mv|install|ln|rsync|scp)'
notice_emitted=0
any_env=0
other_reader=0
# does the segment write to a path matching $1 (a regex)? verb at the head, path anywhere / last / after a redirect
writes_to() {
  local target=$1 seg_l=$2 last
  last=${seg_l##* }
  grep -qiE "^(sudo[[:space:]]+)?${anywriters}([[:space:]]|$)" <<<"$seg_l" && grep -qiE "(^|[[:space:]/\"'])${target}" <<<"$seg_l" && return 0
  grep -qiE "^(sudo[[:space:]]+)?${destwriters}([[:space:]]|$)" <<<"$seg_l" && grep -qiE "(^|[/\"'])${target}" <<<"$last" && return 0
  grep -qiE "^(sudo[[:space:]]+)?git[[:space:]]+(checkout|restore|rm|mv|clean|apply|am|cherry-pick|revert|stash)([[:space:]]|$)" <<<"$seg_l" && grep -qiE "(^|[[:space:]/\"'])${target}" <<<"$seg_l" && return 0
  grep -qiE "^(sudo[[:space:]]+)?find[[:space:]].*(-delete|-exec|-ok)" <<<"$seg_l" && grep -qiE "(^|[[:space:]/\"'])${target}" <<<"$seg_l" && return 0
  grep -qiE ">[[:space:]]*${pathprefix}${target}" <<<"$seg_l" && return 0
  grep -qiE "^(sudo[[:space:]]+)?pnpm exec (prettier --write|eslint .*--fix)" <<<"$seg_l" && grep -qiE "(^|[[:space:]/\"'])${target}" <<<"$seg_l" && return 0
  return 1
}

while IFS= read -r seg; do
  [ -n "$seg" ] || continue
  s=$(printf '%s' "$seg" | sed -E 's/\.env\.example//g')     # the example file is public
  lower=$(printf '%s' "$s" | tr '[:upper:]' '[:lower:]')

  # 1. secrets: a reader/interpreter/redirect touching a .env file (case-insensitive: APFS)
  if grep -qiE "(^|[[:space:]])(sudo[[:space:]]+(-n[[:space:]]+)?)?${readers}([[:space:]]+[^[:space:]]+)*[[:space:]]+(--env-file=)?${pathprefix}${envfile}([[:space:]]|$|[\"'])" <<<"$s" \
     || grep -qiE "[<>][[:space:]]*${pathprefix}${envfile}([[:space:]]|$)" <<<"$s" \
     || grep -qiE "(^|[[:space:]])(--env-file(=|[[:space:]]+))${pathprefix}${envfile}" <<<"$s"; then
    deny "$seg" "it reads or writes a .env file; secrets are never read, printed, moved or edited from a Claude session (CLAUDE.md, Secrets). .env.example is fine"
  fi

  # 2. pinned corpora and golden inputs: any write verb, git checkout/restore/rm, find -delete, or a redirect
  protected='(scripts/canonical/data|tests/golden/[^[:space:]]*\.json)([/[:space:]"'"'"']|$)'
  if writes_to "$protected" "$lower"; then
    deny "$seg" "pinned data and golden inputs are never written by hand; a new pin is a new file, the golden file is regenerated with make backtest-update (docs/DEV_SETUP.md §14)"
  fi

  # 3. live-runner paths: a write verb, in-place edit, git checkout/restore, fixer or redirect targeting one
  if [ -n "$live_re" ] && writes_to "(${live_re})([[:space:]\"'/]|$)" "$lower"; then
    {
      if [ "${QT_ALLOW_LIVE_EDITS:-0}" != "1" ]; then
        deny "$seg" "it writes a live-runner path (.claude/hooks/live-paths.txt); engine, broker, API-route, cron and deploy code change only in a PR about them, in a session the operator started with the override. Stop and ask the operator (docs/decisions/0004)"
      fi
      if [ "$notice_emitted" = "0" ]; then
        notice="guard-bash: FENCE DOWN (QT_ALLOW_LIVE_EDITS=1) — shell write to a live-runner path: ${seg}"
        printf '%s' "$notice" | node -e '
          let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
            process.stdout.write(JSON.stringify({ systemMessage: s }));
          });'
        printf '%s\n' "$notice" >&2
        notice_emitted=1
      fi
    }
  fi

  # 4. protected branches: a mirror push rewrites every ref; force, delete or +refspec pushes that name dev or main
  if grep -qE "^(sudo[[:space:]]+)?git[[:space:]]+push([[:space:]]|$)" <<<"$s"; then
    if grep -qE "(^|[[:space:]])--mirror([[:space:]]|$)" <<<"$s"; then
      deny "$seg" "git push --mirror rewrites every remote ref, dev and main included (protect-dev ruleset; docs/DEV_SETUP.md §12)"
    fi
    if grep -qE "(^|[[:space:]])(--force([[:space:]]|$|=)|--force-with-lease|--force-if-includes|-[a-zA-Z]*f[a-zA-Z]*([[:space:]]|$)|--delete|-[a-zA-Z]*d([[:space:]]|$)|\+[A-Za-z0-9_./-]*|:[A-Za-z0-9_./-]*)" <<<"$s" \
       && grep -qE "(^|[[:space:]:+/])(dev|main)([[:space:]:]|$)" <<<"$s"; then
      deny "$seg" "no force, delete or +refspec push touching dev or main in any spelling (protect-dev ruleset; docs/DEV_SETUP.md §12)"
    fi
  fi

  # 5. hooks must run: no --no-verify / -n on git commit
  if grep -qE "^(sudo[[:space:]]+)?git[[:space:]]+commit([[:space:]]|$)" <<<"$s" \
     && grep -qE "(^|[[:space:]])(--no-verify|-[a-zA-Z]*n[a-zA-Z]*)([[:space:]]|$)" <<<"$s"; then
    deny "$seg" "git commit --no-verify / -n skips gitleaks and the commit-msg hook; commit normally (docs/DEV_SETUP.md §9)"
  fi

  # 1b. an interpreter whose argument text names an env file anywhere (node -e '…readFileSync(".env.local")…',
  #     python3 -c "open('.env.local')", bash -c '…'): the path is inside the quoted program, so rule 1 cannot see it
  mentions_env=0
  if grep -qiE "(^|[^A-Za-z0-9_])${envfile}([^A-Za-z0-9_]|$)" <<<"$s"; then mentions_env=1; fi
  if [ "$mentions_env" = "1" ] && grep -qiE "^(sudo[[:space:]]+)?(node|python3?|perl|ruby|php|bash|sh|zsh|eval|xargs)([[:space:]]|$)" <<<"$s"; then
    deny "$seg" "an interpreter is given a .env file name; secrets are never read, printed, moved or edited from a Claude session (CLAUDE.md, Secrets)"
  fi
  # pipeline view (rule 6 below): the env-file name in one command, a reader at the head of ANOTHER
  if [ "$mentions_env" = "1" ]; then any_env=1; elif grep -qiE "^(sudo[[:space:]]+)?${readers}([[:space:]]|$)" <<<"$s"; then other_reader=1; fi
done <<<"$segs"

# 6. a pipeline that names an env file in one command and feeds a reader in a different one
#    (echo .env.local | xargs cat; printf … | while read f; do cat $f; done)
if [ "${any_env:-0}" = "1" ] && [ "${other_reader:-0}" = "1" ]; then
  deny "$(head -1 <<<"$segs")" "a command in this pipeline names a .env file and another reads its input; secrets are never read from a Claude session (CLAUDE.md, Secrets)"
fi
exit 0
