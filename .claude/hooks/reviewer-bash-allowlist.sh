#!/usr/bin/env bash
# PreToolUse(Bash) hook registered only in .claude/agents/skeptical-reviewer.md.
# The reviewer's shell is an allow-list of read-only commands, matched EXACTLY
# per simple command after a quote-aware split that refuses command and process
# substitution, heredocs, any input redirection and any output redirect other
# than >&1, >&2 and /dev/null. Flags that make an allowed command write, run a
# module or read recursively are refused. Fails CLOSED. guard-bash.sh also runs
# for the reviewer (session hooks apply to subagents), so secrets rules stack.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
trap 'echo "reviewer-bash-allowlist: internal error while inspecting the command; refusing" >&2; exit 2' ERR
command -v node >/dev/null || { echo "reviewer-bash-allowlist: node not found; refusing" >&2; exit 2; }
input=$(cat)
raw=$(printf '%s' "$input" | node "$here/lib/hook-input.cjs" segments --strict) || { echo "reviewer-bash-allowlist: could not read the tool input; refusing" >&2; exit 2; }
case "$raw" in
  DENY:*) printf 'reviewer-bash-allowlist: refusing — %s is not allowed for the read-only reviewer\n' "${raw#DENY:}" >&2; exit 2;;
esac
[ -n "$raw" ] || { echo "reviewer-bash-allowlist: empty command; refusing" >&2; exit 2; }

p='[][A-Za-z0-9_./()@:,=+~^-]+'                 # a path, ref or flag token: no spaces, no shell metacharacters
tok="(${p}|\"[^\"]*\"|'[^']*')"                   # the same, or a quoted string
allowed=(
  "^git (diff|show|blame|status|rev-parse|ls-files|grep)( ${tok})*$"
  "^git log( ${tok})*$"
  "^gh pr (diff|view|checks)( ${tok})*$"
  "^gh run (view|list)( ${tok})*$"
  "^make (lint|lint-shell|lint-workflows|typecheck|test|backtest|check|env-check|db-types-check|fence-check|help)$"
  "^make regime-report( ARGS=\"[0-9]+ [0-9]+\")?$"
  "^make lint-strict FILES=${tok}$"
  "^pnpm test$"
  "^pnpm exec vitest run( ${tok})*$"
  "^pnpm exec eslint( --no-ignore)?( --config eslint\\.config\\.(strict\\.)?mjs)?( ${tok})+$"
  "^pnpm exec tsc --noEmit( -p tsconfig\\.json)?$"
  "^pnpm exec prettier --check( ${tok})+$"
  "^(cat|head|tail|wc|cut|tr|diff|ls|echo|printf|jq|true)( .*)?$"
  "^grep( .*)?$"
  "^cd( ${tok})?$"
)
# flags that write, run a module, change configuration or read recursively
blacklist='(^|[[:space:]])(--output(=|$|[[:space:]])|-O|--ext-diff|--textconv|--exec|--open-files-in-pager|--fix|--fix-dry-run|--write|-o[[:space:]]|--output-file|-u([[:space:]]|$)|--update|--updateSnapshot|--outputFile|--reporter=json|--coverage|--pre|--config(=|$|[[:space:]])|-c[[:space:]]|--plugin|--format(=|[[:space:]])|-f[[:space:]]|--setupFiles|--globalSetup|--require|-r[[:space:]]|--rulesdir|--resolve-plugins-relative-to)'

while IFS=$'\t' read -r _sep seg; do
  [ -n "$seg" ] || continue
  s=$(printf '%s' "$seg" | sed -E 's/[[:space:]]*2>&1//g; s/[[:space:]]*>&[12]//g; s/[[:space:]]*2?>>?\/dev\/null//g')
  ok=0
  for re in "${allowed[@]}"; do
    if grep -qE "$re" <<<"$s"; then ok=1; break; fi
  done
  [ "$ok" = "1" ] || { printf 'reviewer-bash-allowlist: refusing "%s" — not on the read-only allowlist (git diff/log/show/blame/status, gh pr diff/view/checks, make lint/typecheck/test/backtest/regime-report, the test runner, cat/head/tail/wc/cut/tr/diff/ls/echo/printf/jq/grep)\n' "$seg" >&2; exit 2; }
  s_bl=$(sed -E 's/(^|[[:space:]])--config eslint\.config\.(strict\.)?mjs//' <<<"$s")   # the two repo configs are the permitted exception
  if grep -qE "$blacklist" <<<"$s_bl"; then
    printf 'reviewer-bash-allowlist: refusing "%s" — a flag that writes, runs a module or changes configuration\n' "$seg" >&2; exit 2
  fi
  if grep -qE '^pnpm exec prettier .*(^|[[:space:]])(-w|--write)([[:space:]]|$)' <<<"$s"; then
    printf 'reviewer-bash-allowlist: refusing "%s" — prettier --write\n' "$seg" >&2; exit 2
  fi
  if grep -qE '^grep( .*)?[[:space:]](-[a-zA-Z]*[rR]|--recursive|--dereference-recursive|-d[[:space:]]*recurse)' <<<"$s"; then
    printf 'reviewer-bash-allowlist: refusing "%s" — recursive grep can print secrets; use the Grep tool\n' "$seg" >&2; exit 2
  fi
done <<<"$raw"
exit 0
