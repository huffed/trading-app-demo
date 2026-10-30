#!/usr/bin/env bash
# PreToolUse hook for Edit | Write | MultiEdit | NotebookEdit.
# Blocks writes to secrets, pinned data, the golden file and the live-runner
# paths. Exit 2 = block (stderr is shown to Claude). Exit 0 = allow.
#
#   QT_ALLOW_LIVE_EDITS=1  lifts the live-runner block for this session only
#                          (a PR that touches the engine says so in its title);
#                          secrets, pinned data and the golden file stay blocked.
set -euo pipefail
input=$(cat)
path=$(printf '%s' "$input" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try { const j = JSON.parse(s); const t = j.tool_input || {};
      process.stdout.write(String(t.file_path || t.notebook_path || "")); } catch { process.stdout.write(""); }
  });')
[ -n "$path" ] || exit 0
root="${CLAUDE_PROJECT_DIR:-$PWD}"
rel="${path#"$root"/}"

deny() { printf 'guard-paths: refusing to write %s — %s\n' "$rel" "$1" >&2; exit 2; }

base=$(basename "$rel")
case "$base" in
  .env.example) ;;
  .env|.env.*) deny "secrets live in .env* and are never edited from a Claude session (CLAUDE.md, Secrets)";;
esac
case "$rel" in
  scripts/canonical/data/*) deny "pinned data is immutable; a new pin is a new file with its own sha-256 (docs/DEV_SETUP.md §14)";;
  tests/golden/*.golden.json) deny "the golden file is never edited by hand; run make backtest-update and explain the trade changes in the PR (docs/DEV_SETUP.md §14)";;
esac
if [ "${QT_ALLOW_LIVE_EDITS:-0}" != "1" ]; then
  case "$rel" in
    src/lib/scan/*|src/lib/brokers/*|src/app/api/cron/*|scripts/*-cron.sh|scripts/deploy-*.ts|scripts/canonical/deploy-*.ts|scripts/emergency-stop.sh)
      deny "live-runner path; engine, broker, cron and deploy code change only in a PR about them. Set QT_ALLOW_LIVE_EDITS=1 for this session if that is the PR you are on (docs/DEV_SETUP.md §16)";;
  esac
fi
exit 0
