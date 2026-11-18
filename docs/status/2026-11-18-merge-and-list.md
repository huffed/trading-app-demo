# 18 November: the queue, and the operator's list

The operator's order of 18 November: merge #347, #351, #348, #350, #349 and #352, then items 1 to 10. Times are UTC; the machine's clock is GMT.

## The queue

- **Merged, in order:** #347 as `1ddc227`, #351 as `2fb82d7`, #348 as `ea54664`, #350 as `7f8c590`, #349 as `ea75c40`.
  - Each merge was `gh pr merge <n> --squash --match-head-commit <sha>`, at the head after `gh pr update-branch <n> --rebase`, once CI was green there.
  - A waiter script read the new head and polled CI. It wrote its own exit status to a log, not through a pipe.
- **#352 is not merged.** GitHub's rebase stopped on `docs/DEBT.md`, so I rebased it locally.
  - The conflicts were rows only: its D-05 note and D-47 sit next to D-06 (#351) and D-46 (#350).
  - A script took each row whole from the one side that changed it, against each commit's own parent. It would have stopped on a row both sides changed; there was none.
  - `git range-diff` shows the four commits unchanged apart from those context rows.
  - It is green at `15b974e` and back on READY TO MERGE with no review, as the operator ruled. The PR body says so.
- **The audit's go:** it waits for #352, the sixth.
- **`notify.log`:** not read yet. The operator asked for it once the audit has merged `dev` into the main checkout's branch, which has not happened.

## 1. #342, for Saturday

- **Rebased early.** It was rebased onto `dev` at `ea75c40` once five of the six had merged, rather than waiting for the sixth. #352 can merge only on the operator's next "merge the queue", and #347, the PR that might conflict with #342, had already merged.
- **No conflict.** The rebase applied all 15 commits cleanly. It needs green CI only (operator's rule for a conflict-free rebase).
- **Checked anyway,** because #347 and #342 both edit `docs/PHASE_D_PLAN.md` and `docs/MODERNISATION.md`:
  - #342's plan edits sit on #347's text: step 3's "about an hour and a half", and the saved-crontab line.
  - Its citations still name the right lines on the new head: `resume.sh:89-90` installs the saved copy, `kill-switch.sh:125-131` saves it, `:132-143` is the unsaved branch, and `kill-switch.sh:216` is the call to `/api/admin/flatten-algo` that MODERNISATION cites.
- **Green at `c531812`, on READY TO MERGE for window step 2.** If #352 merges before Friday 20:00 UK, #342 will be one behind, and step 2a starts with GitHub's rebase and its CI.

## 2. What emptied three worktrees' `node_modules`

**First, the risk.** The cause can delete uncommitted work in any scratch worktree under `/tmp` that is left alone for more than three days, and it did delete checked-out files. It cannot reach the main checkout, which is under `~/Documents`, outside `/tmp`. No uncommitted work was lost this time (below).

**The cause: macOS's `/tmp` cleaner.**
- `/System/Library/LaunchDaemons/com.apple.tmp_cleaner.plist` runs `/usr/libexec/tmp_cleaner` daily at hour 0, which here is 00:00 GMT.
- That shell script runs, under `/tmp`:
  - `find -dx . -fstype local -type f -atime +3 -mtime +3 -ctime +3 -delete`, which deletes every regular file not accessed, modified or changed in more than three days;
  - then the same for empty directories older than three days.
- The scratchpad, and so every scratch worktree, was under `/private/tmp/claude-502/…`.

**The evidence.**
- **The times match the run.** In wt-e0 and wt-k, `node_modules`' last directory changes were at 00:01Z and 00:00Z on 18 November. Both worktrees were made on 13 November, installed at 08:25 that day, about 4.6 days before the run.
- **The survivors fit the rule.** Each install kept only 17 files. Every one of them had been run between 22:39 and 22:51 on 17 November: bin scripts, `tsc`, `eslint.js`, native modules. Those have recent access times; files only read, such as Prettier's `package.json`, did not keep one.
- **The rule's limits explain the rest.** Older entries survive elsewhere in `/tmp`: sockets, and the symlinks pnpm uses. The script deletes only regular files (`-type f`).
- **It took more than `node_modules`.** All four worktrees made on 13 November lost their `.git` file, and with it their link to the repository: wt-e0, wt-k, wt-b and wt-d. Of about 1,410 tracked files each, only 26 to 64 were left, the ones edited in the last three days. wt-d's install survived only because it was reinstalled on 17 November.

**What I ruled out, and how.**
- **Lost work.** Every surviving tracked file in the four is byte-identical to its pushed branch. The only untracked files were husky's hook copies and `tsconfig.tsbuildinfo`. So nothing uncommitted was lost. An edit that sat more than three days without a commit would have been, and could not be seen afterwards.
- **A session, agent or trial command.** A script read every Bash and tool call in this project's 125 transcripts written since noon on 17 November, looking for install, prune, `store prune`, `git clean`, `git worktree remove/prune`, `rm -r`/`rm -f`, `rmtree`, `os.remove` and `find -delete`. 42 matched; none touched the four worktrees or the scratchpad above them:
  - my own removal of two probe files in wt-e0 (21:58) and of an empty `review/` in wt-d (21:27);
  - the E0 fork's install in its new wt-e0t (21:34);
  - the trial's removal of its own `wt-trial/node_modules` and of two probe files in pnpm's folders (20:40), its sandboxed installs in wt-trial, and its probe file in the home folder.
- **Sharing.** No file in any of the installs has a hard link (`st_nlink` is 1), and none of their 2,071 symlinks leaves its own worktree. Each install is its own copy, so nothing is shared with the trial's worktree.
- **Disk.** 171 GiB free (`df -h`).
- **A correction to last night's note.** wt-b never had an install, so nothing was removed from its `node_modules`.

**Done about it.**
- The four broken worktrees' git entries were pruned (`git worktree prune -v`, after a dry run listing exactly those four), and their remains removed.
- Every worktree still in use now lives in `/Users/jack.jones/Documents/trading-app/wt/`: the trial's, the status one, #352's, #342's and the private repo's clone. The trial's worktree and the private clone, both made on 17 November, would have been emptied at 00:00Z on Saturday 21 November.
- The heavy-job tools and drafts live there too; the scratchpad keeps only throwaway files.

## 3. Load

- **The rule as applied:**
  - `tools/heavy.py` lists heavy jobs (make check, test or backtest, pnpm build, next build, vitest, the backtester's tsx) with their working folder;
  - `tools/heavy-run.sh` runs a heavy job only while fewer than two run in total, and only through one slot, so this session has at most one heavy job at a time and the audit's runs always have room.
- **Who uses it:** both background agents (items 6 and 7) were told to run every heavy job through it; item 6's agent runs `pnpm install` through it as well, while the trial's timed pair runs.
- **One lapse:** day two's first pair ran before the slot existed and overlapped my own `pnpm install` and the fence agent's start (below).

## 4. Sandbox trial, day two

- **The machine was quiet before each run:** no heavy job, and the audit idle.
- **The method:** the same commit for both runs (day one's trial branch, with its two fixes: the tsx socket and the `/tmp` grant), Node v26.13.0 named explicitly, and one-minute load samples taken through each run.
- **The sandboxed run:** a headless `claude -p` in the trial worktree, with committed settings only and `dontAsk` mode, as on day one.

| | Inside the sandbox | Outside |
|---|---|---|
| Pair 1 `make check` | 1,906 s (31.8 min), exit 2, from 16:11:40Z | 1,773 s (29.6 min), exit 0, from 16:43:30Z |
| Pair 1 tests | 3 failed, 2,815 passed, 11 expected fail | 2,818 passed, 11 expected fail |
| Pair 1 load, one-minute mean (min to max) | 5.76 (2.2 to 24.7) | 3.98 (2.6 to 9.4) |
| Pair 2 | running at writing, under the slot | running at writing |

- **Pair 1's three failures** were all guard tests in `tests/hooks/hooks.test.ts`, each `expected -1 to be 2`: a hook run cut off at #344's 10-second bound. The trial's commit predates #349's 60 seconds. Day one had 17 such failures and 27 in all; day two's fixes closed the socket and `/tmp` ones.
- **Pair 1's conditions were not the same, and that was my doing.** The sandbox run overlapped my install in item 5's worktree and the fence agent's start. So pair 2 repeats both runs back to back, at the same commit, with the slot held for the whole pair.
- **The git push from inside the sandbox has no result yet. That was my mistake.** In zsh, `"$sha:refs/…"` applies the `:r` modifier to `$sha`, so git refused the mangled refspec before reaching the network. The script now uses `"${sha}:refs/…"`, and pair 2 ends with the push.
  - It pushes a probe branch at `dev`'s own commit, so no new content, to the repo's HTTPS remote.
  - The probe branch, if it is created, gets deleted.
- **The full day-two notes,** with pair 2's numbers and both failure lists side by side, go into the private repo's `trial/` once pair 2 ends.

## 5. The post-edit lint hook and `review/`

- **The change:** `.claude/hooks/post-edit-lint.sh` resolves the file's path against the project root, following symlinks. For a path under `review/`, new or tracked, it skips the Prettier check and runs only the baseline config with errors only. Elsewhere nothing changes.
- **The test,** `tests/hooks/post-edit-lint.test.ts` (new, strict-lint clean): six cases, in a throwaway git repo with a fake `pnpm` that records each call. Its six cases:
  - new and tracked files under `review/` get the baseline config and no Prettier check;
  - a new file elsewhere gets the strict config and Prettier;
  - a tracked file elsewhere gets the baseline config and Prettier;
  - a `review/` file named through its resolved path still counts;
  - a `review/` folder outside the project does not count.
  - All six pass. Against `dev`'s hook, the three `review/` cases fail and the other three pass, so the test pins the change.
- **Docs:** DEV_SETUP §5 and §9, and D-46's way out, now name the hook.
- **State:** committed as `4bcb02b` on `tooling/post-edit-lint-review`. `make check` and `pnpm build` are queued on the slot behind the trial's pair; the PR opens after them, then its review.

## 6. E0, the next two PRs

The agent that wrote #352 is building the first: D-47's harness items, and the stale-silently gap, derived from the migrations if it fits. Its PR opens after #352 merges and it has rebased; its heavy jobs and install go through the slot. The stop-and-target scenario follows once that PR merges.

## 7. The fence, in CI

A background agent is building it. Its brief:
- read the list and the matcher from the base, so the PR under test cannot turn the job off;
- a test that the CI matcher and `guard-paths.sh` agree, since the hook is frozen;
- the job's verdict on #291 and #352;
- the ruleset read only. I add the required check after the merge, because one that is not yet on `dev` would block every PR.

## 8. The window sheet

Pushed as `899a96e`: `docs/status/2026-11-21-window-sheet.md` on this branch.

## 9. Sudoers (D-23)

Next week, from the sudo commands the window's ledger shows were used; READY TO MERGE by Friday 27 November 20:00 UK.

## 10. Small rows, held for the next docs PR I open anyway

That is likely the window's ledger PR, unless another docs PR comes first.
- **CLAUDE.md, under Claims:** a check's result is its own exit status, never read through a pipe; write the output to a file and read the file.
- **DEBT, the build depends on Google Fonts.** The host's deploy builds the app (`scripts/ops/deploy.sh:215`), and so does its restore path (`:78`). `src/app/layout.tsx:1` loads Geist through `next/font/google`, which fetches at build time. So the deploy depends on a third party while it builds. Not checked: whether Next's build cache serves the fonts offline.
- **DEBT:** `review/`'s shell and Python scripts are checked by nothing, until the audit's `make validate` and `make parity` PR brings them under checks.
- **The window's ledger PR:** D-24, D-25 and D-27's stale targets.
- **Mine, the same kind of row:** a DEV_SETUP line that macOS empties `/tmp` of files untouched for three days, so a worktree that must live longer goes elsewhere.

## End of the queue: proposals

- **Kernel reboots without a window.** With the operator's fact for it: on FTMO's symbols page, XAU/USD trades Monday to Friday, 01:05 to 23:50 platform time (GMT+2), so the nightly break is 75 minutes.
- **A real Postgres under the E0 stub** (five lines, no work):
  - **What:** PGlite (Postgres compiled to WebAssembly, run inside the test process) with `supabase/migrations` applied, behind a small adapter that turns the supabase-js calls the engine makes into SQL.
  - **Cost:** one dev dependency; the adapter, perhaps 200 to 300 lines; stubs for what the migrations take from Supabase (the `auth` schema, `auth.uid()` in RLS policies, extensions); and the time to apply 50-odd migrations, which a cached snapshot would cut. None of this has been tried.
  - **D-47 gaps it removes:** the hand-copied defaults, NOT NULLs and CHECKs; CHECK order; NULL in `neq` and `eq`; foreign keys; a column left out reading as NULL; the `updated_at` trigger; seeds that skip the checks; and `update().single()` over several rows.
  - **Gaps it leaves,** which are PostgREST's and the client's: `PGRST204`, `select()`'s returning rule, and the array insert's NULL defaults.
- **The reviewer hook's 10 s and its allowlist:** they wait for the trial's report, as the operator said.

## For the planner

- **Done today:** five of the six merged; #342 rebased and green; the `/tmp` cause found and every worktree moved; the window sheet pushed; item 5 committed.
- **On READY TO MERGE:** #352 (`15b974e`), then #342 (`c531812`, window step 2).
- **Still running:** day two's second pair and its push; item 5's checks, then its PR and review; items 6 and 7 with their agents.
- **Waiting on the operator:**
  - "merge the queue" for #352; the audit's go follows it;
  - after that, `notify.log` gets read.
- **Watch:** from Friday 20:00 UK nothing merges into `dev` until step 2 merges #342. Item 7's PR, if it is ready before then, goes on the list for after the window.

## Later: day two's result, and a fault in the slot

- **Day two is done.** The notes are in the private repo at `b5f5034`, `trial/2026-11-18-day2.md`, with the raw logs.
  - **Pair 2,** both runs at the same commit, back to back, under the slot: inside the sandbox 1,955 s (32.6 min), outside 1,903 s (31.7 min). Both exit 0, with 2,818 passed and 11 expected fail; no failures on either side. The one-minute load averaged 4.76 inside and 3.78 outside.
  - **What that shows:** with day one's two fixes, `make check` passes inside the sandbox, and the sandbox costs about 3% in time. Day one's 2.4 times was the load and the 10-second timeouts.
- **The git push from inside the sandbox works.**
  - **The evidence:** the probe branch appeared on GitHub at `dev`'s commit, and `ci` started a run for it at 19:20:10Z.
  - **How:** the credential came from `osxkeychain`, which the Command Line Tools' system gitconfig sets, so git reached the keychain from inside the sandbox; `github.com` is allowed. A rule against pushing has to be a permission rule or a git hook.
  - **What was lost, by my scripting errors:** git's own output and exit status. Pair 1's push never left the machine (zsh's `:r` modifier on `$sha:refs`), and my fix then commented out the line's redirect.
  - **Cleaned up:** the branch is deleted, and its CI run was cancelled.
- **A fault in my slot tool, fixed at 19:24:17Z** (the file's modification time). `heavy.py` counted the waiting `heavy-run.sh` wrappers as heavy jobs, because their command lines contain "make check". With two wrappers waiting, each saw two jobs and neither started. So from 19:20:11Z, when the trial's pair freed the slot, until the fix, nothing started. Item 6's install took the slot at 19:24:21Z and finished; the fence agent's `make check` took it at 19:25:30Z; item 5's waits behind that. Waiting wrappers no longer count; the next poll starts one of them.
