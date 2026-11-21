# Status, 2026-11-21: the queue waits for the window's deploy, and what to pick up after the restart

`wt/` below is `~/Documents/trading-app/wt/`. The sections from 19 and 20 November follow the new ones.

## 21 November: the queue waits for the window's deploy

**The order (operator, 21 November).**
- Merge #352, #354 and #353, in that order, once `origin/main` has moved off `2a7d7f7` to the commit that merged #342.
- Each merges at its new head once green, and `gh pr merge` prompts you for each.
- If the window is off this weekend, they merge at once, and #342 is rebased for next Friday.

**When I started (19:34 UK).**
- `origin/main` was `2a7d7f7` and `dev` was `ea75c40`.
- #342 was open at `c531812`, CLEAN.
- At 19:50 UK there was no `../qt-window` yet.
- A background poll waits for main to move: `wt/tools/wait_main.sh`, every 60 s for at most 24 h, logging to `wt/tools/wait-main.log`. It dies with the session, so it has to be started again after the restart (next section).

**What the rebases will meet.** I checked with `git merge-tree`, then rebased for real in a detached worktree onto a stand-in for `dev`: #342's head with #352 merged on it.

| PR | Conflict | What it then needs |
|---|---|---|
| #352 | None. | `gh pr update-branch --rebase`, then green CI. |
| #354 | `docs/DEBT.md` rows only: #354 changed D-46 and added D-49; #352 added D-47. The resolver (`wt/tools/resolve_rebase.py`, below) keeps both sides' rows whole. `git range-diff` shows #354's two commits unchanged apart from context lines. | A local rebase in `wt/pel`, a push and green CI. No review, per decision 0013; the PR body says so. |
| #353 | `docs/DEBT.md` rows, with its D-48 among D-46, D-47 and D-49. Also one row of `docs/DEV_SETUP.md`'s hooks table, where #354 changed a sentence and #353 added one. | Its first commit named its row D-47, which is #352's, so its five commits are squashed into one before the rebase (same tree as `2d1d526`). `wt/tools/resolve_rebase.py --fence-sentence` resolves both files, and stops on any other shape. After the rebase the change is the same size: 13 files, +630/−7. The resolution's one review, on the trial, found no Critical or High (below). The real rebase must produce the trial's tree, or the review is done again. Then a one-line fix and its review, a push and green CI. Then a push and green CI. |
| E0 PR-A | After #352: `docs/DEBT.md` rows only, with #354 and #353. | A rebase, `pnpm build`, then open it. |

**The review of #353's resolution** (fresh context, 21 November, on the trial `7d2d7e3`): no Critical or High. Nothing of #353, #352, #354 or #342 is lost in either file; rows D-46 to D-49 are whole and in order; the sentence sits where #353 had it; every fence reference says D-48. Its findings:
- **Medium, in my resolver, not the PR:** it took its base from the commit named on its command line, unchecked; naming the wrong one would have reverted #354's D-46 silently. **Fixed:** `wt/tools/resolve_rebase.py` replaces both resolvers. It reads each block's own base (the rebase runs with `merge.conflictStyle=diff3`), so no commit is named.
- **Four Lows, in the resolver:** two rows with one ID on a side, deleted rows, a weak check of the DEV_SETUP block, other unmerged paths. **Fixed in the same script:** each of them stops it, and the DEV_SETUP block must equal its own base plus the one sentence. Both trials, run again with it, give the same trees as before (`2257095`, `7d2d7e3`).
- **Low, in #353 itself, already at `2d1d526`:** DEV_SETUP §9 says lint-staged's shellcheck covers "ops scripts and hooks", but #353 added `scripts/ci/*.sh` to it. It is one line, so it is fixed in one commit on top of the rebased #353, because #354 rewrote that line. Two reviews of the fix followed, on the trial and uncommitted. Neither found a Critical or High, so the loop ends. Their Lows were each one line, and all are fixed:
  - `.lintstagedrc.mjs:9`'s header comment had the same stale list. It now names the CI scripts.
  - The DEV_SETUP sentence said "hooks", which reads as every hook, and named them again in a later "also covers" clause. It now names each glob lint-staged shellchecks, the baseline's included, and the clause is gone.
  - An exception sentence for `.husky/pre-commit` is out. It read as the only shell script nothing checks, but `scripts/canonical/e2-post-sweep.sh` and `scripts/canonical/run-augmented-f-f2.sh` are unchecked too.

  The final diff is `wt/tools/fix353-trial.diff`: one line in each file, and no line moves. Shell scripts that nothing shellchecks (`.husky/pre-commit` and those two) become a row in the ledger PR, beside item 10's row for `review/`'s scripts. A reviewer also noticed that lint-staged lints no `.cjs` file at commit time (`.claude/hooks/lib/hook-input.cjs`). That is unchecked, and I'll look at it before writing that row.

## After the restart: what to pick up

You restart this session and the audit's on Sunday, once the audit's merge of `dev` is in the main checkout and each session has stopped on a turn ending. The merge is in: `6b834d2`, 18:47Z today. The new session starts here, as does a pointer in its memory.

1. **The poll.** Read `wt/tools/wait-main.log`.
   - If main has not moved, start `bash wt/tools/wait_main.sh 2a7d7f7210de1fa2f81e8aecb805372a4f735162` again, in the background.
   - If it has moved, check it is #342's merge commit (`gh pr view 342 --json mergeCommit`), and say what main showed.
2. **#352.** `gh pr update-branch 352 --rebase`, then `wt/tools/wait_head.sh 352`, then `gh pr merge 352 --squash --match-head-commit <the green head>`.
3. **#354, in `wt/pel`.**
   - `git fetch origin`, then `git -c merge.conflictStyle=diff3 rebase origin/dev`.
   - At each stop: `python3 -I wt/tools/resolve_rebase.py wt/pel`, `git add docs/DEBT.md`, `git -c merge.conflictStyle=diff3 rebase --continue`. Without the base sections, the script stops.
   - Check that `git range-diff` shows context lines only. If `dev`'s tree equals the stand-in `9ac2090`'s, the new head's tree must equal the trial's `2257095`.
   - Push with `--force-with-lease=tooling/post-edit-lint-review:0615de2`, put the no-review line in the body, wait for green, merge.
4. **#353, in `wt/fence`.**
   - Squash it to one commit on `ea75c40` with `2d1d526`'s tree, then `git -c merge.conflictStyle=diff3 rebase origin/dev`.
   - `python3 -I wt/tools/resolve_rebase.py wt/fence --fence-sentence`, add both files, continue.
   - The new head's tree must equal the trial's `7d2d7e3`. If it does not, the resolution gets a new review.
   - Then the follow-up: `python3 -I wt/tools/fix_353_l117.py wt/fence` for DEV_SETUP, and the same one-line edit of `.lintstagedrc.mjs:9`'s comment, made with the Edit tool so the tool-config rules apply. `git diff` must equal `wt/tools/fix353-trial.diff`. Then one commit, run through the hooks like any other.
   - Push with `--force-with-lease=tooling/fence-ci:2d1d526`. The body says it was squashed and reviewed. Wait for green, merge.
5. **Any other conflict** takes that PR off the list, and the report says so.
6. **E0 PR-A, after #352, in `wt/e0b`.**
   - `git rebase --onto origin/dev 15b974e`, with the rows resolved as in step 3.
   - `bash ../tools/heavy-run.sh e0b-build pnpm build`.
   - `gh pr create` with `wt/tools/pr-a-body.md`, its size line updated; the PR's number goes in D-47 ("this PR") and in MODERNISATION.
   - After it merges: the stop-and-target branch (`wt/e0c`, `9aff959`) is rebased and opened, and gets its own review.
7. **notify.log.** Report whether turn endings are logged again since the restart (section below).
8. **After the window.**
   - Push the window session's log (`../qt-window/docs/status/2026-11-21-window-log.md`, uncommitted) to `status/2026-11-18`.
   - Open the ledger PR from that log and the deploy driver's rows. It also carries D-24, D-25 and D-27's stale targets, item 10's rows, the `/tmp` row, and a row for the shell scripts nothing shellchecks (above).
   - Then look at why the kill-switch case is slow when it runs alone (below).
9. **After Sunday 18:00 UK, with #353 on `dev`.**
   - Run decision 0015's policy call, which prompts you; then show the job running on an open PR.
   - The throwaway public repository, which prompts you when it is created: test whether a second check run named `live-path fence`, from the PR's own workflow, can answer the required check. Record what was run in 0015 and D-48. Then delete the repository; if `gh` lacks the scope, say so, and the operator deletes it.
   - The check becomes required once the result is recorded and the job has been seen on a PR on or after 2 December, with the policy in place. Until then, a red fence run keeps a PR off READY TO MERGE.
10. **Next week.** The sudoers PR, from the window's ledger: READY TO MERGE by Fri 27 Nov 20:00 UK.
11. **Standing rules.**
    - Heavy jobs run only through `wt/tools/heavy-run.sh`.
    - A time limit is never raised because a loaded run timed out.
    - `/tmp` is purged after three days, so the trial scripts and PR-A's body are kept in `wt/tools/`.

## The audit session's guard runs: the same count and replay

You asked for the same count and replay over the audit session's transcripts, read-only, within 30 minutes. It took about 15.

- **The session.** One session, `efe10428…`, running since 19 October: its main transcript and six agents'. Since 28 October it has run the same Claude Code version as this session, which records a cancelled hook the same way. The folder's two other sessions (2 and 6 November, 13 Bash calls) have no runs without a verdict.
- **The count.** 1,483 Bash calls, and **9 guard runs that gave no verdict**, all 10 s timeouts: eight on 17 November, from 01:56Z to 19:12Z, and one today at 18:46Z. All nine commands ran unchecked.
- **The replay.** Today's guard (`dev`'s `ea75c40`, which demo-1 now carries) **allows all nine**. They were:
  - `git status`, `fetch`, `log` and `rev-parse`;
  - a checkout of the audit's own branch in its own checkout;
  - an append to `review/log.md`;
  - a Python read of `review/results/`;
  - tails of the audit's own scratchpad logs.

  None touched `.env`, a host, the broker, a live table or `gh pr merge`.
- **Control.** Two of this session's commands that 19 November's replay refused are still refused by today's guard; both were heredocs fed to Python, in a command that names a host command. One that it allowed is still allowed.
- **This session, for comparison.** 976 runs without a verdict over 17,096 Bash calls: 949 timeouts and 27 that could not start, the last on 20 November at 17:08Z. The 77 since 19 November 03:45Z have not been replayed.
- **Scripts and output:** `wt/tools/guard-replay/`.

## 19 November: guard-bash usually lets the command run when it doesn't answer in time

**What happens.**
- In this session, `guard-bash.sh` is a PreToolUse hook with a 10 s timeout.
- When it runs past 10 s, Claude Code cancels it and runs the command anyway. A hook that cannot start does the same: Claude Code blocks only on exit 2.

**How often.**
- Claude Code's own transcripts for this session and its agents (121 files, 16,694 Bash calls since 28 October) record **911 guard runs that gave no verdict**:
  - 893 timed out at 10 s, from 2026-10-30 18:39Z to 2026-11-19 14:14Z;
  - 18 could not start while Documents was refused.
- **Every one of those commands ran unchecked.** That is about one Bash call in eighteen.

**Why this session has it.**
- `dev` fixed this in #349 (`ea75c40`, 18 November): 60 s and `"onFailure": "block"`, so a guard that times out or cannot start refuses the call.
- This session takes its settings from the demo-1 checkout. That is the audit's branch, which still has 10 s and no `onFailure`. Claude Code also reads hooks only when a session starts, and this one started on 28 October.
- The audit's own session runs the same way: checked on 21 November (above).

**What the skipped commands were.** I ran today's guard by hand on each of the 899 recorded up to 03:45Z (script and results in the session's scratchpad):

| Today's guard says | Count | What they were |
|---|---|---|
| allow | 678 | — |
| refuse, a shell construct | 165 | a substitution or variable as a command word, a heredoc, a pre-approved tool over several lines |
| refuse, text about secrets, hosts, the broker or deletion | 46 | file writes (runbooks, scripts, tests, PR bodies) whose text names `ssh`, `.env`, `make kill-switch` and so on; none of them ran one |
| refuse, a `.env` name | 2 | an agent grepping a test log for the test named "blocks: cat .env.local"; no `.env` file was read |
| refuse, a host command | 4 | read-only host scripts over ssh, `ssh qt 'bash -s' < <local read script>`: two on 6 November at 19:00Z, two on 10 November at 19:57Z. Each followed the operator's ask: 18:46Z on 6 November, "Keep tracing D-31 read-only: which endpoint returns the 401 …"; 19:50Z on 10 November, "Host state now: running commit, service, ticks …" |
| no answer after 180 s | 4 | two on 1 and 18 November, two in an agent on 17 November |

The replay used today's guard, which is stricter than the one that was installed at the time, so "refuse" means today's rules, not the rules then.

**What I take from it.**
- No skipped guard let a `.env` read, a broker call, a live-table write or a `gh pr merge` through.
- The four host reads were all asked for.
- I'm not changing the guards: they are frozen until the trial's report.

**The fix.**
- It is already on `dev`. It reaches a session once demo-1 carries #349 (the audit's next merge of dev) and that session is restarted.
- One restart then fixes this session's guards and very likely its notify hook too (below).
- Until then I keep commands short, and agents are told the same.

## Documents access

- **When.** From about 00:00 UTC, `~/Documents`, `~/Desktop` and `~/Downloads` gave "Operation not permitted" to this session and its agents.
- **What worked.** `~` and the scratchpad still worked.
- **When it came back.** Documents was readable again by 03:39Z, with no restart. Desktop is still refused, so only Documents came back.
- **What I ruled out.** The session runs under Warp. Warp's bundle is unchanged since 28 October and its code signature verifies.
- **The cause.** Not found. It fits macOS's Files and Folders privacy control. I could not read `tccd`'s log.
- **Data.** Nothing was lost: a refusal blocks access and removes nothing.
- **Meanwhile.** I ran only read-only commands, and wrote nothing until access came back.
- **Again, briefly.** #353's round-2 reviewer was refused from 15:35:29Z to 15:35:51Z on 19 November, and nothing else hit it. The cause is still unknown; a look at Warp's Files and Folders entry in System Settings would show whether the grant is being reset.
- **The window is not affected.** Saturday's session starts fresh in `../qt-window` on `dev`, so it runs #349's guards. The window sheet's step 0 now says so.
- **21 November.** No cause found, so this stays open. If it happens again, I record the times as before and write nothing until access is back. The proposal to move the project out of `~/Documents` is the last item in the queue (the section before For the planner).

## Where things are

| Item | State |
|---|---|
| #352 | READY TO MERGE at `15b974e`. Merges first, once main has moved to #342's merge commit; its rebase is predicted clean. |
| #354 (item 5) | READY TO MERGE at `0615de2`. Merges second; its rebase conflicts only in DEBT rows (above). |
| #353 (item 7) | READY TO MERGE at `2d1d526`. Merges third, after the squash, the resolved rebase and that resolution's review (above). `pull_request_target` stays, allowed for `.github/workflows/fence.yml` only (operator, 21 November). For the required check, see step 9 of the pick-up. |
| #342 (item 1) | READY TO MERGE at `c531812`, for window step 2. `dev` has not moved since 18 November. |
| Window sheet (item 8) | Pushed at `899a96e`. Its heads still hold: `dev` at `ea75c40`, #342 at `c531812`. Step 3 runs first thing on Sunday, unless it could start by 19:00 UK tonight (operator, 21 November). |
| E0 PR-A (item 6) | `test/e0-harness-gaps` at `8f70405`, pushed, not opened. Round 1 is done (20 November, below in the history). It opens after #352 merges. |
| E0 stop-and-target (item 6) | `test/e0-stop-target` at `9aff959`, local. It opens after PR-A merges, with its own review. |
| The audit's go | Given on 21 November. Its merge of `dev` is `6b834d2` in the main checkout. |

## notify.log, my turn endings

- The log's last line is 2026-11-17T12:01:57Z, a `blocked_on_you` that was sent. **Nothing has been logged since**, for any session: no push, and no "not sent".
- `271ae5b` (17 Nov 16:15Z) changed `notify-ntfy.sh` and its registration in `.claude/settings.json`. This session started on 28 October with the old registration.
- A restart is the likely fix. That is inferred and unchecked.
- **After Sunday's restart** I read the log's tail and report whether this session's turn endings are logged again.

## Proposal: an in-process Postgres under the E0 stub (five lines)

1. PGlite (`@electric-sql/pglite`, Postgres compiled to WebAssembly) runs in the test process, with no server and no Docker. It applies the real migrations, so D-47's database-side gaps go: any column on other tables, foreign keys (23503), rows missing columns, the frozen clock. PR-A's migration parser goes too.
2. It does not remove the PostgREST-side gaps. supabase-js speaks HTTP to PostgREST, and PGlite takes SQL. Upsert, a second order, count without head, `single()` over several rows, array-insert NULLs, select lists and `+00:00` timestamps still need a query-builder-to-SQL layer. That layer is what the stub is today, but emitting SQL.
3. The other route is a PostgREST binary over `@electric-sql/pglite-socket`. That is not in-process, and I found no source showing it works.
4. Unchecked: whether 00011/00012 apply on PGlite without shims for Supabase's `auth` schema, roles and extensions. Row-level security needs the same shims.
5. Cost: one dev dependency, plus an adapter about the stub's size. Recommendation: not before the stop-and-target scenario; revisit if a scenario fails on a gap from line 1.

**Agreed** (operator, 21 November): not before the stop-and-target scenario; revisit if a scenario fails on one of the database-side gaps.

## The kill-switch case under load

"does not lose an id across switch, resume, re-activate, switch, resume, switch" has a 30 s limit.

- **Under load** it has failed in every loaded `make check` since 18 November: 35.3, 38.8, 34.0, 34.2, 30.9 and 31.5 s; on 20 November 34.1 s on the stop-and-target branch and 36.5 s on E0 PR-A's `8f70405`.
- **Alone** it passes every time, in 11 to 20 s (20.0 s on 20 November, after PR-A's run). It also passed in #354's `make check`, which ran with no other heavy job.
- **No limit is raised,** per item 3. If it ever fails alone, that becomes a DEBT row.
- **After the window** (operator, 21 November): find out why it takes 11 to 20 s alone. Are there real sleeps or waits in the scripts under test? If so, make it fast with a stand-in, in one small PR, or add a DEBT row saying why not. A local check that is red every time gets ignored.

## Proposal, last in the queue: the project out of `~/Documents` (five lines, no work done)

1. **Sessions.** Claude Code keys each project's transcripts, agents and memory (131 files) by its path: `~/.claude/projects/-Users-jack-jones-Documents-trading-app-demo-1`. That folder is renamed to the new key as part of the move; otherwise every session starts with no history and no memory.
2. **Worktrees.** This repo has 11 worktrees, and git records absolute paths in both directions; `../qt-window` will be one more. `git worktree repair`, run from the moved main checkout, fixes them. `wt/tools/*` and the session scratchpads' names contain the old path.
3. **The repo.** 22 files on `dev` name the path: 14 cron scripts, which are fenced (`scripts/*-cron.sh`), 4 in `scripts/canonical/`, 3 in `scripts/archive/` and `scripts/README.md`. One PR replaces the path in place. It moves no file, so no cited line shifts, but it edits fenced and cited files, so it waits for the verdict.
4. **Outside the repo.** Read each of these once before the move: Warp's launch configuration, any absolute path in `~/.claude/settings.json` and in local settings, and the folder `caffeinate -is claude` is started from.
5. **Cost.** About an hour, with every session stopped: the move, the folder rename, `git worktree repair`, the PR and one restart. I recommend doing it after the audit's verdict, when demo-1 is free and the cited files may change. Until then, the privacy grant stays a single point of failure.

## For the planner

**Waiting on the operator:**
- The window's deploy. Main moving off `2a7d7f7` to #342's merge commit starts the queue, and each `gh pr merge` prompts you.
- Sunday's restart of this session and the audit's, once each has stopped on a turn ending.
- No open questions: all three were answered on 21 November.

**Mine, in order:**
1. When main moves: #352, then #354, then #353 (the pick-up's steps 1 to 5).
2. After #352 merges: E0 PR-A (step 6).
3. After the restart: start the poll again if it is still needed, then report on notify.log.
4. After the window: push the window log to `status/2026-11-18` and open the ledger PR. It carries item 10's rows, D-24/25/27, the `/tmp` row and the unchecked-shell-scripts row. Then the kill-switch case's time alone.
5. After Sunday 18:00 UK, with #353 on `dev`: decision 0015's policy call, the job on an open PR, the throwaway repository's test, and the record in 0015 and D-48.
6. After PR-A merges: the stop-and-target PR.
7. Next week: the sudoers PR.
8. Last in the queue: the move out of `~/Documents` (proposal above; no work).

**Deadlines:** the sudoers PR READY TO MERGE by Fri 27 Nov 20:00 UK. The fence's event policy must be in place before GitHub's change on 2 December.
