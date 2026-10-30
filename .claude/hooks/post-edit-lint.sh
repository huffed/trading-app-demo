#!/usr/bin/env bash
# PostToolUse hook for Edit | Write | MultiEdit: after a code file is written,
# run Prettier (check) and the baseline ESLint on that file. Problems go to
# stderr with exit 2 so Claude sees them immediately instead of at commit time.
set -uo pipefail
input=$(cat)
path=$(printf '%s' "$input" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try { const j = JSON.parse(s); process.stdout.write(String((j.tool_input || {}).file_path || "")); } catch { process.stdout.write(""); }
  });')
[ -n "$path" ] || exit 0
case "$path" in
  *.ts|*.tsx|*.mjs|*.js) ;;
  *) exit 0;;
esac
[ -f "$path" ] || exit 0
root="${CLAUDE_PROJECT_DIR:-$PWD}"
cd "$root" || exit 0
out=""
if ! pnpm exec prettier --check "$path" >/dev/null 2>&1; then
  out+="prettier: $path is not formatted (run: make format)"$'\n'
fi
if ! e=$(pnpm exec eslint --no-warn-ignored --max-warnings 0 "$path" 2>&1); then
  out+="eslint:"$'\n'"$e"$'\n'
fi
if [ -n "$out" ]; then
  printf '%s' "$out" >&2
  exit 2
fi
exit 0
