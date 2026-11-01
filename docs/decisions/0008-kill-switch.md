# 0008 — One kill switch: pause, flatten paper, stop the service and the crons, alert, record; resume never un-pauses

**Date:** 2026-11-01 · **Status:** active · **Phase:** D.3.

## Decision

`make kill-switch REASON=<word>` streams `scripts/ops/kill-switch.sh` from the workstation's local copy of `origin/dev` to the host over one ssh connection and runs it as `ops`. In order, attempting every step even after a failure: pause every active algorithm (Supabase REST, service role read on the host; the paused ids are saved), flatten their open paper positions through the app's own `/api/admin/flatten-algo` route on loopback (`exit_reason` `manual`), stop the service, save and remove the crontab, send an urgent ntfy push, write a `KILL` ledger line that says exactly what succeeded. It is idempotent and the only host change permitted in market hours. `make resume` reverses only the stop (service, crontab, tick verification, push, `RESUME` line) and leaves the algorithms paused; `make unpause` re-activates exactly the saved ids and is the operator's deliberate act. Secrets are read on the host and passed to curl through stdin headers.

## Why

DEBT D-19: there was no single kill switch; `status='paused'` alone orphans open positions, stopping the service alone leaves the crons failing noisily, and nothing recorded what was done when. The operator required one idempotent command that still stops the service and the crons when the database is unreachable (fail closed), that alerts and writes a ledger row, with the resume procedure documented next to it.

## Alternatives considered

- A new admin API route (`/api/admin/kill`) inside the app: it would live in the fenced trading code and would be unavailable precisely when the app is down; rejected. The switch uses the existing flatten route when the app answers and does not depend on it for the stop.
- SQL through `psql` on the host: no client installed and the connection string is not in the env file; the REST API with the service role is what the app's admin client uses.
- Un-pausing as part of resume: rejected — restarting trading is a decision, not a side effect; and un-pausing "all paused" would wake algorithms paused on purpose in June.
- Deleting the crontab without saving it: rejected — `make resume` restores exactly what was installed.

## Consequences

- `make deploy` must refuse while the switch is engaged (decision 0005 consequence); until that check exists, the operator runs `make resume` first.
- A switch left engaged trips the dead-man workflow by design (manage > 45 min, scan > 35 min).
- The paused-ids file and the saved crontab live in `/var/lib/quanttrader`, owned by `ops`.
- The paper test is recorded in `docs/decisions/deploys.md` (KILL, RESUME, UNPAUSE rows) and below.

## Evidence

Paper test: _to be filled from the ledger rows when run._
