# 0008 — One kill switch: pause, flatten (paper rows and the broker side of mirrored positions), stop the service and the crons, alert, record; resume never un-pauses

**Date:** 2026-11-01 · **Status:** active, amended by 0010 · **Phase:** D.3.

## Decision

`make kill-switch REASON=<word>` streams `scripts/ops/kill-switch.sh` from the workstation's local copy of `origin/dev` to the host over one ssh connection and runs it as `ops`. In order, attempting every step even after a failure: save and remove the crontab (no new ticks, and nothing waits on the database or the app first), pause every active algorithm (Supabase REST, service role read on the host; the paused ids are saved and merged with earlier runs'), flatten their open positions through the app's own `/api/admin/flatten-algo` route on loopback — the paper rows (`exit_reason` `manual`) and the broker side of any position carrying a `broker_position_id` — skipping the rest once the app stops answering, stop **and disable** the service, count what is still open, send an urgent ntfy push, write a `KILL` ledger line whose every field says what actually happened. The run ignores a dropped ssh session and logs to a file on the host; it exits non-zero when any step failed. It is idempotent and the only host command permitted in market hours (amended 2026-11-02 by 0009: appending the `HEARTBEAT_PING_URL` line is the one other exception). `make resume` reverses only the stop (enable + start the service, refuse to restore the crontab while any algorithm is still active, tick verification, push, `RESUME` line) and leaves the algorithms paused; `make unpause` re-activates exactly the saved ids and is the operator's deliberate act. Secrets are read on the host and passed to curl through stdin headers.

## Why

DEBT D-19: there was no single kill switch; `status='paused'` alone orphans open positions, stopping the service alone leaves the crons failing noisily, and nothing recorded what was done when. The operator required one idempotent command that still stops the service and the crons when the database is unreachable (fail closed), that alerts and writes a ledger row, with the resume procedure documented next to it.

## Alternatives considered

- A new admin API route (`/api/admin/kill`) inside the app: it would live in the fenced trading code and would be unavailable precisely when the app is down; rejected. The switch uses the existing flatten route when the app answers and does not depend on it for the stop.
- SQL through `psql` on the host: no client installed and the connection string is not in the env file; the REST API with the service role is what the app's admin client uses.
- Un-pausing as part of resume: rejected — restarting trading is a decision, not a side effect; and un-pausing "all paused" would wake algorithms paused on purpose in June.
- Deleting the crontab without saving it: rejected — `make resume` restores exactly what was installed.

## Consequences

- `make deploy` refuses while the switch is engaged (saved crontab present, live crontab empty), at its start and before its restart (decision 0005 consequence, done here).
- A switch left engaged trips the dead-man workflow by design (manage > 45 min, scan > 35 min).
- The three targets write `algorithms.status` and the flatten route can reach the broker. `CLAUDE.md`'s sentence "nothing that connects to a broker or writes to the live tables runs from a Claude session" predated the switch; the targets prompt and run only when the operator asks for them. The operator amended the live-table half on 2026-11-01 (decision 0010: the three targets are the only exception, prompt every time, are never pre-approved, write a ledger row); the broker half on 2026-11-02 (0010): no session acts on a broker account except `make kill-switch`, which may flatten mirrored positions.
- The paused-ids file and the saved crontab live in `/var/lib/quanttrader`, owned by `ops`.
- The paper test is recorded in `docs/decisions/deploys.md` (KILL, RESUME, UNPAUSE rows) and below.

## Evidence

Paper test 2026-11-01 (Sunday, market closed, no open positions), rows in `docs/decisions/deploys.md`: 15:18:42Z run 1 — crons disabled (10 saved), 5 algorithms paused, 0 positions to flatten, service stopped and disabled, open_after 0, urgent push received, `KILL_RESULT=OK`; database checked: 5 paused, 0 active, 0 open positions. 15:20:16Z run 2 — `crons=already-empty paused=0 flattened=SKIPPED open_after=0`, `KILL_RESULT=OK` (idempotent). 15:30:04Z `make resume` — service enabled and started 15:20:48Z, `/login` 200, `active_algorithms=0`, crontab restored (10), the 15:25 manage and heartbeat ticks and the 15:30 scan tick answered 200, push received, `RESUME_RESULT=OK`. 15:31:38Z `make unpause` — 5 of 5 re-activated (database: 5 active); 15:45:01Z scan tick http=200, `"scanned":5`. One finding: after `systemctl disable --now` the unit's state was `failed` (`ExecMainStatus=143`: Next exits 143 on SIGTERM), so the KILL line said `service=failed`; decision 0009's unit adds `SuccessExitStatus=143`, after which a deliberate stop ends `inactive`.
