# Status, 2026-11-25: the queue is merged, the fence's policy is in place, the window's plan and the trial's report are written

`wt/` below is `~/Documents/trading-app/wt/`. Older detail, with the pick-up this chat started from, is in `2026-11-19-guards-and-access.md` (its sections from 25 November back). Where this file and that one differ, this one is right.

## 1. The host, read-only (25 November, 17:34 to 17:40 UTC)

You approved each of the four calls: `make status`, the backup lines, the last daily summaries, and one more read for the fifth summary (Sunday's rotation had moved it to the rotated log) with the reboot flag's file time.

| What | Reading |
|---|---|
| Service | active (enabled) since 2026-11-14 06:31:09Z, restarts 0; checkout, live and verified all `2a7d7f7`. The host was up 18 days. |
| Ticks | scan, manage and heartbeat `http=200` at 17:30Z |
| Crontab | ops 12 entries, root 0 |
| Backups, 15 to 25 November | one `OK nightly/<date>` every night, no `FAILED` in either log. The two logs reach back to 15 November only. |
| Daily summaries, 18 to 25 November | each `service=active restarts=0 crons=12 held-by-kill-switch=0 failed-units=none`, `backup=` the night before |
| Held or paused | none held (`held-by-kill-switch=0` every day). Paused strategies are not in this read. |

**Not routine, two things:**
- **The reboot is still pending.** It has been since at least 17 November (the 17 November `make status`). The flag file's time is 2026-11-25 06:14:50Z: it was written again this morning (probably by unattended-upgrades' daily run; not checked), so it shows when it last changed, not when the reboot became pending. I did not read which package asked for it. Window step 2 reboots.
- **The daily summary says `sent (high)` every day,** because `scripts/ops/ops-health.sh:21` adds "reboot pending" to its attention list when the flag file exists.

Everything else since 17 November is routine: no failed night, no restart, no hold.


## 2. The queue: #352, #354, #353 are merged

`origin/main` was `2a7d7f7` and `dev` was `ea75c40` when I started (17:30 UTC); main has not moved. Each PR merged at the head it was green at, and each merge prompted you.

| PR | Merged as | What the rebase needed |
|---|---|---|
| #352 | `7fe3a8e` | Nothing: it was based on `ea75c40` already, so it merged at its listed head `15b974e`. |
| #354 | `e0480d1`, head `015b384` | DEBT rows only (D-46, D-47, D-49), both sides kept whole, so no review. `git range-diff` shows context lines only. |
| #353 | `32533f3`, head `dade7ad` | Squashed to one commit (same tree as `2d1d526`, hooks run), then DEBT rows and one DEV_SETUP sentence. The trial had #342 in front, so the real tree cannot equal the trial's. I checked the next best thing: the real head plus #342 (`git merge-tree`) gives the trial's tree `8524be9…` exactly, and the added and removed lines are the same. So the resolution is the one reviewed on 21 November, and no second review was needed. The two-line follow-up equals `wt/tools/fix353-trial.diff`; you approved its edit of `.lintstagedrc.mjs`. |

## 3. E0

- **PR-A is #355** (`2e1e7b0`), rebased onto `32533f3` with conflicts only in DEBT rows (kept whole). `pnpm build` passed at the rebase (47 s). A small review of the rebase and the number edit: no findings. CI green, with the fence job.
- **The stop-and-target branch is not open.** It waits for #355 to merge. I tried its rebase onto #355 and it needed one DEBT and one MODERNISATION line resolved; the trial is on `test/e0-stop-target` (local, not pushed). Its first review found one High: three of the six `it.fails` name the wrong cause, because the main cause is the backtester's 0.01-lot floor and not the fills. Also seven Mediums. A second commit, `ba9f1c4` (26 November), fixes the High, the seven Mediums and eight of nine Lows (the ninth is the rebase itself): the R test is split into the lot floor (P4, D-08) and the fills (P2, D-02), the tick runs at every bar close, and the stub joins embeds through the migrations' foreign keys. Its second review found no Critical or High, so the review rounds end there. Its one Medium was fixed in `9129258`: three fill `it.fails` compared with golden's price, so they would have kept failing after the defect they name was fixed; they now compare with the stored level. Its seven Lows were fixed there too, with one stub gap written into D-47. `make check` passed at `ba9f1c4` (934 s) and at `9129258` (881 s; 3095 tests passed, 24 expected fails). The branch is about 1,100 lines against #355, over the ~500 guideline. I keep it as one PR, as you listed it, because a split would make the second half wait for the first to merge. Its body is ready (`wt/tools/e0c-pr-body.md`). I open it after #355 merges, rebased onto `dev`; a rebase whose conflict is not confined to DEBT rows gets one review of that diff.

## 4. The fence on GitHub

- **The policy call is done.** Actions event policy 17708, `active`, `pull_request_target` for `.github/workflows/fence.yml` only, at 18:24:56 UTC; before it, `gh api …/actions/policies` was empty. The call was `gh api -X POST repos/huffed/trading-app-demo/actions/policies --input wt/tools/fence-policy.json`, whose body is decision 0015's, checked by `diff`.
- **The job has run on an open PR:** #355 (run 45674301959 at 18:21, before the policy, and 45675091229 at 18:25 after it, both passed). That satisfies "shown running on an open PR". A run on or after 2 December is still to be seen, for the required check.
- **The throwaway test is done.** Repository huffed/fence-check-probe (public), created with `gh api -X POST user/repos` (you approved it). It has the fence's ruleset shape, 22 pull requests, and nothing from the project. 4 prompts in all: create, the ruleset, and off and on again for one push. The ruleset read back active after the last reading (23:39 UTC), and all 22 were re-read then.
- **The answer: a same-named check does not override the fence while the fence has a run on the commit.** A failing fence run, or one still running, kept the PR BLOCKED in all 11 cases: a same-named job after it, before it, on `push`, through the API with `checks: write`, from a workflow also named `fence`, and even from a PR that changes `fence.yml` itself. The positive control (a passing fence) was CLEAN. **With the fence's workflow switched off, a same-named run from the PR answers the check alone** (CLEAN, from a job and through the API), and with nothing reporting the PR stays BLOCKED. So the required check is only as good as the fence's run being there; a missing policy was not tried but would look the same. Of two fence runs on one commit, the later decided, once in each order.
- **The record is in #357:** decision 0015, D-48, DEV_SETUP §12 and the index. Its first review found three Highs in the text, not the test: no read-back of the ruleset, a conclusion larger than the cases, and three older sentences the result disproved. I redid the test with 14 more cases and rewrote the text. The second review found one more High of the same kind (a sentence still wider than the cases); fixed. The third found no Critical or High, and its Mediums and Lows are fixed in the same push (head `4f54c11`).
- **Delete the repository by hand:** `gh` has no delete scope (its scopes are gist, read:org, repo and workflow), so I did not try. After #357 merges, please delete huffed/fence-check-probe in Settings. Its readings are in `wt/tools/probe-results.txt`.
- **Not done, as agreed:** the required check. It needs a run on a PR on or after 2 December with the policy in place.

## 5. The window's plan (PR #356)

- The section names no date of its own, says what changes on a Sunday, and compares by script with `origin/dev`: no fenced block and no command span changed (`wt/tools/plan_codeblocks.py`).
- **Two things are not the same on the two days,** and the plan says so: step 6 cannot be read on a Saturday (it is read on the Sunday), and on a Sunday window `verify-full` and the paused-pairs count wait for the next Saturday window, because `verify-full`'s first scheduled night would be Monday's, inside the freeze, where a failure could not be rolled back until Friday.
- **A High the first review found, and the reason to have run it:** step 2's check expected an empty diff list. It is not empty since #345, #350 and #353, so the check would have stopped the window after #342 had merged. The plan now compares with a list written on the sheet.
- **Choices I made, which you may reverse:** those two; the Sunday deadlines (step 1 by 13:30, #342 merged by 14:00, the deploy started by 15:30, step 3 by 15:45, the reboot by 17:10 UK); step 7 before step 6 on a Saturday; and the old nights 11 to 14 November, which no file the step reads still holds (backups 15 to 25 were read today).
- **The sheet** is `docs/status/window-sheet.md`, next to this file. It is the sheet for any window, with three placeholders (`dev`'s head, #342's head and the expected list) filled after the last merge before Friday 20:00. The 21 November sheet stays as the record of that plan.
- **Review 3 (26 November), the last:** no Critical or High; three Mediums and eight Lows, fixed in `f041449` and in the sheet. The three Mediums: with #342 on the list, nothing bounded the deploy's and the reboot's start (now 15:30 and 17:10); nothing said what happens to a step still running at 18:00 (it is finished, or put back by its own rollback, before 22:00 UK, and past that you decide; the deploy target refuses from Sunday 21:00); and a missed 13:30 or 14:00 left #342 on READY TO MERGE (it now comes off, and if it merged late anyway step 3 still runs that day by 15:45). The command comparison still prints `NO COMMAND CHANGED 0`.

## 6. The sandbox trial's report (PR #358)

Two of the seven days ran (17 and 18 November), and nothing after. So the report recommends nothing on committed settings, and nothing on retiring rules 1, 7 or 8. It names six missing runs (M1 to M6). It recommends keeping the guard frozen, closing #336 as you decided, and giving the reviewer hook the 60 s and block the guards got. Three reviews; the last found no Critical or High.

**Two sentences of mine in the 19 November status file were wrong, and are corrected there today:**
- "No skipped guard let a `gh pr merge` through" was an inference from the refused commands. Two skipped commands ran one, #343 and #345 on 17 November. Each met a permission prompt that you accepted once, so nothing got through, but the sentence was wrong.
- "None of the 46 ran one" was wrong: one wrote and ran the D.4 host script on 1 November, under your order that day.
- I also said "the four host reads were all asked for". There were five, plus the host change, and the fifth (7 November 15:34 UTC) has no order I could find. All of them were approved by the auto-mode classifier with no prompt.
- No live-table write and no broker call was found, but the search reads command text only, and some patterns cover only part of the runs. The report says which.

## The `.cjs` note, checked

`make lint` (`eslint .`) does not lint `.claude/hooks/lib/hook-input.cjs` either: `eslint.config.mjs:120` ignores `.claude/**`, and `pnpm exec eslint .claude/hooks/lib/hook-input.cjs` prints "File ignored because of a matching ignore pattern" (run 25 November in `wt/fence`). With lint-staged's globs skipping `.cjs`, nothing lints that file. It goes in the ledger PR's row beside the unchecked shell scripts.

## For the planner

**Heads, 26 November:** #355 `2e1e7b0`, #356 `f041449` (review 3 fixed), #357 `4f54c11`, #358 `27d5c01`; the stop-and-target branch `9129258`, local, review-clean, opened after #355 merges.

**Mine, in this order:** (1) after "merge the queue", #355, then #356, then the record (#357) and the report (#358), rebasing each as needed; (2) the stop-and-target PR's second review and opening, after #355; (3) #342, rebased last, READY TO MERGE by Friday 27 November 20:00 UK; (4) the window sheet's two heads after the last merge before that; (5) after the window, the log, the ledger PR (D-18, D-23, D-24, D-25, D-27, D-28, D-35, D-38, item 10's rows, the `/tmp` row, the unchecked shell scripts and the `.cjs` note) and the kill-switch case's time alone; (6) the sudoers PR, from the window's ledger, 20:00 UK the Friday after it; (7) on or after 2 December, the required check.

**Merge order and conflicts** (`git merge-tree`, 25 November): #355, #356 and #358 merge cleanly with each other and with #342. #357 conflicts with #355 in `docs/DEBT.md` rows only (D-47 beside D-48), resolved by keeping both rows whole, so no review. Each needs `gh pr update-branch` after the one before, then green CI.

**A hold to know:** from Friday 27 November 20:00 UK nothing merges into `dev` until window step 2 has merged #342, so the four PRs above need your "merge the queue" before then.

**Restart and chat:** this chat is `16c30c82`, resumed at 14:34 UTC today; the pick-up chat (`25595016`) is closed. `demo-1` is on the audit's branch and I write only in my own worktrees.

**Not routine, small:** I used `git stash` once in my scratch worktree, which shares its list with every checkout, and dropped my own entry again at once after checking it was mine.
