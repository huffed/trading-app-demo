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
  // the review of #336: a commit option that names one, any spelling git accepts
  "git commit --pathspec-from-file=.env.local -m x",
  "git commit --allow-empty -F.env.local",
  "git commit --allow-empty -aF .env.local",
  "git commit --allow-empty --fil=.env.local",
  "git commit --allow-empty --allow-empty-message --no-edit -t .env.local",
  "git commit --template=.env.local",
  // a diff path outside the repository is --no-index without the flag
  "git diff /dev/null .en?.local",
  "git diff /var/empty .",
  "git diff ~/empty .",
  "git diff ../../x .",
  // blame reads a file through -S and --ignore-revs-file, and git takes a prefix of a long option
  "git blame -S .en?.local README.md",
  "git blame -wS revs README.md",
  "git blame --ignore-revs-file .en?.local README.md",
  "git blame --cont .en?.local README.md",
  "git add --forc '*.local'",
  "git add --f '*.local'",
  "git grep --no-ind -e .",
  "git grep --untracked --no-exclude -e .",
  "git stash push --al",
  // quoting, case and global options that hid the flag from the old reading
  "git add $'-f' '*.local'",
  'git -C "a b" diff --no-index /var/empty .',
  "GIT diff --no-index /var/empty .",
  "git --git-dir=.git --work-tree=. diff --no-index a b",
  // an alias or git configuration set for this command can run anything
  "git -c alias.x='!cat .en?.local' x",
  "git --config-env=alias.x=X x",
  `GIT_CONFIG_PARAMETERS="'alias.d=diff --no-index'" git d /dev/null .en?.local`,
  "export GIT_CONFIG_COUNT=1",
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
  // the review of #336: the message may mention one however it is spelled, and these never print the file
  'git commit -am "docs: .env.local stays ignored"',
  'git commit -m"docs: .env.local stays ignored"',
  'git commit --message="docs: .env.local stays ignored"',
  'git stash push -m "before .env.local work"',
  "git rm --cached .env.local",
  "git restore --staged .env.local",
  "git check-ignore -v .env.local",
  "git status --short .env.local",
  "git diff HEAD~3 -- docs",
  "git diff --name-only origin/dev...HEAD",
  "git diff docs/../README.md",
  "git -C . log --oneline -1",
  "git add --all docs",
];
