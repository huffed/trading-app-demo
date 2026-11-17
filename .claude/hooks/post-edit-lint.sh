#!/usr/bin/env bash
# PostToolUse hook for Edit | Write | MultiEdit: after a code file is written,
# run Prettier (check) and ESLint on that file and feed problems back to Claude
# (exit 2, message on stderr). A file that is NEW in the working tree gets the
# target config (eslint.config.strict.mjs), as the pre-commit hook and CI apply
# to added files; an existing file gets the baseline config, errors only — never
# the warning budget, so inherited warnings in audit-cited files are not pushed
# into "fixes" that move lines.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null || { echo "post-edit-lint: node not found; could not lint the edited file" >&2; exit 2; }
input=$(cat)
path=$(printf '%s' "$input" | node "$here/lib/hook-input.cjs" field file_path) || { echo "post-edit-lint: could not read the tool input" >&2; exit 2; }
[ -n "$path" ] || exit 0
case "$path" in
  *.ts|*.tsx|*.mjs|*.js) ;;
  *) exit 0;;
esac
[ -f "$path" ] || exit 0                                  # deleted or moved: nothing to lint
root="${CLAUDE_PROJECT_DIR:-$PWD}"
cd "$root" || { echo "post-edit-lint: cannot cd to the project root" >&2; exit 2; }

out=""
if prettier_out=$(pnpm exec prettier --check "$path" 2>&1); then :; else
  if grep -q "Code style issues" <<<"$prettier_out"; then
    out+="prettier: $path is not formatted (run: make format)"$'\n'
  else
    out+="prettier could not run on $path:"$'\n'"$prettier_out"$'\n'
  fi
fi
if git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
  label="baseline config, errors only"
  eslint_cmd=(pnpm exec eslint --no-warn-ignored --quiet "$path")
else
  label="target config for a new file (eslint.config.strict.mjs)"
  eslint_cmd=(pnpm exec eslint --config eslint.config.strict.mjs --no-ignore --no-warn-ignored "$path")
fi
if eslint_out=$("${eslint_cmd[@]}" 2>&1); then :; else
  out+="eslint (${label}):"$'\n'"$eslint_out"$'\n'
fi
if [ -n "$out" ]; then
  printf '%s' "$out" >&2
  exit 2
fi
exit 0
