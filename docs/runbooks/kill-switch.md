# Kill switch — stop all trading activity on the VPS, and how to come back

`make kill-switch` is the one host command allowed in market hours (the one other exception: appending the `HEARTBEAT_PING_URL` line, `docs/runbooks/d4-alerts-and-rotation.md`). It is idempotent and fails closed: whatever is unreachable, the service ends up stopped and the crons gone. Everything it does is one line in `/var/log/quanttrader/deploys.log` and an urgent ntfy push. `make kill-switch`, `make resume` and `make unpause` are the only way a Claude session writes to the live tables (CLAUDE.md, decision 0010): each prompts every time, is never pre-approved (`ask` rules in `.claude/settings.json`; no pre-approved make rule takes arguments, so every make command with arguments prompts whatever its spelling — the one real backstop; the Makefile and `guard-bash` also refuse a host goal beside another goal, behind a flag or behind an override, and `guard-bash` refuses the `--eval`, `-f`, `MAKEFILES=`, `MAKEFLAGS=` and stdin-makefile spellings it can see through; `tests/ops/makefile-host-targets.test.ts` checks), runs only when the operator asks for it, and writes its ledger line — the row in `docs/decisions/deploys.md` is copied from it in the next PR, and CLAUDE.md's "ledger row" means that pair. A failed append to `deploys.log` counts as an error in all three, and an un-pause whose PATCH failed writes `UNPAUSE result=unknown`, because it may have committed.

## What it does, in order (`scripts/ops/kill-switch.sh`, run on the host as `ops`)

Every step is attempted even after an earlier one failed, and the schedulers go first so nothing waits on the database or the app before new ticks are impossible:

1. **Disable the crontab**: saved to `/var/lib/quanttrader/crontab.disabled`, then removed. No new scan or manage tick can start.
2. **Pause** every `status='active'` algorithm through Supabase's REST API with the service role read from the host's `.env.local` (`status='paused'`); the ids are saved to `/var/lib/quanttrader/kill-switch.paused-ids`, merged with any ids a previous run saved.
3. **Flatten** the open positions of those algorithms, and of any ids an earlier run saved that `make unpause` has not consumed, through the app's own route `POST /api/admin/flatten-algo?id=…` on loopback with `CRON_SECRET` read on the host: the paper rows (`exit_reason` `manual`) **and the broker side of any position that carries a `broker_position_id`**, which the route closes through the adapter. A failed broker close (`broker-failed:` in the route's response) is an error even though the route answers 200, and the paper row closes anyway. Once the app stops answering (connection refused or a 60 s timeout) the remaining ids are skipped rather than waited on.
4. **Stop and disable the service** (`systemctl disable --now quanttrader`): a reboot does not bring trading back.
5. **Count what is still open** for those algorithms (`open_after=`), or every open position when there is no id to flatten, which is then an error (`open-untargeted:N`); read their mirroring state (`mirroring=<on>/<total>`, `live_trading_enabled`, a record and not a safeguard, decision 0010); send the urgent ntfy push (`NTFY_TOPIC` from `.env.local`) and write a `KILL …` ledger line with `crons=`, `paused=`, `flattened=`, `service=`, `open_after=`, `mirroring=`, `alert=` and `errors=` — each field says what actually happened (`FAILED`, `SKIPPED`, `N (M failed, K broker-failed, rest skipped)`), never a literal success.

If the database or the app is unreachable, steps 2, 3 and 5 report failures and steps 1 and 4 still run. The run ignores a dropped ssh session (HUP, INT, PIPE) and also logs to `/var/log/quanttrader/kill-switch.log`, so it finishes once started. Secrets go to curl through stdin headers and are never printed. The exit status is non-zero when any step failed (`KILL_RESULT=PARTIAL`). Running it twice is harmless: an already-empty crontab keeps the saved copy, a stopped service stays stopped, nothing active means nothing to pause, and the flatten is skipped (`flattened=SKIPPED`) while `open_after` still counts what is open. The recovery for `open_after>0` is `make resume`, then the switch again: the saved ids are flattened whatever the crontab says (DEBT D-27). `open_after` counts paper rows only: a failed broker close shows `open_after=0` with `broker-failed:…` in `errors=`, and because the paper row has closed a re-run cannot retry it, so close that position at the broker (D-25, whose engine half waits for the audit verdict). The saved id list is kept across re-runs of one engagement and replaced at the next fresh engagement, so `make unpause` never wakes algorithms paused on purpose in between.

```bash
make kill-switch REASON=<one-word-reason>      # e.g. REASON=broker-fills-wrong, REASON=paper-test
make logs LOG=deploys N=3                       # the KILL line
make status                                     # service inactive, crontab 0 entries
```

The script is streamed from the workstation's **local** copy of `origin/dev` over one ssh connection, so it works while GitHub is unreachable; `make kill-switch` refuses if that copy does not hold the script (`git fetch origin` after the PR that added it) and prints the commit it streams. If the workstation is gone too, on the host (once a deploy has put the script in the checkout): `sudo -u ops bash /opt/quanttrader/scripts/ops/kill-switch.sh <reason>` — the script refuses to run as any other user, because the crontab it must disable is `ops`'s.

Transport: the target opens or reuses one multiplexed ssh connection (`~/.ssh/qt-make-%C`, shared with `make status`, `logs`, `resume` and `unpause`, kept 60 s after the last command; a dead connection is declared within 30 s). If it stalls or exits 255 with a `mux_client` error, the socket is stale (the workstation slept while the master was alive; detection takes about 30–45 s): `ssh -O exit -o ControlPath=~/.ssh/qt-make-%C qt` ends the stale master at once (or delete `~/.ssh/qt-make-*`), then run the switch again — it is idempotent. `Connection refused` from ssh is the host's `ufw limit 22/tcp` (six connections from one address in 30 s): wait 30 s and run it again.

## Resume (`make resume`)

Once mirroring is on, this counts as acting on the broker account (decision 0010): it brings back the service and the crons the engine trades through, and together with `make unpause` it lets the engine trade again. The algorithms stay paused until `make unpause`. It prompts, prints the mirroring state of the saved algorithms and writes it on its ledger line.

Reverses the stop only: enables and starts the service, waits for `/login` 200, then **checks that no algorithm is active** — if the switch failed to pause (database outage), the crontab stays off, the line says `algorithms-active:N`, and the answer is to run the switch again — restores the crontab from the saved copy, waits for the next manage, heartbeat and scan ticks to log `http=200` (up to 25 minutes; skipped when the service or the crons did not come back), pushes (high priority when anything failed) and writes a `RESUME …` ledger line. **Algorithms stay paused.** Nothing trades after a resume until the operator un-pauses. Exit status is non-zero when any step failed.

## Un-pause (`make unpause`) — the operator's deliberate act

Once mirroring is on, this counts as acting on the broker account (decision 0010): together with `make resume` it lets the engine trade again, and the next scan of the re-activated algorithms mirrors entries. It prompts, prints the mirroring state and writes it on its ledger line.

Re-activates exactly the algorithms the kill switch paused (the saved id list), never every paused algorithm (the library holds algorithms that were paused on purpose months ago). Refuses while the service is not active (resume first). Writes an `UNPAUSE algorithms=N of M saved mirroring=<on>/<total>` ledger line with the rows actually changed and deletes the id list. If the PATCH fails it writes `UNPAUSE result=unknown`, keeps the list and exits non-zero: it may have committed (a timeout after the commit), so check the database before running it again. Run it only after `make resume` reported OK and you have decided trading should restart; the next scan tick then scans them (`make logs LOG=scan N=1` shows `"scanned":N`). After a stop longer than 90 minutes the first heartbeat after un-pause reports stale algorithms until that scan.

## The dead-man alarm, and deploys

A kill switch left engaged should trip healthchecks.io about 20 minutes after the last heartbeat ping (the crontab is gone), and later the GitHub dead-man workflow, whose checks fail once manage is 45 minutes stale and scan 35. Those are thresholds, not detection times: GitHub starts that job 2 to 5 times a day, so it may be hours later (DEBT D-30). Both are correct: the stop is real. A paper test that resumes within minutes trips neither. `make deploy` refuses while the switch is engaged (saved crontab present and the live crontab empty), at its start and again before its restart, so a deploy cannot undo a stop.

## Paper test checklist (D.3; done in a window the operator confirms, outside market hours)

Expect no open positions; the point is the sequence.

1. `git fetch origin` (the local `origin/dev` must hold the scripts); `make status` → service active, 11 cron entries (10 in the 2026-11-01 test, before D.4's ops-health line), ticks 200.
2. `make kill-switch REASON=paper-test` → output ends `KILL_RESULT=OK`, `KILL_ERRORS=none`; the line reads `crons=disabled paused=5 flattened=0 service=inactive open_after=0 alert=sent` (`service=failed` in the 2026-11-01 test runs, which predate the 16:07Z install of decision 0009's unit with `SuccessExitStatus=143`: Next exits 143 on SIGTERM; from the next stop the line reads `service=inactive`); the phone receives the urgent push; `make status` → service inactive, crontab 0.
3. `make kill-switch REASON=paper-test-again` → `KILL_RESULT=OK` with `crons=already-empty paused=0 flattened=SKIPPED open_after=0` (idempotency: the service is already stopped, so there is nothing to flatten through; `open_after` is the check that matters).
4. In the database: the five algorithms are `paused`; no open paper position; any position closed by the flatten has `exit_reason='manual'`.
5. `make resume` → service active, `active_algorithms=0`, crontab 11 (10 in the 2026-11-01 test), the next manage, heartbeat and scan ticks 200, `RESUME_RESULT=OK`, normal-priority push received.
6. `make unpause` → `UNPAUSE_RESULT=OK`, `algorithms=5 of 5 saved`; the next scan tick shows `"scanned":5`.
7. Ledger rows KILL, KILL, RESUME and UNPAUSE on the host; copy them into `docs/decisions/deploys.md` with the test's decision entry (0008) in the next PR.

## Paper re-test with a synthetic position (D-27; window 2026-11-07/08)

Run after the scripts PR is merged and `git fetch origin` has brought it to the workstation, with the market closed. All SQL below is the operator's, in the Supabase SQL editor: a session writes to the live tables only through the three targets. The schema has no test flag, so the test uses a reserved algorithm id, which it supports cleanly: `algorithms` needs only a name and a user, `paper_positions` has no one-open-position rule, and only `updated_at` triggers fire.

**The switch flattens every active algorithm and every saved id, so a real open position closes unless its algorithm is out of the active set first.** Step 1 flips those algorithms to `paused` for the length of the test and step 11 flips them back. With the market closed nothing moves, but nothing manages those positions either. If you would rather not flip them, wait until they have closed on their own.

Reserved ids: test algorithm `00000000-0000-4000-8000-00000000d027`, test position `00000000-0000-4000-8000-00000000d028`. Allow about an hour, because each `make resume` waits up to 25 minutes for ticks. Avoid 21:30 UTC, when the M1 band check reads positions. Expect urgent pushes from the switch and a down and an up from healthchecks.io.

```sql
-- 1. What is open. Note the algorithm ids; if any row is listed, pause them (the ids are yours to paste).
select id, algorithm_id, ticker, side, opened_at from public.paper_positions where status = 'open';
update public.algorithms set status = 'paused' where status = 'active' and id in ('<algorithm id>');

-- 2. Right after a scan tick (:00, :15, :30, :45): the test algorithm, active, no broker, no watchlist.
insert into public.algorithms (id, user_id, name, status, asset_class)
select '00000000-0000-4000-8000-00000000d027', user_id, 'TEST kill-switch re-test, delete me', 'active', 'commodity'
from public.algorithms where id = '6cea13b6-86fb-41f6-9f2c-6bef47541a6a';
```

3. `make kill-switch REASON=paper-retest` within a minute or two → `KILL_RESULT=OK`, `crons=disabled`, `paused=N`, `flattened=0`, `service=inactive`, `open_after=0`, `mirroring=0/N`; the urgent push arrives; `make status` → service inactive, crontab 0.
4. `make kill-switch REASON=paper-retest-again` → `KILL_RESULT=OK`, `crons=already-empty paused=0 flattened=SKIPPED`.
5. `make resume` → `RESUME_RESULT=OK`, `active_algorithms=0`, crontab 11, ticks 200, `mirroring=0/N`.

```sql
-- 6. The synthetic position, on the test algorithm, which is paused and saved.
insert into public.paper_positions (id, user_id, algorithm_id, ticker, side, quantity, entry_price, notional_value, current_price, unrealized_pnl, entry_reason)
select '00000000-0000-4000-8000-00000000d028', user_id, id, 'XAU/USD', 'long', 0.01, 1, 1, 1, 0, '{"test": "kill-switch re-test"}'::jsonb
from public.algorithms where id = '00000000-0000-4000-8000-00000000d027';
```

7. `make kill-switch REASON=paper-retest-rerun` → `KILL_RESULT=OK`, `crons=disabled paused=0 flattened=1 open_after=0`. This is the D-27 path: the crontab is back, nothing is active, and the switch still flattens the saved ids.
8. `make resume` → `RESUME_RESULT=OK`.

```sql
-- 9. It closed as manual, then remove every trace. activity_log's foreign keys are ON DELETE SET NULL,
-- so its rows go first; deleting the algorithm cascades to the position.
select id, status, exit_reason, realized_pnl from public.paper_positions where id = '00000000-0000-4000-8000-00000000d028';
delete from public.activity_log where algorithm_id = '00000000-0000-4000-8000-00000000d027' or position_id = '00000000-0000-4000-8000-00000000d028';
delete from public.algorithms where id = '00000000-0000-4000-8000-00000000d027';
```

10. `make unpause` → `UNPAUSE_RESULT=OK`, `algorithms=M of N saved` with M one fewer than N, because the test algorithm is gone.

```sql
-- 11. Only if step 1 paused anything.
update public.algorithms set status = 'active' where status = 'paused' and id in ('<algorithm id>');
```

12. The next scan tick shows `"scanned":5`, and every real position from step 1 is still open.
13. Ledger rows: copy the KILL, RESUME and UNPAUSE lines into `docs/decisions/deploys.md`, with the two reserved ids and any algorithm flipped in step 1.

If a step differs, stop there: `make resume`, then the SQL in step 9, then `make unpause`, then step 11 restore the starting state.

## Rollback of the kill switch itself

There is none to roll back: `make resume` + `make unpause` restore the pre-switch state. If `make resume` reports `no-saved-crontab`, install the repo's copy as `ops`: `scp ops/crontab qt:/tmp/qt-crontab && ssh qt 'crontab /tmp/qt-crontab'`.
