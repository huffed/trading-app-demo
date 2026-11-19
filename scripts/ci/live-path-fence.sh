#!/usr/bin/env bash
# The live-path fence on GitHub (docs/decisions/0015). The Claude Code hooks refuse edits to the trading code inside
# a session; this is the merge-side half, run by .github/workflows/fence.yml on every pull request into dev.
#
#   live-path-fence.sh <base-checkout> <pr-files.json> <pr-before.json> <pr-after.json>
#
#   <base-checkout>       the base branch's tree: its .claude/hooks/live-paths.txt is the list (the one guard-paths.sh
#                         and guard-bash.sh read) and its review/VERDICT.md is the verdict
#   <pr-files.json>       what `gh api --paginate repos/<repo>/pulls/<n>/files` wrote: one JSON array per page
#   <pr-before.json>,     `[head sha, changed_files]` of the PR, read just before and just after the file list: both
#   <pr-after.json>       heads must be HEAD_SHA, so the list is the one of the commit this check reports on, and the
#                         count must match the list, so a list the API cut short (it stops at 3,000) fails, not passes
#   HEAD_SHA (env)        the event's head commit, the one GitHub reports this check on
#   PR_TITLE (env)        the PR's title; the workflow passes both through env, never through ${{ }} in run:
#
# Every changed path counts, deletions included, and a rename counts under its old name too, so a move out of a
# fenced path is fenced. A path is fenced when it matches a glob in live-paths.txt the way guard-paths.sh matches
# it: a shell `case` pattern, where `*` (so `**` too) also crosses `/`, after lower-casing ASCII, as the hook does
# on macOS. tests/ci/live-path-fence-agreement.test.ts runs both over the same paths.
#
# Exit 0: no fenced path, or fenced paths with review/VERDICT.md on the base and MARKER in the title.
# Exit 1: fenced paths without both. Exit 2: input it cannot read (fails closed).
set -uo pipefail
trap 'echo "::error title=live-path fence::internal error; failing closed"; exit 2' ERR

MARKER='[changes fenced live paths]'

die() {
  printf '::error title=live-path fence::%s; failing closed\n' "$1"
  exit 2
}
warn() { printf '::warning title=live-path fence::%s (decision 0015)\n' "$1"; }

[ $# -eq 4 ] || die "usage: live-path-fence.sh <base-checkout> <pr-files.json> <pr-before.json> <pr-after.json>"
base=$1
files_json=$2
list="$base/.claude/hooks/live-paths.txt"
[ -f "$list" ] || die "no .claude/hooks/live-paths.txt in the base checkout"
[ -f "$files_json" ] || die "no file list at $files_json"
command -v jq >/dev/null || die "jq not found"
case "${HEAD_SHA-}" in '' | *[!0-9a-f]*) die "HEAD_SHA '${HEAD_SHA-}' is not a commit sha" ;; esac

# Each PR read is exactly one [head sha, changed_files]; printed as "<sha> <count>".
read_pr() {
  jq -ser 'select(length == 1) | .[0] | select(type == "array" and length == 2 and (.[0] | type) == "string"
    and (.[1] | type) == "number") | "\(.[0]) \(.[1])"' "$1" 2>/dev/null
}
before=$(read_pr "$3") || die "the PR read before the file list is not [head sha, changed_files]"
after=$(read_pr "$4") || die "the PR read after the file list is not [head sha, changed_files]"
[ "$before" = "$after" ] || die "the PR changed while its files were listed ($before, then $after); its newer run decides"
[ "${before%% *}" = "$HEAD_SHA" ] || die "the PR's head is ${before%% *}, not $HEAD_SHA, the commit this check reports on; its newer run decides"
expected=${before##* }

# One array of objects per page; each object has a string filename and, on a rename, a string previous_filename.
shape=$(jq -s 'all(.[]; type == "array") and all(.[][]; type == "object" and (.filename | type) == "string"
  and ((.previous_filename // "") | type) == "string")' "$files_json" 2>/dev/null) || die "the file list is not JSON"
[ "$shape" = "true" ] || die "the file list is not the shape the pulls/files API returns"
count=$(jq -s '[.[][]] | length' "$files_json") || die "could not count the file list"
[ "$count" = "$expected" ] || die "the API listed $count changed files and the pull request has $expected (the API stops at 3,000)"
bad=$(jq -s '[.[][] | .filename, (.previous_filename // empty) | select(test("[[:cntrl:]]"))] | length' "$files_json") || die "could not read the paths"
[ "$bad" = "0" ] || die "$bad changed path(s) hold a control character, which this check does not match"
paths=$(jq -r '.[] | .filename, (.previous_filename // empty) | select(. != "")' "$files_json") || die "could not read the paths"

# The same loop as guard-paths.sh, except that a last line with no newline still counts (fails closed).
globs=()
while IFS= read -r pattern || [ -n "$pattern" ]; do
  case "$pattern" in '' | '#'*) continue ;; esac
  globs+=("$pattern")
done <"$list"
[ "${#globs[@]}" -gt 0 ] || die "live-paths.txt on the base lists no globs"

lows=$(printf '%s\n' "$paths" | LC_ALL=C tr '[:upper:]' '[:lower:]') || die "could not lower-case the paths"
total=0
fenced=()
while IFS= read -r path <&3 && IFS= read -r low <&4; do
  [ -n "$path" ] || continue
  total=$((total + 1))
  case "$low" in
    .github/workflows/fence.yml | scripts/ci/live-path-fence.sh | .claude/hooks/live-paths.txt)
      warn "$path changes the fence itself; this run used dev's copy, and the change applies to pull requests after it merges"
      ;;
    .github/workflows/*)
      warn "$path changes a workflow; one on pull_request runs this PR's own copy, and a job named live-path fence there could answer this check"
      ;;
    review/verdict.md)
      warn "$path adds or changes the audit verdict; once it is on dev, a fenced pull request whose title has the marker passes"
      ;;
  esac
  for pattern in "${globs[@]}"; do
    # shellcheck disable=SC2254  # unquoted on purpose: a glob, matched as guard-paths.sh matches it
    case "$low" in $pattern)
      fenced+=("$path")
      break
      ;;
    esac
  done
done 3<<<"$paths" 4<<<"$lows"

if [ "${#fenced[@]}" -eq 0 ]; then
  echo "live-path fence: none of the $total changed paths is fenced (.claude/hooks/live-paths.txt on the base branch)"
  exit 0
fi
printf 'fenced: %s\n' "${fenced[@]}"

verdict=0
if [ -f "$base/review/VERDICT.md" ] && [ ! -L "$base/review/VERDICT.md" ]; then verdict=1; fi
marker=0
case "${PR_TITLE-}" in *"$MARKER"*) marker=1 ;; esac

if [ "$verdict" = 1 ] && [ "$marker" = 1 ]; then
  echo "live-path fence: ${#fenced[@]} fenced path(s) allowed: review/VERDICT.md is on the base branch and the title says $MARKER"
  exit 0
fi
why=""
[ "$verdict" = 1 ] || why="review/VERDICT.md is not on the base branch"
[ "$marker" = 1 ] || why="${why:+$why; }the title does not say $MARKER"
printf '::error title=live-path fence::this pull request changes %s fenced live path(s) (.claude/hooks/live-paths.txt): %s. Decision 0015 has the emergency override.\n' "${#fenced[@]}" "$why"
exit 1
