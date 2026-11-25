# The sandbox trial, 17–24 November 2026: report

Written 25 November 2026 by the session that ran the trial, for the operator. It follows the spike's report, `docs/spikes/sandbox-2026-11.md` on branch `spike/sandbox` (`cb0472d`). The day notes and raw outputs are in the operator's private repository, under `trial/`, because the corpus is a how-to for getting past the guard. This file holds no command from it.

## Short answer

- **Two of the seven planned days ran:** day one (17 November) and day two (18 November). Nothing ran after 18 November 19:20 UTC.
- **What they show:** a Claude Code sandbox set from committed settings works in this repository. `make check`, `make backtest`, an empty commit and a push of a commit GitHub already held run inside it, at 2.7% more time in pair 2 of `make check` and 7.5% in pair 1. That is one pair that counts, and even there the one-minute load averaged 4.76 inside and 3.78 outside. `pnpm install`, `pnpm build` and `gh` do not run inside it, and need to be excluded. (Commands that reach the host were not tried here; the spike found that plain ssh has no route.)
- **What they do not show:** what an interactive session is like under it, what it does to file-tool edits, whether the corpus still fails under committed settings, and what each guard rule would still be needed for. Those were days three to six.
- **So this report recommends nothing on committed settings, and nothing on retiring rules 1, 7 or 8.** The runs that are missing are named below (M1 to M6).
- **It does recommend:** the guard stays frozen meanwhile; #336 closes, as you decided on 17 November; the reviewer hook gets the same timeout fix the two guards got.

## The terms

- **Set by you,** 17 November 19:29 UTC: "Sandbox: yes, a one-week trial, in your own worktree sessions only, starting now. Day one is the second round: make check, make backtest, pnpm build and a gh pr flow inside it, and whether excludedCommands and ./ paths hold from committed-tier settings. The window session stays unsandboxed. The main checkout stays unsandboxed until the audit's verdict. Report in docs/spikes at the end of the week with the recommendation on committed settings, the guard freeze and rules 1, 1d, 7 and 8." And: "Hold #336, close it when the trial ends."
- **Day two,** 18 November 15:55 UTC: `make check` inside the sandbox and then outside it, "same day, same conditions", both failure lists side by side, and the result of a `git push` from inside. Also: "No change to the guards or the reviewer allowlist before" this report.
- **The question behind it,** 12 November 23:53 UTC (item C): show that the everyday commands work inside and "every bypass in the #333 check and the #336 reviews fails at the OS level", then recommend "freeze the guard at the fence plus onFailure block, and what happens to #336, rules 1, 1d, 7 and 8, and decision 0012".
- **The plan for the week** was the trial's own, from the trial agent's hand-back to this session (17 November 22:23:20 UTC; the `Plan` column below). Two entries have another source: the `make status` call "only if you ask" and the four shared-`.git` rows are in that hand-back; day three's new commits are from day two's note. End: 24 November.

## What ran, and what did not

The sandboxed runs: a headless `claude -p` 2.1.308 in the trial worktree (`trial/sandbox-committed`, never pushed), committed settings only (`--setting-sources project`), `dontAsk` mode, one allowed Bash form per call. Not all of it: the outside `make check` runs used the session's own shell, and one `pnpm install` ran outside (77 s).

| Day | Plan | Ran? |
|---|---|---|
| 1 · 17 Nov | The second round (the terms above) | **Yes**, 20:35–22:15 UTC. `trial/2026-11-18-day1.md`, `f7bfdc1` |
| 2 · 18 Nov | `make check` with day one's fixes, inside and outside; a push from inside | **Yes**, 16:11–19:20 UTC, two pairs. `trial/2026-11-18-day2.md`, `b5f5034` |
| 3 · 19 Nov | A small real PR in an interactive sandboxed session, counting prompts and refusals; new commits pushed, git's output and exit status kept | **No** (M1) |
| 4 · 20 Nov | Edit-tool writes against the denied paths; only if you ask, one `make status` as an excluded call | **No** (M2) |
| 5 · 21 Nov | The 189-row corpus from committed settings, plus the four rows that write the shared `.git` | **No** (M3) |
| 6 · 22 Nov | Guard rules 1, 1d, 7 and 8 mapped against what the sandbox stops | **No** (M4) |
| 7 · 23 Nov | This report | Late, 25 November |

The dates in the first column are the plan's day numbers counted from 17 November; only days one and two were ever given a date.

**Why the rest did not run.** I did not arrange them.
- The only reason on record is from 20 November 01:35 UTC: day three "needs an interactive sandboxed session and a quiet machine". The queue's work and its heavy runs went first from 18 to 21 November.
- On 19 November, from about 00:00 to 03:39 UTC, `~/Documents` was refused to the session.
- From 22 November 19:54 UTC the chat waited on a permission prompt that had no answer. Its background poll was stopped on 23 November 17:01 UTC, and the work was picked up on 25 November.

**How I know nothing else ran:** the last trial session's transcript, the last file in the trial worktree's `.trial-out/` and the private repository's last commit are all from 18 November, 19:20 to 19:23 UTC. The trial branch's last commit is from 18 November 16:09 UTC.

## What the two days showed

| Thing tried, from committed settings | Result |
|---|---|
| The sandbox on | Yes (`SANDBOX_RUNTIME=1`) |
| `./` paths in `denyRead` and `denyWrite` | Hold: a `./` probe file, `./.gitignore`, `./.husky` and a `./` read were all refused. (They did not hold from `--settings` in the spike.) |
| `~/` and absolute paths; write grants for the pnpm store and cache | Hold |
| Network | `example.com` refused, `api.github.com` reached |
| `excludedCommands` | Honoured, **per Bash call**: `gh` works as its own call, and not when a sandboxed script runs it |
| A `gh pr` flow on the private repository, each `gh` call excluded | Works (branch, commit, PR opened, viewed, closed) |
| A commit | An **empty** commit works, 14 s (`20e8a6a`): the hooks ran with nothing to scan. A commit with changes was not tried |
| `git push` to GitHub | One push works: day two pair 2 pushed a probe branch at `ea75c40`, which GitHub already held, so no new content. The branch appeared and CI started; git's own output and exit status were lost to my scripting error. Pair 1's push never left the machine: its output and exit status are recorded (a refspec error, exit 1). The credential came from the macOS keychain through git's helper |
| `make backtest` | Fails on tsx's IPC socket (that run used Node v25.3.0, not the pinned 26.13.0; the passing run's version is not recorded); with `network.allowUnixSockets` for its folder it passes, golden MATCH, 8 s |
| `make check`, day one | 61.6 min at load 12 to 6; 27 of 2,829 tests failed, by the raw list: 17 guard tests and 4 ops tests (timing, the day's note), 4 pre-registration tests (tsx's socket), 1 quarterly-cycle test (a fixed `/tmp` path) and 1 notify test (a temp-folder cleanup). The day's note gives 21, 5, 1 and 2, which sums to 29 |
| `make check`, day two, pair 1 | Inside 1,906 s, 3 failed, exit 2. Outside 1,773 s, 0 failed, exit 0. The three are guard tests cut off at #344's 10 s test bound. My own install, and a background agent's first install, overlapped the inside run |
| `make check`, day two, pair 2 | Inside 1,955 s, outside 1,903 s (+2.7%). 0 failed on both, 2,818 passed, 11 expected fail |
| `pnpm install --frozen-lockfile` | Fails inside: a dependency ships a `.gitmodules`, a name the sandbox never lets a command write. It has to be excluded, and then the repository's own `ask` rule prompts, so a headless session can never run it |
| `pnpm build` | Fails inside (Turbopack's font fetch ignores the sandbox's proxy). Works as an excluded call |

The spike of 17 November had already shown, with settings from the command line: of the corpus's 189 rows, 165 ran and none did harm; plain ssh and git over ssh had no route; hooks run outside the sandbox.

**Limits that came with it.** The commit tested was `dev` at `809ea17` plus the trial's own, so before #349. The committed-tier read probe was a probe file, not a `.env` file, and `.env.example` read normally. No ssh was tried from the committed tier.

## Learnt since, and bearing on it

- **The guard often gave no verdict.** Up to 19 November 14:14 UTC, the old chat's transcripts recorded 911 guard runs that gave no verdict over 16,694 Bash calls: 893 timeouts at 10 s and 18 that could not start. By 21 November it was 976 over 17,096, 949 of them timeouts; the 77 after 19 November 03:45 UTC have not been replayed. The status file says Claude Code ran every one of the 911 (not checked again here). The audit session had 9 over 1,483, all timeouts.
- **#349 fixed it on `dev`** (18 November): 60 s and `"onFailure": "block"` for both guard hooks. It binds a session only once its checkout carries it and the session is restarted. The trial predates it, so no run here tests it.
- **The replay.** Today's guard was run on the 899 recorded up to 03:45 UTC:
  - 678 allowed;
  - 165 refused for a shell construct (a substitution or variable as a command word, a heredoc, a pre-approved tool over several lines);
  - 46 refused for text about secrets, hosts, the broker or deletion (file writes whose text names those words; the status note says none ran one, and one wrote and ran a host script: below);
  - 2 refused for a `.env` name (an agent grepping a test log; no `.env` file was read);
  - 4 refused as host commands (the four reads below);
  - 4 gave no answer after 180 s.
- **What that means here, and a correction to my 19 November status note.** 899 of the 976 were replayed (the last is 03:43:06 UTC on 19 November; 4 more fell before 03:45 and 73 after), and 4 of the 899 gave no answer, so 81 have no verdict (those 4, and the 77 not replayed). Today's guard has no rule for `gh pr merge` or for live-table writes, so "allowed" says nothing about either. On 25 November I searched the text of all 976 commands, read-only, for a program in command position, and the transcripts for what approved the ones that mattered. The scripts (`wt/tools/guard-replay/`) are in an untracked local folder, and stay there; nothing of them is in this repository.
  - **Two merges, prompted for and accepted once.** #343 and #345 on 17 November. The guard timed out on each call (16:32:08 and 20:13:18 UTC). Each then met a permission prompt, which you accepted once (recorded 16:39:17 and 20:33:56: decision accept, source `user_temporary`, scope once, from a local-settings rule), and merged at 16:39:13 (`3a2b458`) and 20:33:46 (`809ea17`). You had ordered both queues that day (16:10 and 19:29 UTC). So the skipped guard did not let them through: the permission rule stopped each, and you approved it. The guard was never the check on merges. #308, on 30 October: the guard timed out and the auto-mode classifier denied the merge (no prompt). It merged on 31 October after you approved it.
  - **One host change, with neither guard nor prompt.** D.4's host steps 3 to 5, 1 November: the guard was cancelled at 16:07:25 UTC and the result came back at 16:07:33, accepted (source `config`, no prompt recorded), which D-37 reads as the auto-mode classifier. It installs a unit and a crontab on the host. Your order of 13:32 UTC that day: "D.4: build and review the logrotate and alert changes in parallel; deploy them today only if D.3's test is done and there's time before 18:00, otherwise next weekend" (D.3's test: `docs/decisions/deploys.md:18`; the apply: `:19`).
  - **Five host reads, with neither guard nor prompt,** recorded the same way: 6 November 19:00 and 19:01 UTC, 10 November 19:57 and 19:58 (the four the replay refuses), and 7 November 15:34 (cancelled 15:34:38, result 15:36:33), which today's guard allows. The first two came after "Keep tracing D-31 read-only" (6 November 18:46 UTC), and the 10 November pair after "Host state now" (19:50 UTC). **The 7 November read: I found no order for it.** The nearest words are "Put that in the D-31 write-up" (7 November 11:03 UTC), which asks for no read. My status note's "the four host reads were all asked for" is therefore incomplete: five skipped reads and one skipped change, one read with no order found.
  - **This is the gap D-37 records:** a host command approved by the classifier and not at a prompt. With the guard silent, no other check stood in front of the classifier. `dev` closes it with #333's ask rules and #349's block, in a session whose checkout has both and has been restarted.
  - **What of the status note's sentence still stands,** as far as a search of command text goes: no `.env` read, no live-table write and no `psql` or Supabase CLI command ran. The search for a read of a secrets file gave three matches: one `grep` inside a script being written, and two over a test log whose lines name such a test. Nine runs name the broker, in text (I read eight). The live-target, `make deploy` and database patterns ran over all 976; the matches I read were text being written into files. `--env-file`, `set -a` and `dotenv` gave no match. **Not re-searched:** what a script file does when run, MCP calls, a program behind a wrapper or with an option before its name, and a `gh pr merge` whose number is not directly after it. The 217 refused still rest on `replay_classify.py`, which dropped heredoc bodies; that is how it missed the D.4 run, which wrote a script and ran it.
- **The guard refuses ordinary work:** the 165 and the 46 are mostly that. The replay's guard is stricter than the one in force then, so "refuse" means today's rules.
- **The slow part is the guard's cost per line,** not its rules: about 0.5 to 0.7 s a heredoc line under load in the spike. The sandbox does not change that.

## Recommendations

**1. Committed sandbox settings: no recommendation.** Two of seven days is too few. What the two days suggest is the shape a settings block would take, if it were adopted (`committed-sandbox-block.json`, day one's raw files):
- `enabled`, `failIfUnavailable: true`, `allowUnsandboxedCommands: false`;
- excluded calls: `gh`, `pnpm install --frozen-lockfile`, `pnpm build` and the host make targets;
- tsx's socket folder in `network.allowUnixSockets` (it carries the user's id, and it weakens isolation), the one test's `/tmp` folder in `allowWrite`, the pnpm store and cache in `allowWrite`;
- `denyRead` for `.env*`, `./**/.env*`, the main checkout's `.env*`, the shell histories, `~/.config/gh` and `~/.config/quanttrader`, with `allowRead` for `.env.example` (without it, `make check` would fail at `env-check`, which reads that file; inferred);
- `denyWrite` for `.husky`, `.gitignore`, the pinned corpora and `tests/golden`;
- `allowedDomains`: the eight in the trial's block (GitHub, npm, Google Fonts);
- the `credentials` block (`~/.ssh` and `.env.local`).

Of these, what the trial ran: `./` and `~/` paths, the pnpm grants, the tsx socket, the `/tmp` grant, the exclusions of `gh` and `pnpm build`, and the network. Never probed: the pinned data, `tests/golden` and `~/.config/quanttrader` entries, the `credentials` block, the `.env*` denies themselves, the shell histories and the main checkout's entry.

Missing: **M1** (interactive use; the real cost in prompts), **M2** (file-tool edits), **M3** (does the corpus still fail), **M5** (`make check` at the `dev` of the day), **M6** (the commands that read `.env.local`). Until then the sandbox stays off, and the main checkout stays unsandboxed until the verdict, as you said.

**2. The guard freeze: keep it.** No new text rule and no removal. The half of your item C that says "onFailure block" is done (#349). The half that says "at the fence", which would drop rules 1, 7 and 8, has no recommendation: nothing that would support it was run (**M3**, **M4**). Not adding rules does not rest on the trial: reviews of #333 (D-37) and of #336 (decision 0013, line 41) each found a new way past the text rules.

**3. Rule 1 (`.env*` reads and writes): no recommendation to change it; it stays.** A sandboxed command that reads a path in `denyRead` is refused, and the spike showed that for the canary. But `pnpm build` and any other excluded call run outside the sandbox with full access, and `make db-types` reads `.env.local` (M6). Claude's own file tools are held by the permission denies, not the sandbox. Missing: **M3**, **M4**, **M6**.

**4. Rule 1d (#336): not on `dev`, and not recommended onto it** (see 7). Its subject is pre-approved git commands that can print an ignored file. The sandbox denies those reads at the OS level for what `denyRead` names, shown by the spike and not from committed settings. Missing: **M3**, **M4**.

**5. Rule 7 (pre-approved commands turned into writes or code): no recommendation to change it; it stays.** The sandbox stops writes outside the project and to the denied paths. It does not stop a write elsewhere in the project, or code a pre-approved command loads from a file. The half that guards host targets would still stand behind the exclusions, with the `ask` rules, the Makefile (it refuses a host goal beside another goal) and the no-arguments allow rules (four layers, DEV_SETUP §18). The exclusion list holds each host target twice, bare and with a trailing ` *`, so a word after the target (`make status x`) also matches and runs outside the sandbox. A flag before the target would not match (inferred). Chained forms were never tried: day one tested `gh` only. Missing: **M3**, **M4**.

**6. Rule 8 (raw host commands): no recommendation to change it; it stays.** It reads the text of raw ssh, scp, sftp and rsync; the host make targets are rule 7's. From a sandboxed command those have no route (the spike), and the exclusion list holds no raw remote shell. So the one form rule 8 permits, bare to the `qt` alias, would have no route in a sandboxed session, and a session that needs it would have to run outside the sandbox. D-37 keeps four High ways past rule 8 open "until the sandbox (D-22) stops them at the OS level"; they stay open until it does, against D-22's and E13's target of 2026-12-31. The corpus row for each of the four is M3's. Missing: **M2** (the `make status` call), **M3**.

**7. #336: close it, as you decided on 17 November, and keep its branch.** It held for a reason the trial did not deliver: that the sandbox would do at the OS level what its text rule tries to. That is shown in the spike and not under committed settings. It should close anyway. It took six review rounds (decision 0013, the "review loop" paragraph), which kept finding new ways past it, against today's cap of three, and it conflicts with `dev` in `docs/DEBT.md` and `docs/DEV_SETUP.md` (a `git merge-tree` run on 25 November; 14 commits behind `ea75c40`, 16 behind `e0480d1`). What closing leaves open, and what D-22 still says: pre-approved git commands can print an ignored file. D-22 calls that "Open, the next PR"; that wording should change to say it has no text fix and waits for the sandbox, with the target it already gives (2026-12-31).

**8. The reviewer hook and its allowlist (they wait for the trial's report).** The trial says nothing about either.
- The hook has a 10 s timeout and no `onFailure`, and a timed-out PreToolUse hook lets the call through. I recommend the same 60 s and block, in one small PR. It also changes `hooks.test.ts`, which gives that hook 10 s. Whether `onFailure` in an agent's frontmatter behaves as it does in `settings.json` was never tested, so the PR needs its own live check.
- The allowlist's open item (D-22) is that it lists flags to refuse instead of flags known to be safe. The two commands you raised, `git range-diff` and `git -C`, belong with that change.

## The runs that are missing

- **M1 (day three).** A small real PR in an interactive sandboxed session, counting prompts and refusals; pushes new commits with git's output and exit status kept. Informs: committed settings.
- **M2 (day four).** Edit-tool writes against the denied paths; and, only if you ask, one `make status` as an excluded call, to confirm it still prompts. Informs: committed settings, rule 8.
- **M3 (day five).** The corpus from committed settings: the 165 rows the spike ran, or 169 with the four shared-`.git` rows in a separate clone with its own `.git`. Of the 189, 20 are marked NOT RUN in `dry-run.txt` (no concrete command in the review, the deploy driver, two host targets, a GitHub post and an Edit-tool write) and stay out. The runner stops without a canary `.env.local`, the worktree holds none and no session may write `.env*`, so **you write the canary** before M3 can run. Informs: committed settings, rules 1, 1d, 7 and 8. Headless after that.
- **M4 (day six).** Each rule mapped against what the sandbox stops, from M3's results and the settings. Informs: the freeze, rules 1, 1d, 7 and 8. Desk work, no run.
- **M5 (never planned; day two's own note).** `make check` at today's `dev` (`e0480d1` when this was written), with #349's 60 s, inside and outside.
- **M6 (never planned; E13 names both).** `make db-types` and `pnpm build` inside, in a worktree that holds a canary `.env.local` you write, never a real one (the trial's worktree holds none). Day one ran `pnpm build` inside (it failed on the fonts) and as an excluded call (it worked), never with a `.env.local` present. `db-types` reads `.env.local` (Makefile) and needs Supabase, which is not among the allowed domains; the settings deny the file and do not exclude the target, so it is expected to fail. It is also an `ask` rule. Informs: committed settings, rule 1. `pnpm dev` is not in it: it resumes scans and paper trading for every active algorithm.

M5 can run headless, and M4 needs no run. M3 can run headless once you have written the canary file, and the four `.git` rows need their own clone. M6 needs the same file and prompts you for `make db-types`. M1 and part of M2 need an interactive session.

## What I did not check

- Whether #349's `onFailure: block` covers a guard that cannot start, as against one that times out. DEV_SETUP (line 276) states that it does; only the timeout case has been seen live.
- The guard's runtime and behaviour inside the trial sessions. Each ran one allowed Bash form, so the guard was rarely asked anything.
- Why each of day one's 27 tests failed. I re-counted the list for this report; the causes are the day's note's, and two of its counts do not match the list: 5 for tsx's socket should be 4, and 2 for the notify cleanup should be 1.
- Any of the host targets as excluded calls. None has ever been run in a sandboxed session.
- Which rows of the corpus would behave differently under committed settings. That is M3.
- Any version of Claude Code other than 2.1.308, and any system but macOS.
- Whether a session in the main checkout would be affected. The trial never touched it.

## For the operator

1. **The missing runs:** stop here, or allow M1 to M6 once, without a new week? Recommended: allow them, after the next window. M5 runs headless in the trial worktree, and M3 headless there plus a clone for the four `.git` rows. For M3 and M6 you write a canary `.env.local` in the trial worktree first. M6's `db-types` prompts you. M1 needs you at the keyboard.
2. **#336:** close it now, keep the branch? Recommended: yes.
3. **The guard:** stay frozen until M3 and M4 are reported? Recommended: yes.
4. **The reviewer hook's 60 s and `onFailure: block`:** one small PR? Recommended: yes.
5. **The sandbox in committed settings:** leave it off until then? Recommended: yes.
