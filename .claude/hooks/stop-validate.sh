#!/usr/bin/env bash
# Stop hook: OFF by default. With QT_STOP_VALIDATE=1 in the environment it runs
# `make validate` when Claude is about to stop and, if the harness fails, feeds
# the output back (exit 2) so the session does not end on a red validation.
# `make validate` is a stub until the audit's scripts reach dev (DEBT D-20), so
# turning this on today always blocks; it is wired now so the switch exists.
set -uo pipefail
[ "${QT_STOP_VALIDATE:-0}" = "1" ] || exit 0
input=$(cat)
# avoid looping: if this stop was already triggered by a hook, let it through
if printf '%s' "$input" | grep -q '"stop_hook_active":true'; then exit 0; fi
root="${CLAUDE_PROJECT_DIR:-$PWD}"
cd "$root" || exit 0
if out=$(make validate 2>&1); then
  exit 0
fi
printf 'make validate failed:\n%s\n' "$out" >&2
exit 2
