#!/usr/bin/env bash
# Stop hook: OFF by default. With QT_STOP_VALIDATE=1 in the environment it runs
# `make validate` when Claude is about to stop and, if the harness fails, feeds
# the output back (exit 2) so the session does not end on a red validation.
# `make validate` is a stub until the audit's scripts reach dev (DEBT D-20), so
# turning this on today always blocks; it is wired now so the switch exists.
# The variable is never set in a committed file (make fence-check).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ "${QT_STOP_VALIDATE:-0}" = "1" ] || exit 0
command -v node >/dev/null || { echo "stop-validate: node not found; cannot run the validation gate" >&2; exit 2; }
input=$(cat)
# avoid looping: when this stop was itself caused by a hook, let it through
active=$(printf '%s' "$input" | node "$here/lib/hook-input.cjs" stop-active) || active=0
[ "$active" = "1" ] && exit 0
root="${CLAUDE_PROJECT_DIR:-$PWD}"
cd "$root" || exit 0
if out=$(make validate 2>&1); then
  exit 0
fi
printf 'make validate failed:\n%s\n' "$out" >&2
exit 2
