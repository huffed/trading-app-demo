#!/usr/bin/env bash
# PreToolUse hook for Bash. Blocks shell commands that read or write secrets,
# write into pinned data, or force-push protected branches. Exit 2 = block.
# Pattern-based: it catches the obvious forms, not every encoding; the
# permission deny rules in .claude/settings.json are the hard stop for .env*.
set -euo pipefail
input=$(cat)
cmd=$(printf '%s' "$input" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try { const j = JSON.parse(s); process.stdout.write(String((j.tool_input || {}).command || "")); } catch { process.stdout.write(""); }
  });')
[ -n "$cmd" ] || exit 0

deny() { printf 'guard-bash: refusing this command — %s\n' "$1" >&2; exit 2; }

# .env files other than .env.example, when a command reads/writes them or a
# redirect targets them. Mentions in commit messages or echo text are not blocked
# (the Read/Edit deny rules in settings.json are the hard stop for cat/sed/tee).
stripped=$(printf '%s' "$cmd" | sed -E 's/\.env\.example//g')
envfile='\.env(\.[A-Za-z0-9_.-]+)?([^A-Za-z0-9_.-]|$)'
readers='(cat|less|more|head|tail|grep|rg|sed|awk|cut|sort|cp|mv|rm|tee|source|\.|vi|vim|nano|open|scp|rsync|base64|xxd|od|strings|dotenv|env|export|set|perl|python3?|node|ruby|php)'
# grep matches per line, so ^ anchors every line of a multi-line command
pathprefix='([^[:space:];&|]*/)?'
if printf '%s' "$stripped" | grep -qE "(^|[;&|])[[:space:]]*(sudo[[:space:]]+(-n[[:space:]]+)?)?${readers}[[:space:]]+([^;&|]*[[:space:]])?${pathprefix}${envfile}" \
   || printf '%s' "$stripped" | grep -qE "[<>][[:space:]]*${pathprefix}${envfile}"; then
  deny "it reads or writes a .env file; secrets are never read, printed, moved or edited from a Claude session (CLAUDE.md, Secrets). .env.example is fine"
fi
# writes into the pinned corpora
if printf '%s' "$cmd" | grep -qE 'scripts/canonical/data/' && printf '%s' "$cmd" | grep -qE '(^|[;&| ])(rm|mv|cp|tee|truncate|sed +-i|perl +-p?i)( |$)|>>?[ ]*[^ ]*scripts/canonical/data/'; then
  deny "pinned data is immutable; a new pin is a new file (docs/DEV_SETUP.md §14)"
fi
# force pushes to the protected branches
if printf '%s' "$cmd" | grep -qE 'git +push' && printf '%s' "$cmd" | grep -qE '(--force|-f( |$)|--force-with-lease|\+[A-Za-z0-9_./-]*:)' && printf '%s' "$cmd" | grep -qE '(^|[ :/])(dev|main)( |$)'; then
  deny "no force-push to dev or main (protect-dev ruleset; docs/DEV_SETUP.md §12)"
fi
exit 0
