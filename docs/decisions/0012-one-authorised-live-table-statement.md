# 0012 — One live-table statement, when the operator's message in that turn authorises it

**Date:** 2026-11-17 · **Status:** active, amends 0010 · **Decided by:** the operator, in a light form: a `CLAUDE.md` rule, no hook

## Decision

Decision 0010 lets a session write the live tables (the paper engine's tables in production Supabase, such as `algorithms`, `paper_positions` and `activity_log`) only through `make kill-switch`, `make resume` and `make unpause`. A session may also run **one** SQL statement that writes a live table, through the Supabase MCP's `execute_sql`, when the operator's message in that turn authorises that statement. The session:

1. **Shows the before-values** first: a `select` of the columns the statement will change, for exactly the rows it will change, in the turn, before the statement runs.
2. **Names the ids explicitly** (`where id in ('…')`), never rows chosen only by a filter on their state.
3. **Uses a `returning` clause**, so the rows the statement changed are its output.
4. **States the expected row count** before the statement runs.
5. **Stops on a mismatch.** When the rows returned are not the expected count, or the before-values are not what the operator's message expected, the session runs nothing more and reports. It does not retry, and it does not correct with a second statement.
6. **Writes the ledger line itself**: a row in `docs/decisions/deploys.md`, in the same turn, with the time, the statement, the row count and the operator's authorising words, committed in the next PR.

One authorisation covers one statement. A second statement, even the next step of the same runbook, needs the operator's message in its own turn.

## Why

The kill switch's paper re-test (`docs/runbooks/kill-switch.md`) has SQL steps that the operator ran by hand in the Supabase SQL editor on 2026-11-07, while the session ran the make targets. With the operator at the keyboard, a session can run each statement when asked, with the same record. The operator queued this decision on 2026-11-07, and on 2026-11-17 chose its light form: "Decision 0012 in a light form: a CLAUDE.md rule, no hook. A session may run one live-table statement when my message in that turn authorises that statement. It shows the before-values, names ids explicitly, uses a returning clause, states the expected row count, stops on a mismatch, and writes the ledger line itself."

## Alternatives considered

- **A hook, or an `ask` rule on the Supabase MCP's `execute_sql`, so that every statement prompts:** not chosen. The operator chose a rule without a hook.
- **The operator runs every statement in the SQL editor, as before:** still allowed. The runbook's SQL can run either way.

## Consequences

- Nothing enforces the rule: no hook and no `ask` rule. A statement that breaks it shows only in the turn's transcript and in the ledger.
- The broker rule does not change. A statement that would let an algorithm reach a broker account, such as one that turns mirroring on (D-33), is still acting on that account, which no session does (decision 0010).
- The ledger's rows now include live-table statements a session ran (`docs/decisions/deploys.md`, header).
