# Kill switch — stop all trading activity on the VPS, and how to come back

`make kill-switch` is the one host command allowed in market hours. It is idempotent and fails closed: whatever is unreachable, the service ends up stopped and the crons gone. Everything it does is one line in `/var/log/quanttrader/deploys.log` and an urgent ntfy push.

## What it does, in order (`scripts/ops/kill-switch.sh`, run on the host as `ops`)

1. **Pause** every `status='active'` algorithm through Supabase's REST API with the service role read from the host's `.env.local` (`status='paused'`), so no new entry can open; the ids it paused are saved to `/var/lib/quanttrader/kill-switch.paused-ids`.
2. **Flatten** the open paper positions of those algorithms through the app's own route `POST /api/admin/flatten-algo?id=…` on loopback (`exit_reason` `manual`), with `CRON_SECRET` read on the host.
3. **Stop**: `systemctl stop quanttrader`; the crontab is saved to `/var/lib/quanttrader/crontab.disabled` and removed.
4. **Alert and record**: ntfy (`NTFY_TOPIC` from `.env.local`, priority urgent) and a `KILL …` ledger line with `paused=`, `flattened=`, `service=`, `alert=` and `errors=`.

If the database or the app is unreachable, steps 1 and 2 report `FAILED` and steps 3 and 4 still run. Secrets go to curl through stdin headers and are never printed. Running it twice is harmless: an already-empty crontab keeps the saved copy, a stopped service stays stopped, and no active algorithm means nothing to pause.

```bash
make kill-switch REASON=<one-word-reason>      # e.g. REASON=broker-fills-wrong, REASON=paper-test
make logs LOG=deploys N=3                       # the KILL line
make status                                     # service inactive, crontab 0 entries
```

The script is streamed from the workstation's **local** copy of `origin/dev` over one ssh connection, so it works while GitHub is unreachable; `make kill-switch` prints the commit it streams. If the workstation is gone too, on the host: `bash /opt/quanttrader/scripts/ops/kill-switch.sh <reason>` (the checkout's copy, same script).

## Resume (`make resume`)

Reverses step 3 only: starts the service, waits for `/login` 200, restores the crontab from the saved copy, waits for the next manage, heartbeat and scan ticks to log `http=200` (up to 25 minutes), sends a normal-priority ntfy push and writes a `RESUME …` ledger line. **Algorithms stay paused.** Nothing trades after a resume until the operator un-pauses.

## Un-pause (`make unpause`) — the operator's deliberate act

Re-activates exactly the algorithms the kill switch paused (the saved id list), never every paused algorithm (the library holds algorithms that were paused on purpose months ago). Writes an `UNPAUSE algorithms=N` ledger line and deletes the id list. Run it only after `make resume` reported OK and you have decided trading should restart; the next scan tick then scans them (`make logs LOG=scan N=1` shows `"scanned":N`).

## The dead-man alarm

A kill switch left engaged trips the GitHub dead-man workflow (manage stale after 45 minutes, scan after 35) — that is correct: the stop is real. A paper test that resumes within minutes does not trip it.

## Paper test checklist (D.3; done in a window the operator confirms, outside market hours)

Expect no open paper positions; the point is the sequence.

1. `make status` → service active, 10 cron entries, ticks 200.
2. `make kill-switch REASON=paper-test` → output ends `KILL_RESULT=OK`, `KILL_ERRORS=none`; `paused=5 flattened=0 service=inactive alert=sent`; the phone receives the urgent push; `make status` → service inactive, crontab 0.
3. In the database: the five algorithms are `paused`; no open paper position; any position closed by the flatten has `exit_reason='manual'`.
4. `make resume` → service active, crontab 10, the next manage, heartbeat and scan ticks 200, `RESUME_RESULT=OK`, normal-priority push received.
5. `make unpause` → `UNPAUSE_RESULT=OK`; the five algorithms are `active`; the next scan tick shows `"scanned":5`.
6. Ledger rows KILL, RESUME and UNPAUSE on the host; copy them into `docs/decisions/deploys.md` with the test's decision entry (0008) in the next PR.

## Rollback of the kill switch itself

There is none to roll back: `make resume` + `make unpause` restore the pre-switch state. If `make resume` reports `no-saved-crontab`, install the repo's copy as `ops`: `scp ops/crontab qt:/tmp/qt-crontab && ssh qt 'crontab /tmp/qt-crontab'`.
