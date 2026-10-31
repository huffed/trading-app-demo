#!/usr/bin/env bash
# PreToolUse hook for Bash. Splits the command into simple commands (quote-aware,
# the inside of $(…) and `…` included), strips wrappers from each head (sudo, env,
# xargs, nice, time, VAR=value prefixes, /bin/ paths, a leading backslash, shell
# keywords) and refuses, with exit 2 and the reason on stderr:
#   1  reads or writes of .env files other than .env.example (readers, interpreters,
#      --env-file, redirects, quoted or not, any case), and pipelines that feed one
#      to a reader (echo .env.local | xargs cat)
#   2  writes into the pinned corpora (scripts/canonical/data) and the golden inputs
#      (tests/golden/*.json), including rm/mv/git rm/git checkout/find -delete,
#      redirects, fixers, and destructive verbs on their parent directories
#   3  shell writes into the live-runner paths of live-paths.txt (same list as
#      guard-paths) unless QT_ALLOW_LIVE_EDITS=1, with a FENCE DOWN notice when set
#   4  mirror pushes; force, delete or +refspec pushes that touch dev or main,
#      including a bare `git push --force` while dev or main is checked out
#   5  git commit --no-verify (any unambiguous prefix), -n, or HUSKY=0
#   7  pre-approved commands turned into writes: make with an alternate makefile,
#      -C or --eval, or a variable override containing shell metacharacters;
#      git diff/log/show/blame/grep --output or -O; vitest -u/--outputFile;
#      prettier --check combined with --write
# Pattern-based and best-effort by nature (DEBT D-22); the permission deny rules
# are the hard stop for Claude's own file tools. Fails CLOSED on any inspection
# error. Every rule has a case in tests/hooks/hooks.test.ts.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
trap 'echo "guard-bash: internal error while inspecting the command; refusing" >&2; exit 2' ERR
command -v node >/dev/null || { echo "guard-bash: node not found; refusing" >&2; exit 2; }
input=$(cat)
raw=$(printf '%s' "$input" | node "$here/lib/hook-input.cjs" segments) || { echo "guard-bash: could not read the tool input; refusing" >&2; exit 2; }
[ -n "$raw" ] || exit 0
root="${CLAUDE_PROJECT_DIR:-$PWD}"

deny() { printf 'guard-bash: refusing "%s" — %s\n' "$1" "$2" >&2; exit 2; }

# live-path regex from live-paths.txt (glob → regex; `dir/**` also matches the bare directory)
live_re=""
while IFS= read -r pattern; do
  case "$pattern" in ''|'#'*) continue;; esac
  r=$(printf '%s' "$pattern" | sed -E 's/[.]/\\./g; s#/\*\*$#(/.*)?#; s/\*\*/@@/g; s#\*#[^[:space:]/]*#g; s/@@/.*/g')
  live_re="${live_re:+$live_re|}$r"
done < "$here/live-paths.txt"
bnd='([[:space:]"'"'"'/]|$)'
protected="(scripts/canonical/data|tests/golden/[^[:space:]\"']*\\.json)${bnd}"
live="(${live_re})${bnd}"
# directories above protected paths: a destructive verb on one of these takes the protected files with it
ancestors="(src|src/lib|src/app|scripts|scripts/canonical|tests|tests/golden|supabase)${bnd}"

envfile='\.env(rc|[._-][A-Za-z0-9_.-]*)?'
tail_='([^A-Za-z0-9_]|$)'
q="[\"']?"
pathprefix='([^[:space:];&|"'"'"']*/)?'
readers='(cat|less|more|head|tail|nl|tac|paste|uniq|column|fold|fmt|hexdump|grep|rg|ag|sed|awk|cut|sort|diff|cmp|cp|mv|rm|tee|source|\.|vi|vim|nano|open|scp|rsync|base64|xxd|od|strings|dotenv|export|set|perl|python3?|node|ruby|php|bash|sh|zsh|jq|xargs)'
interpreters='(node|python3?|perl|ruby|php|bash|sh|zsh|eval)'
anywriters='(mv|rm|tee|truncate|touch|chmod|chown|mkdir|rmdir|shred|unlink|ln)'
destwriters='(cp|install|rsync|scp)'
destructive='(rm|mv|truncate|shred|unlink|rmdir)'
writeish='(writeFile|appendFile|createWriteStream|unlink|rename|rmSync|rmdir|mkdir|copyFile|truncate|chmod|chown|os\.remove|shutil|FileUtils|fopen\(|open\([^)]*["'"'"'][wax])'

# strip shell keywords, grouping characters, wrappers, VAR=value prefixes, directory prefixes and a leading backslash
strip_kw() {
  local s=$1 prev=""
  while [ "$s" != "$prev" ]; do
    prev=$s
    s=$(sed -E 's/^(((do|then|else|elif|if|while|until|time|exec|command|builtin|nohup|nice|env|sudo)[[:space:]]+)|((sudo|env|nice)[[:space:]]+-[A-Za-z0-9]+[[:space:]]+)|([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)|(xargs([[:space:]]+-[A-Za-z0-9{}]+([[:space:]]+[^[:space:]-][^[:space:]]*)?)*[[:space:]]+)|[{(!][[:space:]]*)+//; s#^(/[^[:space:]]*/)?\\?##' <<<"$s")
  done
  printf '%s' "$s"
}
strip_keywords_only() { sed -E 's/^(((do|then|else|elif|if|while|until|time)[[:space:]]+)|[{(!][[:space:]]*)+//' <<<"$1"; }
unquoted() { sed -E "s/\"[^\"]*\"//g; s/'[^']*'//g" <<<"$1"; }

# does the lower-cased segment write to a path matching $1? ($2 = lower-cased segment, $3 = its unquoted form)
writes_to() {
  local target=$1 seg_l=$2 uq_l=$3 last
  last=${seg_l##* }
  grep -qiE "^${anywriters}([[:space:]]|$)" <<<"$seg_l" && grep -qiE "(^|[[:space:]/\"'])${target}" <<<"$seg_l" && return 0
  grep -qiE "^(sed|perl)[[:space:]]" <<<"$seg_l" && grep -qiE "(^|[[:space:]])(-[a-zA-Z]*i|--in-place)" <<<"$uq_l" && grep -qiE "(^|[[:space:]/\"'])${target}" <<<"$seg_l" && return 0
  grep -qiE "^${interpreters}([[:space:]]|$)" <<<"$seg_l" && grep -qiE "$writeish" <<<"$seg_l" && grep -qiE "(^|[[:space:]/\"'])${target}" <<<"$seg_l" && return 0
  grep -qiE "^${destwriters}([[:space:]]|$)" <<<"$seg_l" && grep -qiE "(^|[/\"'])${target}" <<<"$last" && return 0
  grep -qiE "^git[[:space:]]+(checkout|restore|rm|mv|clean|apply|am|cherry-pick|revert|stash)([[:space:]]|$)" <<<"$seg_l" && grep -qiE "(^|[[:space:]/\"'])${target}" <<<"$seg_l" && return 0
  grep -qiE "^find[[:space:]].*(-delete|-exec|-ok)" <<<"$seg_l" && grep -qiE "(^|[[:space:]/\"'])${target}" <<<"$seg_l" && return 0
  grep -qiE ">[|]?[[:space:]]*[\"']?${pathprefix}${target}" <<<"$seg_l" && return 0
  grep -qiE "^pnpm[[:space:]]+(exec[[:space:]]+)?(prettier[[:space:]].*(-w|--write)|eslint[[:space:]].*--fix|lint[[:space:]].*--fix)" <<<"$seg_l" && grep -qiE "(^|[[:space:]/\"'])${target}" <<<"$seg_l" && return 0
  return 1
}
destroys() { # destructive verbs only, for parent directories
  local target=$1 seg_l=$2
  grep -qiE "^(${destructive}|git[[:space:]]+(rm|checkout|restore|clean)|find)([[:space:]]|$)" <<<"$seg_l" || return 1
  grep -qiE "(^|[[:space:]/\"'])${target}" <<<"$seg_l"
}

notice_emitted=0
pipeline_env=0
in_compound=0
any_protected=0
destructive_elsewhere=""
fence_down="${QT_ALLOW_LIVE_EDITS:-0}"

while IFS=$'\t' read -r sep seg; do
  [ -n "$seg" ] || continue
  orig=$seg
  s0=$(printf '%s' "$seg" | sed -E 's/\.env\.example//g')     # the example file is public
  xargs_fed=0
  case "$(strip_keywords_only "$s0")" in xargs*) xargs_fed=1;; esac
  s=$(strip_kw "$s0")
  lower=$(printf '%s' "$s" | tr '[:upper:]' '[:lower:]')
  uq=$(unquoted "$s")
  uq_lower=$(printf '%s' "$uq" | tr '[:upper:]' '[:lower:]')
  # a pipeline into a compound command (… | while read f; do cat "$f"; done) keeps its input across the `;`
  case "$seg" in while*|until*|if*|for*|case*) in_compound=1;; esac
  if [ "$sep" != "pipe" ] && [ "${in_compound:-0}" = "0" ]; then pipeline_env=0; fi
  case "$seg" in done*|fi|fi\ *|esac*) in_compound=0;; esac

  # 1. a reader (after wrapper stripping) given an env file; a redirect to or from one; --env-file
  if grep -qiE "^${readers}([[:space:]]+[^[:space:]]+)*[[:space:]]+${q}(--env-file=)?${pathprefix}${envfile}${tail_}" <<<"$s" \
     || grep -qiE "[<>][|]?[[:space:]]*${q}${pathprefix}${envfile}${tail_}" <<<"$s" \
     || grep -qiE "(^|[[:space:]])--env-file(=|[[:space:]]+)${q}${pathprefix}${envfile}" <<<"$s"; then
    deny "$orig" "it reads or writes a .env file; secrets are never read, printed, moved or edited from a Claude session (CLAUDE.md, Secrets). .env.example is fine"
  fi
  mentions_env=0
  grep -qiE "(^|[^A-Za-z0-9_])${envfile}${tail_}" <<<"$s" && mentions_env=1
  # 1b. an interpreter whose program text names an env file (the path hides inside the quoted program)
  if [ "$mentions_env" = "1" ] && grep -qiE "^${interpreters}([[:space:]]|$)" <<<"$s"; then
    deny "$orig" "an interpreter is given a .env file name; secrets are never read, printed, moved or edited from a Claude session (CLAUDE.md, Secrets)"
  fi
  # 1c. a pipe-fed reader (or one inside the compound the pipe feeds) after a command that named an env file
  if { [ "$sep" = "pipe" ] || [ "${in_compound:-0}" = "1" ]; } && [ "$pipeline_env" = "1" ] && grep -qiE "^${readers}([[:space:]]|$)" <<<"$s"; then
    deny "$orig" "a command in this pipeline names a .env file and this one reads its input; secrets are never read from a Claude session (CLAUDE.md, Secrets)"
  fi
  [ "$mentions_env" = "1" ] && pipeline_env=1

  # 2. pinned corpora and golden inputs (plus their parent directories under a destructive verb)
  if writes_to "$protected" "$lower" "$uq_lower" || destroys "$ancestors" "$lower"; then
    deny "$orig" "pinned data and golden inputs are never written by hand (nor their parent directories removed); a new pin is a new file, the golden file is regenerated with make backtest-update (docs/DEV_SETUP.md §14)"
  fi

  # 3. live-runner paths
  if [ -n "$live_re" ] && writes_to "$live" "$lower" "$uq_lower"; then
    if [ "$fence_down" != "1" ]; then
      deny "$orig" "it writes a fenced live path (.claude/hooks/live-paths.txt); trading code — engine, runner, strategies, risk, sizing, execution, the engine's migrations, the paper engine's price config — changes only in a PR about it, in a session the operator started with the override. Stop and ask the operator (docs/decisions/0004, 0006)"
    fi
    if [ "$notice_emitted" = "0" ]; then
      notice="guard-bash: FENCE DOWN (live-path override is set) — shell write to a live-runner path: ${orig}"
      printf '%s' "$notice" | node -e '
        let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
          process.stdout.write(JSON.stringify({ systemMessage: s }));
        });'
      printf '%s\n' "$notice" >&2
      notice_emitted=1
    fi
  fi
  # a destructive verb whose path comes from elsewhere (xargs, a variable): judged across the whole command below
  if { grep -qiE "^(${destructive}|git[[:space:]]+(rm|checkout|restore|clean)|find[[:space:]])" <<<"$lower" \
       || { grep -qiE "^(sed|perl)[[:space:]]" <<<"$lower" && grep -qiE "(^|[[:space:]])(-[a-zA-Z]*i|--in-place)" <<<"$uq_lower"; }; } \
     && { [ "$xargs_fed" = "1" ] || grep -q '\$' <<<"$s"; }; then destructive_elsewhere=$orig; fi
  if grep -qiE "(^|[[:space:]/\"'])(${protected%"${bnd}"}|${live_re}|${ancestors%"${bnd}"})${bnd}" <<<"$lower"; then any_protected=1; fi

  # 4. protected branches
  if grep -qE "^git[[:space:]]+push([[:space:]]|$)" <<<"$s"; then
    if grep -qE "(^|[[:space:]])--mirror([[:space:]]|$)" <<<"$uq"; then
      deny "$orig" "git push --mirror rewrites every remote ref, dev and main included (protect-dev ruleset; docs/DEV_SETUP.md §12)"
    fi
    if grep -qE "(^|[[:space:]])(--force([[:space:]]|$|=)|--force-with-lease|--force-if-includes|-[a-zA-Z]*f[a-zA-Z]*([[:space:]]|$)|--delete|-[a-zA-Z]*d([[:space:]]|$)|\+[A-Za-z0-9_./-]*|:[A-Za-z0-9_./-]*)" <<<"$uq"; then
      if grep -qE "(^|[[:space:]:+/])(dev|main)([[:space:]:]|$)" <<<"$uq"; then
        deny "$orig" "no force, delete or +refspec push touching dev or main in any spelling (protect-dev ruleset; docs/DEV_SETUP.md §12)"
      fi
      refs=$(sed -E 's/(^|[[:space:]])-[^[:space:]]+//g' <<<"${uq#*push}")
      if [ "$(wc -w <<<"$refs" | tr -d ' ')" -le 1 ]; then          # no refspec: the checked-out branch is pushed
        cur=$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
        case "$cur" in dev|main) deny "$orig" "a force push of the checked-out branch, which is $cur (protect-dev ruleset)";; esac
      fi
    fi
  fi

  # 5. hooks must run
  if grep -qE "(^|[[:space:]])HUSKY(_SKIP_HOOKS)?=" <<<"$orig" && grep -qE "git[[:space:]]+commit" <<<"$orig"; then
    deny "$orig" "HUSKY=0 skips gitleaks and the commit-msg hook; commit normally (docs/DEV_SETUP.md §9)"
  fi
  if grep -qE "^git[[:space:]]+commit([[:space:]]|$)" <<<"$s" \
     && grep -qE "(^|[[:space:]])(--no-v[a-z]*|-[a-zA-Z]*n[a-zA-Z]*)([[:space:]]|$)" <<<"$uq"; then
    deny "$orig" "git commit --no-verify / -n skips gitleaks and the commit-msg hook; commit normally (docs/DEV_SETUP.md §9)"
  fi

  # 7. pre-approved commands that can be turned into writes
  if grep -qiE "^make([[:space:]]|$)" <<<"$s"; then
    if grep -qE "(^|[[:space:]])(-f|--file|--makefile|-C|--directory|-e|--eval|-I|--include-dir)([[:space:]]|=|$)" <<<"$uq"; then
      deny "$orig" "make with an alternate makefile, directory, include dir or --eval runs code the Makefile does not define"
    fi
    # each NAME=value token's VALUE (quoted or bare) must be free of shell metacharacters; redirects after it are fine
    while IFS= read -r assignment; do
      [ -n "$assignment" ] || continue
      value=${assignment#*=}
      value=${value#[\"\']}; value=${value%[\"\']}
      # metacharacters, quotes, backslashes and dollars can escape the recipe's quoting (bash decodes $'…' after
      # this hook has looked); a leading dash turns a host or file argument into an option (ssh -oProxyCommand=…)
      if grep -qE '[;&|<>`$\\"'"'"']' <<<"$value" || grep -qE '^-' <<<"$value"; then
        deny "$orig" "a make variable override containing a shell metacharacter, a quote, a backslash, a dollar sign or a leading dash would run inside the recipe or change what ssh/make does"
      fi
    done < <(grep -oE "[A-Za-z_][A-Za-z0-9_]*=(\"[^\"]*\"|'[^']*'|[^[:space:]]*)" <<<"$s" || true)
  fi
  if grep -qE "^git[[:space:]]+(diff|log|show|blame|grep)([[:space:]]|$)" <<<"$s" && grep -qE "(^|[[:space:]])(--output(=|[[:space:]])|-O|--ext-diff)" <<<"$uq"; then
    deny "$orig" "git --output / -O / --ext-diff write a file or run a command from a read-only git command"
  fi
  if grep -qE "^pnpm[[:space:]]+(exec[[:space:]]+)?vitest([[:space:]]|$)" <<<"$s" && grep -qE "(^|[[:space:]])(-u|--update|--updateSnapshot|--outputFile(=|[[:space:]]))" <<<"$uq"; then
    deny "$orig" "vitest -u / --outputFile writes files; snapshots and reports are not updated from a session"
  fi
  if grep -qE "^pnpm[[:space:]]+(exec[[:space:]]+)?prettier([[:space:]]|$)" <<<"$s" && grep -qE "(^|[[:space:]])--check([[:space:]]|$)" <<<"$uq" && grep -qE "(^|[[:space:]])(-w|--write)([[:space:]]|$)" <<<"$uq"; then
    deny "$orig" "prettier --check combined with --write is a write; use make format (an ask rule) on purpose"
  fi
done <<<"$raw"

if [ -n "$destructive_elsewhere" ] && [ "$any_protected" = "1" ]; then
  deny "$destructive_elsewhere" "a destructive command takes its paths from another command or a variable while this command line names pinned data, golden inputs or live-runner paths"
fi
exit 0
