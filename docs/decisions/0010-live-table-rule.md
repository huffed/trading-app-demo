# 0010 — The live-table rule: three targets are the exception, and no committed allow rule can pre-approve them

**Date** 2026-11-01 · **Status** active, amends 0008 · **Decided by** the operator (wording), with the enforcement added after the review of PR #317

## Decision

`CLAUDE.md`'s last rule said nothing that writes to the live tables runs from a Claude session. `make kill-switch`, `make resume` and `make unpause` do, by design (0008). The operator amended the rule rather than denying the targets: **no session writes to the live tables except through those three, each of which prompts every time, is never pre-approved, and writes a ledger row.** The three targets' help text, the runbook and `docs/DEV_SETUP.md` §18 carry the same wording; like every host command, they run only when the operator asks.

## Why

Denying the targets would have left the emergency stop runnable only by hand from a terminal. The operator wants it one prompted command away from any session, with the record it already writes.

## Alternatives considered

- `deny` rules for the three targets — rejected by the operator.
- Wording alone — rejected by the fresh-context review of PR #317: `make lint-strict FILES=x unpause` matched the pre-approved `make lint-strict *` rule, matched no `ask` rule, passed the Bash guard, and would have run the un-pause with no prompt. make runs every goal on its command line. The claim needed enforcement.

## Consequences

- Makefile: a host goal (`deploy deploy-pointer status logs kill-switch resume unpause`) beside any other goal, or a `MAKECMDGOALS` that make did not set itself (`$(origin MAKECMDGOALS)` is `default` only when make set it; checked on GNU make 3.81), is refused with `$(error …)` while make reads the file — nothing runs.
- No pre-approved make rule takes arguments: `Bash(make lint-strict)`, `Bash(make format-check)` and `Bash(make regime-report)` are exact (each target has a default — `lint-strict` lints the files added vs `BASE`, as CI does; a form with arguments prompts), and the skills' `allowed-tools` are exact too. A wildcard rule such as `Bash(make lint-strict *)` would have pre-approved `make lint-strict FILES=x '--eval=lint-strict: unpause'`, which runs the un-pause as a prerequisite before any goal check (the review's verification pass found it).
- `.claude/hooks/guard-bash.sh` refuses, before the command reaches make: a host goal beside another goal, behind a flag (`make -s unpause`) or behind an override (`make REASON=x kill-switch`) — quotes around a single word are seen through, a quoted span with spaces counts as one token; `-f`, `-C`, `--eval` and the like, quoted or not; `MAKEFILES=`; a makefile from stdin. `.claude/settings.json` asks for every flagged `make -…`.
- `tests/ops/makefile-host-targets.test.ts` fails if an allow rule in `.claude/settings.json` (or in `.claude/settings.local.json` on a local run — that file is gitignored, so CI never sees it) could pre-approve a host target: a blanket `Bash` or `make` rule, a flag form, a host target anywhere in the rule, or a wildcard prefix that could grow into one; if any `Bash(make …)` allow rule — committed, in a skill's `allowed-tools`, or local — takes arguments; if either spelling of the three targets, or `Bash(make -*)`, leaves the `ask` list; or if make accepts a host goal beside another.
- Not covered: user-level settings, `--allowedTools`, and a pre-approved program that runs make for you. The operator removed five pre-approvals and an env-file read from `.claude/settings.local.json` on 2026-11-01; `Bash(pnpm dlx:*)`, `Bash(npm run:*)` and `Bash(pnpm run:*)` remain there and are the operator's to prune (`pnpm dlx concurrently "make unpause"` would be pre-approved on that machine).
- "Ledger row" in `CLAUDE.md` is the operator's word for the pair: the line the script appends to the host's `deploys.log` and the row copied from it into `docs/decisions/deploys.md` in the next PR. Two paths still write no line (DEBT D-24): an un-pause whose PATCH committed but whose curl failed, and a failed append to `deploys.log`. Fixed with a paper re-test in the next host window, not between tests.
- Open, the operator's call: the broker half of the old sentence. The kill switch's flatten runs through the app's own route, which closes any broker position the engine mirrored (none exist while mirroring is off). Whether `CLAUDE.md` names that exception is not a session's decision.

## Evidence

Review of PR #317 (2026-11-01): the multi-goal bypass, the test's misses (`Bash(make -s *)`, `Bash(make REASON=x kill-switch)`, `Bash(make k*)`), the two ledger-line gaps, the dropped "only when the operator asks". `tests/ops/makefile-host-targets.test.ts` and `tests/hooks/cases.ts` pin the fixes.
