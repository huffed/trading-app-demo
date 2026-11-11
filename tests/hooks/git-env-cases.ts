/**
 * Cases for guard-bash rule 1d: git prints a file it is given or can reach, ignored ones such as .env.local
 * included, and `git diff|log|show|blame|add|commit *` are pre-approved (the review of #335 found these). Nothing
 * here is executed.
 */

/** guard-bash.sh must refuse these (exit 2) with the git reason */
export const GIT_ENV_BLOCKED: readonly string[] = [
  // naming an env file
  "git diff --no-index /dev/null .env.local",
  "git show :.env.local",
  "git show HEAD:.env.local",
  "git blame --contents .env.local README.md",
  "git log -p -- .env.local",
  "git hash-object .env.local",
  "git commit -F .env.local",
  "git commit --file=.env.local",
  // reaching an ignored file without naming it
  "git diff --no-index /tmp/empty .",
  "git -C . diff --no-index a b",
  "git blame --contents README.md README.md",
  "git grep --no-index -e KEY",
  "git grep --untracked --no-exclude-standard -e KEY",
  // bringing an ignored file into the index or a stash, where a pre-approved diff or show then prints it
  "git add -f .env.local",
  "git add --force .",
  "git add -Af",
  "git stash push -a",
  "git stash --all",
];

/** guard-bash.sh must allow these (exit 0): the git a session uses */
export const GIT_ENV_ALLOWED: readonly string[] = [
  "git diff --stat origin/dev...HEAD",
  "git show origin/dev:scripts/ops/status.sh",
  "git add docs/DEBT.md",
  "git add -A",
  "git add -p docs",
  'git commit -m "docs: .env.example lists every name"',
  'git commit -m "the guard refuses reading .env.local from a session"',
  "git commit -F /tmp/msg.txt",
  "git grep -n live_trading_enabled -- src",
  "git stash list",
  "git stash apply",
  "git blame -L 1,5 docs/DEBT.md",
  "git log --oneline -3",
];
