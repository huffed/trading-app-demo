# Kill switch — stop all trading activity on the VPS, and how to come back

`make kill-switch` is the one host command allowed in market hours. It is idempotent and fails closed: whatever is unreachable, the service ends up stopped and the crons gone. Everything it does is one line in `/var/log/quanttrader/deploys.log` and an urgent ntfy push.

## What it does, in order (`scripts/ops/kill-switch.sh`, run on the host as `ops`)

Every step is attempted even after an earlier one failed, and the schedulers go first so nothing waits on the database or the app before new ticks are impossible:

1. **Disable the crontab**: saved to `/var/lib/quanttrader/crontab.disabled`, then removed. No new scan or manage tick can start.
2. **Pause** every `status='active'` algorithm through Supabase's REST API with the service role read from the host's `.env.local` (`status='paused'`); the ids are saved to `/var/lib/quanttrader/kill-switch.paused-ids`, merged with any ids a previous run saved.
3. **Flatten** the open positions of those algorithms through the app's own route `POST /api/admin/flatten-algo?id=…` on loopback with `CRON_SECRET` read on the host: the paper rows (`exit_reason` `manual`) **and the broker side of any position that carries a `broker_position_id`**, which the route closes through the adapter. Once the app stops answering (connection refused or a 60 s timeout) the remaining ids are skipped rather than waited on.
4. **Stop and disable the service** (`systemctl disable --now quanttrader`): a reboot does not bring trading back.
5. **Count what is still open** for those algorithms (`open_after=`), send the urgent ntfy push (`NTFY_TOPIC` from `.env.local`) and write a `KILL …` ledger line with `crons=`, `paused=`, `flattened=`, `service=`, `open_after=`, `alert=` and `errors=` — each field says what actually happened (`FAILED`, `SKIPPED`, `N (M failed, rest skipped)`), never a literal success.

If the database or the app is unreachable, steps 2, 3 and 5 report failures and steps 1 and 4 still run. The run ignores a dropped ssh session (HUP, INT, PIPE) and also logs to `/var/log/quanttrader/kill-switch.log`, so it finishes once started. Secrets go to curl through stdin headers and are never printed. The exit status is non-zero when any step failed (`KILL_RESULT=PARTIAL`). Running it twice is harmless: an already-empty crontab keeps the saved copy, a stopped service stays stopped, nothing active means nothing to pause, and the saved ids are flattened again (that is also the recovery for `open_after>0`: `make resume`, then run the switch again).

```bash
make kill-switch REASON=<one-word-reason>      # e.g. REASON=broker-fills-wrong, REASON=paper-test
make logs LOG=deploys N=3                       # the KILL line
make status                                     # service inactive, crontab 0 entries
```

The script is streamed from the workstation's **local** copy of `origin/dev` over one ssh connection, so it works while GitHub is unreachable; `make kill-switch` refuses if that copy does not hold the script (`git fetch origin` after the PR that added it) and prints the commit it streams. If the workstation is gone too, on the host (once a deploy has put the script in the checkout): `sudo -u ops bash /opt/quanttrader/scripts/ops/kill-switch.sh <reason>` — the script refuses to run as any other user, because the crontab it must disable is `ops`'s.

## Resume (`make resume`)

Reverses the stop only: enables and starts the service, waits for `/login` 200, then **checks that no algorithm is active** — if the switch failed to pause (database outage), the crontab stays off, the line says `algorithms-active:N`, and the answer is to run the switch again — restores the crontab from the saved copy, waits for the next manage, heartbeat and scan ticks to log `http=200` (up to 25 minutes; skipped when the service or the crons did not come back), pushes (high priority when anything failed) and writes a `RESUME …` ledger line. **Algorithms stay paused.** Nothing trades after a resume until the operator un-pauses. Exit status is non-zero when any step failed.

## Un-pause (`make unpause`) — the operator's deliberate act

Re-activates exactly the algorithms the kill switch paused (the saved id list), never every paused algorithm (the library holds algorithms that were paused on purpose months ago). Refuses while the service is not active (resume first). Writes an `UNPAUSE algorithms=N of M saved` ledger line with the rows actually changed and deletes the id list. Run it only after `make resume` reported OK and you have decided trading should restart; the next scan tick then scans them (`make logs LOG=scan N=1` shows `"scanned":N`). After a stop longer than 90 minutes the first heartbeat after un-pause reports stale algorithms until that scan.

## The dead-man alarm, and deploys

A kill switch left engaged trips the GitHub dead-man workflow (manage stale after 45 minutes, scan after 35) — that is correct: the stop is real. A paper test that resumes within minutes does not trip it. `make deploy` refuses while the switch is engaged (saved crontab present and the live crontab empty), at its start and again before its restart, so a deploy cannot undo a stop.

## Paper test checklist (D.3; done in a window the operator confirms, outside market hours)

Expect no open positions; the point is the sequence.

1. `git fetch origin` (the local `origin/dev` must hold the scripts); `make status` → service active, 10 cron entries, ticks 200.
2. `make kill-switch REASON=paper-test` → output ends `KILL_RESULT=OK`, `KILL_ERRORS=none`; the line reads `crons=disabled paused=5 flattened=0 service=inactive open_after=0 alert=sent`; the phone receives the urgent push; `make status` → service inactive, crontab 0.
3. `make kill-switch REASON=paper-test-again` → `KILL_RESULT=OK` with `crons=already-empty paused=0 flattened=0` (idempotency).
4. In the database: the five algorithms are `paused`; no open paper position; any position closed by the flatten has `exit_reason='manual'`.
5. `make resume` → service active, `active_algorithms=0`, crontab 10, the next manage, heartbeat and scan ticks 200, `RESUME_RESULT=OK`, normal-priority push received.
6. `make unpause` → `UNPAUSE_RESULT=OK`, `algorithms=5 of 5 saved`; the next scan tick shows `"scanned":5`.
7. Ledger rows KILL, KILL, RESUME and UNPAUSE on the host; copy them into `docs/decisions/deploys.md` with the test's decision entry (0008) in the next PR.

## Rollback of the kill switch itself

There is none to roll back: `make resume` + `make unpause` restore the pre-switch state. If `make resume` reports `no-saved-crontab`, install the repo's copy as `ops`: `scp ops/crontab qt:/tmp/qt-crontab && ssh qt 'crontab /tmp/qt-crontab'`.
