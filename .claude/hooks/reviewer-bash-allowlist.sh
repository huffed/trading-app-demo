#!/usr/bin/env bash
# PreToolUse(Bash) hook registered only in .claude/agents/skeptical-reviewer.md.
# The reviewer's shell is an allow-list of read-only commands, matched EXACTLY
# per simple command after a quote-aware split that refuses command and process
# substitution, heredocs, any input redirection and any output redirect other
# than >&1, >&2 and /dev/null. Flags that make an allowed command write (eslint
# --fix, prettier --write, vitest -u/--outputFile, git --output/-O, make
# variables) are not on the list, so they are refused. Fails CLOSED.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
trap 'echo "reviewer-bash-allowlist: internal error while inspecting the command; refusing" >&2; exit 2' ERR
command -v node >/dev/null || { echo "reviewer-bash-allowlist: node not found; refusing" >&2; exit 2; }
input=$(cat)
segs=$(printf '%s' "$input" | node "$here/lib/hook-input.cjs" segments --strict) || { echo "reviewer-bash-allowlist: could not read the tool input; refusing" >&2; exit 2; }
case "$segs" in
  DENY:*) printf 'reviewer-bash-allowlist: refusing — %s is not allowed for the read-only reviewer\n' "${segs#DENY:}" >&2; exit 2;;
esac
[ -n "$segs" ] || { echo "reviewer-bash-allowlist: empty command; refusing" >&2; exit 2; }

p='[A-Za-z0-9_./()@:,=+-]+'          # a path or ref token: no spaces, no shell metacharacters
allowed=(
  "^git (diff|show|blame|status|rev-parse|ls-files|grep)( ${p})*$"
  "^git log( ${p})*$"
  "^gh pr (diff|view|checks)( ${p})*$"
  "^gh run (view|list)( ${p})*$"
  "^make (lint|lint-shell|lint-workflows|typecheck|test|backtest|check|env-check|db-types-check|fence-check|help)$"
  "^make regime-report( ARGS=\"[0-9]+ [0-9]+\")?$"
  "^make lint-strict FILES=\"?[A-Za-z0-9_./()\\[\\] -]+\"?$"
  "^pnpm test$"
  "^pnpm exec vitest run( ${p})*$"
  "^pnpm exec eslint( --no-ignore)?( --config eslint\\.config\\.(strict\\.)?mjs)?( ${p})+$"
  "^pnpm exec tsc --noEmit( -p tsconfig\\.json)?$"
  "^pnpm exec prettier --check( ${p})+$"
  "^(cat|head|tail|wc|cut|tr|diff|ls|echo|printf|jq|true)( .*)?$"
  "^grep( .*)?$"
  "^cd( ${p})?$"
)
# arguments that make an otherwise allowed command write or execute something
blacklist='(^|[[:space:]])(--output(=|$|[[:space:]])|-O|--ext-diff|--textconv|--exec|--open-files-in-pager|--fix|--fix-dry-run|--write|-w|-o|--output-file|-u|--update|--updateSnapshot|--outputFile|--reporter=json|--coverage|--pre|--config=|-c[[:space:]])'

while IFS= read -r seg; do
  [ -n "$seg" ] || continue
  s=$(printf '%s' "$seg" | sed -E 's/[[:space:]]*2>&1//g; s/[[:space:]]*>&[12]//g; s/[[:space:]]*2?>>?\/dev\/null//g')
  ok=0
  for re in "${allowed[@]}"; do
    if grep -qE "$re" <<<"$s"; then ok=1; break; fi
  done
  [ "$ok" = "1" ] || { printf 'reviewer-bash-allowlist: refusing "%s" — not on the read-only allowlist (git diff/log/show/blame/status, gh pr diff/view/checks, make lint/typecheck/test/backtest/regime-report, the test runner, cat/head/tail/wc/cut/tr/diff/ls/echo/printf/jq/grep)\n' "$seg" >&2; exit 2; }
  if grep -qE "$blacklist" <<<"$s"; then
    printf 'reviewer-bash-allowlist: refusing "%s" — a flag that writes, executes or changes configuration\n' "$seg" >&2; exit 2
  fi
  if grep -qE '^grep( .*)?[[:space:]]-[a-zA-Z]*[rR]' <<<"$s"; then
    printf 'reviewer-bash-allowlist: refusing "%s" — recursive grep can print secrets; use the Grep tool\n' "$seg" >&2; exit 2
  fi
done <<<"$segs"
exit 0
