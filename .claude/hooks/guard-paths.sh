#!/usr/bin/env bash
# PreToolUse hook for Edit | Write | MultiEdit | NotebookEdit.
# Refuses (exit 2, reason on stderr) writes to secrets, pinned data, the golden
# inputs and the live-runner paths listed in live-paths.txt. Fails CLOSED: any
# error inspecting the call refuses it.
#
#   QT_ALLOW_LIVE_EDITS=1  lifts the live-runner part for this session only. The
#                          operator sets it, never a committed file or a shell
#                          profile (make fence-check), and not before the audit
#                          verdict (docs/decisions/0004). Every live-path edit
#                          while it is set leaves a FENCE DOWN notice.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
trap 'echo "guard-paths: internal error while inspecting the call; refusing" >&2; exit 2' ERR
command -v node >/dev/null || { echo "guard-paths: node not found; refusing" >&2; exit 2; }
root="${CLAUDE_PROJECT_DIR:-$PWD}"
input=$(cat)
rel=$(printf '%s' "$input" | node "$here/lib/hook-input.cjs" relpath "$root") || { echo "guard-paths: could not read the tool input; refusing" >&2; exit 2; }
[ -n "$rel" ] || { echo "guard-paths: no path in the tool input; refusing" >&2; exit 2; }
# OUTSIDE = the path resolves outside the project; nothing here protects other
# directories (the permission deny rules still apply there).
[ "$rel" = "OUTSIDE" ] && exit 0

deny() { printf 'guard-paths: refusing to write %s — %s\n' "$rel" "$1" >&2; exit 2; }

base="${rel##*/}"
case "$base" in
  .env.example) ;;
  .env|.env.*|.env-*|.envrc) deny "secrets live in .env* and are never edited from a Claude session (CLAUDE.md, Secrets)";;
esac
case "$rel" in
  scripts/canonical/data|scripts/canonical/data/*) deny "pinned data is immutable; a new pin is a new file with its own sha-256 (docs/DEV_SETUP.md §14)";;
  tests/golden/*.json) deny "golden inputs are generated or captured, never edited by hand; run make backtest-update and explain the trade changes in the PR (docs/DEV_SETUP.md §14)";;
esac

live=0
while IFS= read -r pattern; do
  case "$pattern" in ''|'#'*) continue;; esac
  # shellcheck disable=SC2254  # the pattern must stay unquoted to act as a glob
  case "$rel" in $pattern) live=1; break;; esac
done < "$here/live-paths.txt"

if [ "$live" = "1" ]; then
  if [ "${QT_ALLOW_LIVE_EDITS:-0}" != "1" ]; then
    deny "live-runner path (.claude/hooks/live-paths.txt). Engine, broker, API-route, cron and deploy code change only in a PR about them, in a session the operator started with the override — not before the audit verdict. Stop and ask the operator (docs/decisions/0004)"
  fi
  notice="guard-paths: FENCE DOWN (QT_ALLOW_LIVE_EDITS=1) — writing live-runner path ${rel}"
  printf '%s' "$notice" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      process.stdout.write(JSON.stringify({ systemMessage: s }));
    });'
  printf '%s\n' "$notice" >&2
fi
exit 0
