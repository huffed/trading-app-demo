# Kill switch — stop all trading activity on the VPS, and how to come back

`make kill-switch` is the one host command allowed in market hours (the one other exception: appending the `HEARTBEAT_PING_URL` line, `docs/runbooks/d4-alerts-and-rotation.md`). It is idempotent and fails closed: whatever is unreachable, the service ends up stopped and the crons gone. Everything it does is one line in `/var/log/quanttrader/deploys.log` and an urgent ntfy push. `make kill-switch`, `make resume` and `make unpause` are the only way a Claude session writes to the live tables (CLAUDE.md, decision 0010): each prompts every time, is never pre-approved (`ask` rules in `.claude/settings.json`; no pre-approved make rule takes arguments, so every make command with arguments prompts whatever its spelling — the one real backstop; the Makefile and `guard-bash` also refuse a host goal beside another goal, behind a flag or behind an override, and `guard-bash` refuses the `--eval`, `-f`, `MAKEFILES=`, `MAKEFLAGS=` and stdin-makefile spellings it can see through; `tests/ops/makefile-host-targets.test.ts` checks), runs only when the operator asks for it, and writes its ledger line — the row in `docs/decisions/deploys.md` is copied from it in the next PR, and CLAUDE.md's "ledger row" means that pair. A failed append to `deploys.log` counts as an error in all three, and an un-pause whose PATCH failed writes `UNPAUSE result=unknown`, because it may have committed.

## What it does, in order (`scripts/ops/kill-switch.sh`, run on the host as `ops`)

Every step is attempted even after an earlier one failed, and the schedulers go first so nothing waits on the database or the app before new ticks are impossible. Before step 1 the run marks the engagement with an empty `/var/lib/quanttrader/kill-switch.engaged`, which needs no data blocks and so is written even on a full disk; only `make unpause` removes it, and `make resume` reads it (below).

1. **Disable the crontab**: saved to `/var/lib/quanttrader/crontab.disabled`, then removed. No new scan or manage tick can start. The copy is written beside the old one and moved over it, so a full disk never truncates an earlier copy. The crontab is removed even when the copy cannot be written (`crons=disabled-unsaved`, error `save-crontab`); the run then says whether `make resume` would restore an older copy (if it differs from `ops/crontab`, replace the saved copy with `ops/crontab` before resuming, never install the live crontab) or none (run `make resume`, and install `ops/crontab` as under "Rollback" below only once it reports `no-saved-crontab`, so its active-algorithm check runs first). With no copy at all, `make deploy` does not see the stop (it looks for the saved copy), so do not deploy until resume has run.
2. **Pause** every `status='active'` algorithm through Supabase's REST API with the service role read from the host's `.env.local` (`status='paused'`); the ids are saved to `/var/lib/quanttrader/kill-switch.paused-ids` for `make unpause`, and merged with a previous run's while the crontab is still empty.
3. **Flatten** the open positions of those algorithms, and of every id this engagement has targeted (`kill-switch.flatten-ids`, kept until `make unpause`), through the app's own route `POST /api/admin/flatten-algo?id=…` on loopback with `CRON_SECRET` read on the host: the paper rows (`exit_reason` `manual`) **and the broker side of any position that carries a `broker_position_id`**, which the route closes through the adapter. A broker position that did not close is an error even though the route answers 200 and the paper row closes anyway: `broker-failed:` in the route's response, or `paper-only` on a row with a broker id, where no connection or adapter was found so the close was never attempted. So is a flatten whose answer was lost after the route may have run (a timeout, a dropped reply, a 5xx or an unreadable 200; not a refused connection or a 4xx, which never reached it): the paper rows may have closed with a broker close that failed, so the id goes on the failed-broker list as unknown. Both stay errors on later runs until `make unpause`: `broker-failed-earlier:N` counts the broker positions not closed, `broker-unknown-earlier:M` the algorithms whose answer was lost, and the line names their ids. Once the app stops answering (connection refused or a 60 s timeout) the remaining ids are skipped rather than waited on.
4. **Stop and disable the service** (`systemctl disable --now quanttrader`): a reboot does not bring trading back.
5. **Count every open position**: those on the targeted algorithms (`open_after=`) and those on any other (`open_untargeted=`, for example an algorithm alpha-decay paused, whose position nothing manages; the run prints those algorithms' ids). Either is an error (`open-after:N`, `open-untargeted:N`). Read the targets' mirroring state (`mirroring=<on>/<total>`, `live_trading_enabled`, a record and not a safeguard, decision 0010); send the urgent ntfy push (`NTFY_TOPIC` from `.env.local`) and write a `KILL …` ledger line with `crons=`, `paused=`, `flattened=`, `service=`, `open_after=`, `open_untargeted=`, `mirroring=`, `alert=` and `errors=` — each field says what actually happened (`FAILED`, `SKIPPED`, `N (M failed, K broker-failed, rest skipped)`, and `paused=unknown` when the PATCH failed and may have committed), never a literal success. If the ledger append fails, a second push says so, because that push is then the only record.

If the database or the app is unreachable, steps 2, 3 and 5 report failures and steps 1 and 4 still run. The run ignores a dropped ssh session (HUP, INT, PIPE) and also logs to `/var/log/quanttrader/kill-switch.log`, so it finishes once started. Secrets go to curl through stdin headers and are never printed. The exit status is non-zero when any step failed (`KILL_RESULT=PARTIAL`). Running it twice is harmless: an already-empty crontab keeps the saved copy, a stopped service stays stopped, nothing active means nothing to pause, and the flatten is skipped (`flattened=SKIPPED`) while `open_after` still counts what is open. The recovery for `open_after>0` is `make resume`, then the switch again: every id the engagement targeted is flattened whatever the crontab says (DEBT D-27). For `open_untargeted>0` the switch has no id: `make resume`, then close them through the flatten route for that algorithm. Both count paper rows only: a broker position that did not close shows `open_after=0` with `broker-failed:…` in `errors=`, and because the paper row has closed a re-run cannot retry it, so close that position at the broker (D-25, whose engine half waits for the audit verdict); later runs report `broker-failed-earlier:N` and `broker-unknown-earlier:M` until `make unpause`. The un-pause list is replaced when a run with something active starts while the crontab is back, so an algorithm from the earlier engagement is not woken by `make unpause` and stays paused until you activate it. `make unpause` ends the engagement and clears all three lists, saying first what the failed-broker list held.

```bash
make kill-switch REASON=<one-word-reason>      # e.g. REASON=broker-fills-wrong, REASON=paper-test
make logs LOG=deploys N=3                       # the KILL line
make status                                     # service inactive, crontab 0 entries
```

The script is streamed from the workstation's **local** copy of `origin/dev` over one ssh connection, so it works while GitHub is unreachable; `make kill-switch` refuses if that copy does not hold the script (`git fetch origin` after the PR that added it) and prints the commit it streams. If the workstation is gone too, on the host (once a deploy has put the script in the checkout): `sudo -u ops bash /opt/quanttrader/scripts/ops/kill-switch.sh <reason>` — the script refuses to run as any other user, because the crontab it must disable is `ops`'s.

Transport: the target opens or reuses one multiplexed ssh connection (`~/.ssh/qt-make-%C`, shared with `make status`, `logs`, `resume` and `unpause`, kept 60 s after the last command; a dead connection is declared within 30 s). If it stalls or exits 255 with a `mux_client` error, the socket is stale (the workstation slept while the master was alive; detection takes about 30–45 s): `ssh -O exit -o ControlPath=~/.ssh/qt-make-%C qt` ends the stale master at once (or delete `~/.ssh/qt-make-*`), then run the switch again — it is idempotent. `Connection refused` from ssh is the host's `ufw limit 22/tcp` (six connections from one address in 30 s): wait 30 s and run it again.

## Resume (`make resume`)

Once mirroring is on, this counts as acting on the broker account (decision 0010): it brings back the service and the crons the engine trades through, and together with `make unpause` it lets the engine trade again. What the switch paused stays paused until `make unpause`. It prompts, prints the mirroring state of the saved algorithms and writes it on its ledger line.

Reverses the stop only: enables and starts the service, waits for `/login` 200, then **checks that no algorithm is active**, and restores the crontab from the saved copy only if so. If the switch failed to pause (database outage), the crontab stays off, the line says `algorithms-active:N`, and the answer is to run the switch again.

If the service was already running before the resume, with the crontab on and no engagement open (no engagement marker, no saved id list and no flatten list, as after `make unpause`, or when no switch ran), there is nothing to resume: active algorithms are normal, it says so, checks the ticks and ends `OK`. Otherwise, with the crontab already on, the line says `algorithms-active:N`, and the push comes at once and says they are active, not paused, and how the service and the engagement stood. **That is not by itself a reason to run the switch.** Run the switch only if it ran before and failed, because it flattens every active algorithm. If the check itself failed with the crontab on, the line says so, and any active algorithm trades as soon as the database answers.

It then waits for the next manage, heartbeat and scan ticks to log `http=200` (up to 25 minutes; skipped when the service or the crons did not come back, or when algorithms are active or not checked), pushes (high priority when anything failed) and writes a `RESUME …` ledger line, which also records the service's state before the resume (`before=`) and whether an engagement was open (`engaged=`). When a switch could not save its crontab copy since the last one it saved (it leaves an empty `crontab.unsaved` beside the copy, which `make unpause` removes), the copy restored is older, and the line says `older-crontab`: compare `crontab -l` with `ops/crontab`. **What the switch paused stays paused** until the operator un-pauses. Exit status is non-zero when any step failed.

## Un-pause (`make unpause`) — the operator's deliberate act

Once mirroring is on, this counts as acting on the broker account (decision 0010): together with `make resume` it lets the engine trade again, and the next scan of the re-activated algorithms mirrors entries. It prompts, prints the mirroring state and writes it on its ledger line.

Re-activates exactly the algorithms the kill switch paused (the saved id list), never every paused algorithm (the library holds algorithms that were paused on purpose months ago). Refuses while the service is not active (resume first). Writes an `UNPAUSE algorithms=N of M saved left_paused=K broker_failed_cleared=X broker_unknown_cleared=Y mirroring=<on>/<total>` ledger line and then ends the engagement: the marker and the three lists go. If the ledger line cannot be written, the failed-broker list stays, because it is then the only record of what it held. The ledger line carries the list's short ids (`broker_ids=`), since `kill-switch.log` is rotated and the ledger is not; with nothing to un-pause it still says how many of the engagement's targets stay paused (`left_paused=`). `algorithms=` counts the rows actually changed. `left_paused=` counts the algorithms this engagement also targeted that stay paused: an earlier engagement paused them and a fresh one did not save them, so un-pause does not wake them; it names them, and you activate them in the app if they should trade. `broker_failed_cleared=` and `broker_unknown_cleared=` say what the failed-broker list held; it names those ids and says to check the broker account, because no later run will remind you. With no id list to un-pause it still ends the engagement, says what the broker list held and, when it removed a list, writes `UNPAUSE result=nothing cleared=<lists> …`. If the PATCH fails it writes `UNPAUSE result=unknown`, keeps the list and exits non-zero: it may have committed (a timeout after the commit), so check the database before running it again. Run it only after `make resume` reported OK and you have decided trading should restart; the next scan tick then scans them (`make logs LOG=scan N=1` shows `"scanned":N`). After a stop longer than 90 minutes the first heartbeat after un-pause reports stale algorithms until that scan.

## The dead-man alarm, and deploys

A kill switch left engaged should trip healthchecks.io about 20 minutes after the last heartbeat ping (the crontab is gone), and later the GitHub dead-man workflow, whose checks fail once manage is 45 minutes stale and scan 35. Those are thresholds, not detection times: GitHub starts that job 2 to 5 times a day, so it may be hours later (DEBT D-30). Both are correct: the stop is real. A paper test that resumes within minutes trips neither. `make deploy` refuses while the switch is engaged (saved crontab present and the live crontab empty), at its start and again before its restart, so a deploy cannot undo a stop. Two exceptions, where that check sees no stop and a deploy would restart the service: a switch that removed the crontab but could save no copy and found none (`crons=disabled-unsaved`), where no crons means no ticks; and a switch that could not remove the crontab (`crons=FAILED`), where the crons are still on and the engine would trade. In either case do not deploy until resume has run (DEBT D-35).

## Paper test checklist (D.3; done in a window the operator confirms, outside market hours)

Expect no open positions; the point is the sequence.

1. `git fetch origin` (the local `origin/dev` must hold the scripts); `make status` → service active, 12 cron entries (11 before D.6, 10 in the 2026-11-01 test, before D.4's ops-health line), ticks 200.
2. `make kill-switch REASON=paper-test` → output ends `KILL_RESULT=OK`, `KILL_ERRORS=none`; the line reads `crons=disabled paused=5 flattened=0 service=inactive open_after=0 open_untargeted=0 mirroring=0/5 alert=sent` (`service=failed` in the 2026-11-01 test runs, which predate the 16:07Z install of decision 0009's unit with `SuccessExitStatus=143`: Next exits 143 on SIGTERM; from the next stop the line reads `service=inactive`); the phone receives the urgent push; `make status` → service inactive, crontab 0.
3. `make kill-switch REASON=paper-test-again` → `KILL_RESULT=OK` with `crons=already-empty paused=0 flattened=SKIPPED open_after=0 open_untargeted=0` (idempotency: the service is already stopped, so there is nothing to flatten through; `open_after` is the check that matters).
4. In the database: the five algorithms are `paused`; no open paper position; any position closed by the flatten has `exit_reason='manual'`.
5. `make resume` → service active, `active_algorithms=0`, crontab 12 (11 before D.6, 10 in the 2026-11-01 test), the next manage, heartbeat and scan ticks 200, `RESUME_RESULT=OK`, normal-priority push received.
6. `make unpause` → `UNPAUSE_RESULT=OK`, `algorithms=5 of 5 saved`; the next scan tick shows `"scanned":5`.
7. Ledger rows KILL, KILL, RESUME and UNPAUSE on the host; copy them into `docs/decisions/deploys.md` with the test's decision entry (0008) in the next PR.

## Paper re-test with a synthetic position (D-27; window 2026-11-07/08)

Run after the scripts PR is merged and `git fetch origin` has brought it to the workstation, with the market closed. All SQL below is the operator's, in the Supabase SQL editor: a session writes to the live tables only through the three targets. The schema has no test flag, so the test uses a reserved algorithm id, which it supports cleanly: `algorithms` needs only a name and a user, `paper_positions` has no one-open-position rule, and only `updated_at` triggers fire.

**The switch flattens every active algorithm and every saved id, so a real open position closes unless its algorithm is out of the active set first.** Step 1 flips those algorithms to `paused` for the length of the test and step 11 flips them back. With the market closed nothing moves, but nothing manages those positions either. If you would rather not flip them, wait until they have closed on their own. A position left alone this way is one the switch did not target, so with `r` real positions open every run below reads `open_untargeted=r` and ends `KILL_RESULT=PARTIAL` with `open-untargeted:r`, by design; with none open it ends `OK`.

Before starting, `make logs LOG=ops-health N=2` must show `held-by-kill-switch=0`: a leftover id file would be flattened whatever its algorithm's status.

Reserved ids: test algorithm `00000000-0000-4000-8000-00000000d027`, test position `00000000-0000-4000-8000-00000000d028`. Allow about an hour, because each `make resume` waits up to 25 minutes for ticks. Avoid 21:30 UTC, when the M1 band check reads positions. Expect urgent pushes from the switch and a down and an up from healthchecks.io.

```sql
-- 1. What is open. Pause the algorithm_id of every row whose algorithm_status is active, and note exactly
-- those ids: step 11 restores them and nothing else. A row already paused stays as it is, because it was paused
-- on purpose. It will show in open_untargeted like the others.
select p.algorithm_id, a.status as algorithm_status, p.id as position_id, p.ticker, p.side, p.opened_at
from public.paper_positions p join public.algorithms a on a.id = p.algorithm_id
where p.status = 'open';
update public.algorithms set status = 'paused' where status = 'active' and id in ('<algorithm id>');

-- 2. Right after a scan tick (:00, :15, :30, :45): the test algorithm, active, no broker, no watchlist.
insert into public.algorithms (id, user_id, name, status, asset_class)
select '00000000-0000-4000-8000-00000000d027', user_id, 'TEST kill-switch re-test, delete me', 'active', 'commodity'
from public.algorithms where id = '6cea13b6-86fb-41f6-9f2c-6bef47541a6a';   -- INSERT 0 1

-- The gate, immediately before step 3. It must return no rows. If it returns one, pause that algorithm as in
-- step 1, note its id, and run the gate again. Do not repeat the insert.
select p.id, p.algorithm_id from public.paper_positions p
join public.algorithms a on a.id = p.algorithm_id
where p.status = 'open' and a.status = 'active';
```

3. `make kill-switch REASON=paper-retest` at once → `crons=disabled`, `paused=N`, `flattened=0`, `service=inactive`, `open_after=0`, `open_untargeted=r`, `mirroring=0/N`; the urgent push arrives; `make status` → service inactive, crontab 0.
4. `make kill-switch REASON=paper-retest-again` → `crons=already-empty paused=0 flattened=SKIPPED open_untargeted=r`.
5. `make resume` → `RESUME_RESULT=OK`, `active_algorithms=0`, crontab 12 (11 before D.6), ticks 200, `mirroring=0/N`.

```sql
-- 6. The synthetic position, on the test algorithm, which is paused and saved.
insert into public.paper_positions (id, user_id, algorithm_id, ticker, side, quantity, entry_price, notional_value, current_price, unrealized_pnl, entry_reason)
select '00000000-0000-4000-8000-00000000d028', user_id, id, 'XAU/USD', 'long', 0.01, 1, 1, 1, 0, '{"test": "kill-switch re-test"}'::jsonb
from public.algorithms where id = '00000000-0000-4000-8000-00000000d027';
```

7. `make kill-switch REASON=paper-retest-rerun` → `crons=disabled paused=0 flattened=1 open_after=0 open_untargeted=r`. This is the D-27 path: the crontab is back, nothing is active, and the switch still flattens the ids the engagement targeted. Those exclude step 1's algorithms, so the real positions stay open.
8. `make resume` → `RESUME_RESULT=OK`.

```sql
-- 9. It closed as manual, then remove every trace. activity_log's foreign keys are ON DELETE SET NULL,
-- so its rows go first; deleting the algorithm cascades to the position.
select id, status, exit_reason, realized_pnl from public.paper_positions where id = '00000000-0000-4000-8000-00000000d028';
delete from public.activity_log where algorithm_id = '00000000-0000-4000-8000-00000000d027' or position_id = '00000000-0000-4000-8000-00000000d028';
delete from public.algorithms where id = '00000000-0000-4000-8000-00000000d027';
```

10. `make unpause` → `UNPAUSE_RESULT=OK`; `make logs LOG=deploys N=1` shows `algorithms=M of N saved` with M one fewer than N, because the test algorithm is gone.

```sql
-- 11. Only the ids step 1 paused, which read active there. Never an algorithm that was already paused.
update public.algorithms set status = 'active' where status = 'paused' and id in ('<algorithm id>');
```

12. The next scan tick shows `"scanned":5`, and every real position from step 1 is still open.
13. Ledger rows: copy the KILL, RESUME and UNPAUSE lines into `docs/decisions/deploys.md`, with the two reserved ids and any algorithm flipped in step 1.

If a step differs, stop there and run `make status` first. To restore the starting state:

- **Service stopped or crontab 0: the stop is in place.** Run `make resume`. Before step 11 only: if it says `algorithms-active:N` with the crontab still off, the pause failed, so run `make kill-switch` again, then `make resume`. If it says `algorithms-check-failed`, wait for the database and run `make resume` again.
- **Service active and crontab 12 (11 before D.6): the stop is not in place** (before step 3, after a resume, or after step 10). Skip `make resume`. Before step 3 or after step 10 it would only say there is nothing to resume, because no engagement is open and those algorithms are meant to be active; if it reads `algorithms-active:N` instead, an engagement list is left over, and **that is not a reason to run the switch**.

An engagement lasts until `make unpause`, which `make status` does not show, so read the state, not the step number. Go on only when `make status` shows crontab 12 (11 before D.6): then the SQL in step 9, then `make unpause`, then step 11. Finish with `make status`: service active, crontab 12 (11 before D.6).

**In this fallback, do not run the switch after step 11.** It flattens every active algorithm, which by then includes the ones holding the real positions. In a real emergency the switch is still the stop.

## Rollback of the kill switch itself

There is none to roll back: `make resume` + `make unpause` restore the pre-switch state. If `make resume` reports `no-saved-crontab`, install the repo's copy as `ops`: `scp ops/crontab qt:/tmp/qt-crontab && ssh qt 'crontab /tmp/qt-crontab'`.
