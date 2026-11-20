# Status, 2026-11-19: the guards time out, and Documents access was lost for a night

## First: guard-bash usually lets the command run when it doesn't answer in time

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
- The audit's own session very likely runs the same way. I haven't checked.

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

## Where things are

| Item | State |
|---|---|
| #354 (item 5) | Round 1 found no Critical or High, so the loop ends. Fixes pushed at `0615de2`: `make check` exit 0 (2,861 passed, 11 expected fail, 1,934 s), CI green, CLEAN. **READY TO MERGE.** Fixed: M1, the hook places a path with `hook-input.cjs relpath` as guard-paths does; M2, the DEV_SETUP hooks row; L4, a 60 s test timeout; L5, "as CI does, not as lint-staged". L3 (test 5 vacuous on Linux) is folded into M1's tests: a symlinked root both ways, a worktree copy, `Review/` on macOS, links out of and into `review/`. Three of them fail on the previous hook. L7 is DEBT D-49. L6, the title and the body, follow the push. |
| #353 (item 7) | Round 1's fixes pushed at `b40f90b`; CI green. Its `make check` failed only the kill-switch test, at 30,879 ms in the suite against 11,331 ms alone, so no limit change. Round 2 (diff since `77538b7`) found no Critical, High or Medium, so the loop ends. Eight Lows: seven are fixed in one commit, and one (tests for the new fail-closed branches) goes into D-48. The pinned `actions/checkout` commit is v4's tag commit on actions/checkout. The Lows are fixed at `2d1d526` (CI green, CLEAN), and the untested branches are D-48 (6). `make check` failed only the kill-switch test: 31,490 ms in the suite against 20,333 ms alone, so no limit change. **READY TO MERGE at `2d1d526`.** Item 7's done-when: the tests show a diff touching `src/lib/scan` fails and one touching only `tests/` and `docs/` passes; on live data the job fails #291 (eight fenced paths) and passes #352. The required check in protect-dev is held for questions 1 and 2. |
| #352 | READY TO MERGE at `15b974e`. The audit's go, #342's rebase and E0 PR-A wait on it. |
| #342 (item 1) | READY TO MERGE at `c531812` until #352 merges; then a rebase. Due Fri 20 Nov 20:00 UK. |
| Window sheet (item 8) | Pushed at `899a96e`. It names dev at `ea75c40` and #342 at `c531812`; to update when they move. |

## notify.log, my turn endings

- The log's last line is 2026-11-17T12:01:57Z, a `blocked_on_you` that was sent. **Nothing has been logged since**, for any session: no push, and no "not sent".
- `271ae5b` (17 Nov 16:15Z) changed `notify-ntfy.sh` and its registration in `.claude/settings.json`. This session started on 28 October with the old registration.
- A restart is the likely fix. That is inferred and unchecked.
- Reported before the audit's go, which still waits on #352.

## Proposal: an in-process Postgres under the E0 stub (five lines)

1. PGlite (`@electric-sql/pglite`, Postgres compiled to WebAssembly) runs in the test process, with no server and no Docker. It applies the real migrations, so D-47's database-side gaps go: any column on other tables, foreign keys (23503), rows missing columns, the frozen clock. PR-A's migration parser goes too.
2. It does not remove the PostgREST-side gaps. supabase-js speaks HTTP to PostgREST, and PGlite takes SQL. Upsert, a second order, count without head, `single()` over several rows, array-insert NULLs, select lists and `+00:00` timestamps still need a query-builder-to-SQL layer. That layer is what the stub is today, but emitting SQL.
3. The other route is a PostgREST binary over `@electric-sql/pglite-socket`. That is not in-process, and I found no source showing it works.
4. Unchecked: whether 00011/00012 apply on PGlite without shims for Supabase's `auth` schema, roles and extensions. Row-level security needs the same shims.
5. Cost: one dev dependency, plus an adapter about the stub's size. Recommendation: not before the stop-and-target scenario; revisit if a scenario fails on a gap from line 1.

## The kill-switch case under load

"does not lose an id across switch, resume, re-activate, switch, resume, switch" has a 30 s limit.

- **Under load** it has failed in every loaded `make check` since 18 November: 35.3, 38.8, 34.0, 34.2, 30.9 and 31.5 s.
- **Alone** it passes every time, in 11 to 20 s. It also passed in #354's `make check`, which ran with no other heavy job.
- **No limit is raised,** per item 3. If it ever fails alone, that becomes a DEBT row.

## For the planner

**Waiting on the operator:**
- #352's merge, which starts the audit's go, #342's rebase and E0 PR-A;
- then, after the audit's merge of dev, one restart of this session and the audit's, for the guards (#349) and notify;
- questions 1 and 2, as before.

**Mine, in order:**
1. #354: done, READY TO MERGE at `0615de2`.
2. #353: done, READY TO MERGE at `2d1d526`; the ruleset change waits for the merge and questions 1 and 2.
3. After #352 merges: #342's rebase and E0 PR-A.
4. The window sheet's heads.

**Deadline:** #342 READY TO MERGE at its new head by Fri 20 Nov 20:00 UK. It needs #352 merged by about Friday midday to leave time for CI.
