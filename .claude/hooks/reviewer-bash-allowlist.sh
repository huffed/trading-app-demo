#!/usr/bin/env bash
# PreToolUse(Bash) hook registered in .claude/agents/skeptical-reviewer.md only.
# The reviewer may run read-only commands so it can verify claims (git diff/log/
# show/blame, make lint/test/typecheck/backtest, the test runner, viewers).
# Everything that writes is refused with exit 2: git commit/push/checkout/reset/
# stash/add, rm, mv, cp, redirects, in-place edits, package installs, make
# targets that write, command substitution and heredocs.
set -euo pipefail
input=$(cat)
# Quote-aware split into simple commands; prints DENY:<reason> first when a
# construct is refused outright, otherwise one command segment per line.
segments=$(printf '%s' "$input" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    let cmd = "";
    try { cmd = String((JSON.parse(s).tool_input || {}).command || ""); } catch { cmd = ""; }
    const out = []; let cur = ""; let q = null;
    const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ""; };
    for (let i = 0; i < cmd.length; i++) {
      const c = cmd[i], n = cmd[i + 1];
      if (q) { cur += c; if (c === q) q = null; continue; }
      if (c === "\x27" || c === "\"") { q = c; cur += c; continue; }
      if (c === "`" || (c === "$" && n === "(")) { out.unshift("DENY:command substitution is not allowed for the reviewer"); break; }
      if (c === "<" && n === "<") { out.unshift("DENY:heredocs are not allowed for the reviewer"); break; }
      if (c === ">") {
        // only ">&1", ">&2", "> /dev/null" and ">> /dev/null" pass; consume them whole
        const m = cmd.slice(i).match(/^>&[12](?![0-9])|^>>?\s*\/dev\/null/);
        if (m) { cur += m[0]; i += m[0].length - 1; continue; }
        out.unshift("DENY:redirects are not allowed for the reviewer"); break;
      }
      if ((c === "&" && n === "&") || (c === "|" && n === "|")) { push(); i++; continue; }
      if (c === "|" || c === ";" || c === "\n" || c === "&") { push(); continue; }
      cur += c;
    }
    push();
    process.stdout.write(out.join("\n"));
  });')
case "$segments" in
  DENY:*) printf 'reviewer-bash-allowlist: %s\n' "${segments#DENY:}" | head -1 >&2; exit 2;;
esac
[ -n "$segments" ] || exit 0

allowed='^(git (diff|log|show|blame|status|rev-parse|ls-files|grep)|gh (pr (diff|view|checks)|run (view|list))|make (lint|lint-strict|lint-shell|lint-workflows|typecheck|test|backtest|regime-report|check|env-check|db-types-check|fence-check|help)|pnpm (test|exec (vitest|eslint|tsc|prettier --check))|rg|grep|ls|cat|head|tail|wc|sort|uniq|cut|tr|find|diff|echo|printf|jq|sed|awk|true|cd|2>&1)([[:space:]]|$)'
while IFS= read -r seg; do
  [ -n "$seg" ] || continue
  seg_clean=$(printf '%s' "$seg" | sed -E 's/[[:space:]]*2>&1//g; s/[[:space:]]*2>\/dev\/null//g; s/[[:space:]]*>\/dev\/null//g')
  if ! printf '%s' "$seg_clean" | grep -qE "$allowed"; then
    printf 'reviewer-bash-allowlist: refusing "%s" — not on the read-only allowlist (git diff/log/show/blame, make lint/test/typecheck/backtest, the test runner, viewers)\n' "$seg" >&2
    exit 2
  fi
  if printf '%s' "$seg_clean" | grep -qE '^(sed|perl)[[:space:]]+(.*[[:space:]])?(-[a-zA-Z]*i|--in-place)([[:space:]]|$|=)'; then
    printf 'reviewer-bash-allowlist: refusing "%s" — in-place edit\n' "$seg" >&2; exit 2
  fi
  if printf '%s' "$seg_clean" | grep -qE '^find[[:space:]].*(-delete|-exec|-ok)'; then
    printf 'reviewer-bash-allowlist: refusing "%s" — find with -delete/-exec\n' "$seg" >&2; exit 2
  fi
  if printf '%s' "$seg_clean" | grep -qE '^(git|gh)[[:space:]].*[[:space:]]--(force|delete|hard)'; then
    printf 'reviewer-bash-allowlist: refusing "%s" — destructive flag\n' "$seg" >&2; exit 2
  fi
done <<< "$segments"
exit 0
