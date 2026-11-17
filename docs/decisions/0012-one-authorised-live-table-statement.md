# 0012 — One live-table statement, when the operator's message in that turn authorises it

**Date:** 2026-11-17 · **Status:** active, amends 0010 · **Decided by:** the operator, in a light form: a `CLAUDE.md` rule, no hook

## Decision

Decision 0010 lets a session write the live tables (any table the live engine reads or writes, `broker_connections` included, as 0010 uses the term) only through `make kill-switch`, `make resume` and `make unpause`. A session may also run **one** SQL statement that writes a live table, through the Supabase MCP's `execute_sql`, when the operator's message in that turn authorises that statement. A `select` is not such a statement: reads stay as they were. The session:

1. **Shows the before-values** first: a `select` of the columns the statement will change, for exactly the rows it will change, in the turn, before the statement runs. For an insert, that `select` is by the new row's id and returns no row.
2. **Names the ids explicitly**: `where id in ('…')`, or, for rows that belong to a named row (an `activity_log` row of a named algorithm or position), that row's id; never rows chosen only by their state.
3. **Uses a `returning` clause**, so the rows the statement changed are its output.
4. **States the expected row count** before the statement runs, from the before-values.
5. **Stops on a mismatch.** When the rows returned are not the expected count, or the before-values are not what the operator's message expected, the session runs nothing more and reports. The statement has committed by then, so its change stands, and the report says what it changed. The session does not retry, and does not correct with a second statement.
6. **Writes the ledger line itself**: a row in `docs/decisions/deploys.md`, the repo's ledger, not the host's `/var/log/quanttrader/deploys.log`, which only the make targets write. The row goes in the same turn, with the time, the statement, the row count and the operator's authorising words, and is committed in the next PR.

One authorisation covers one statement. A second statement, even the next step of the same runbook, needs the operator's message in its own turn.

## Why

The kill switch's paper re-test (`docs/runbooks/kill-switch.md`) has SQL steps whose writes the operator ran by hand in the Supabase SQL editor on 2026-11-07, while the session ran the make targets and one read. With the operator at the keyboard, a session can run each write when asked, with the same record. The operator queued this decision on 2026-11-07, and on 2026-11-17 chose its light form: "Decision 0012 in a light form: a CLAUDE.md rule, no hook. A session may run one live-table statement when my message in that turn authorises that statement. It shows the before-values, names ids explicitly, uses a returning clause, states the expected row count, stops on a mismatch, and writes the ledger line itself."

## Alternatives considered

- **A hook that checks or prompts for every statement:** not chosen. The operator chose a `CLAUDE.md` rule with no hook, which the session reads as no settings change either, so no `ask` rule on `execute_sql`.
- **The operator runs every write in the SQL editor, as before:** still allowed. The runbook's writes can run either way.

## Consequences

- Nothing enforces the rule. A statement that breaks it shows in the turn's transcript, and in the ledger only if its row was written. The light form is the operator's choice, and no DEBT row tracks the missing enforcement.
- The broker rule does not change. A statement that would let an algorithm reach a broker account, such as one that turns mirroring on (D-33) or re-activates an algorithm while mirroring is on, is acting on that account, which no session does (decision 0010).
- The ledger's rows now include live-table statements a session ran (`docs/decisions/deploys.md`, header).

## Evidence

- The operator's order of 2026-11-17, quoted under Why.
- `docs/decisions/deploys.md`, rows 2026-11-07T12:31:01Z to 13:04Z: the first paper re-test, whose writes the operator ran in the SQL editor between the session's make targets (step 9 at 13:03Z, step 11 at 13:04Z).
