# 0014 — E0's live-path tests may land before the audit verdict

**Date:** 2026-11-13 · **Status:** active.

## Decision

E0 of `docs/MODERNISATION.md`, the live-path test (D-05), is no longer held for `review/VERDICT.md`. Its PRs may merge before the verdict under four conditions:

- they add or change test files only, in `tests/`, with no non-test line;
- they change nothing under a fenced path (`.claude/hooks/live-paths.txt`);
- they use fixtures and stubs only, and pinned data, never the live tables, a broker or the network;
- a known defect they expose is an `it.fails` that points at the audit or a DEBT id; nothing is fixed.

The rest of Phase E still waits for the verdict, except E13, which never did.

## Why

The first engine or strategy change is gated by the audit verdict, then the fence, then E0: the golden replay runs no code under `src/lib/scan/`, so no engine PR can show it left trades alone without E0. Writing E0 now takes it off that path. It changes no behaviour and moves no line the audit cites. The operator adopted it on 2026-11-13, from item 3 of the retrospective's B9g.

## Alternatives considered

- **Hold E0 for the verdict, as the plan said on 2026-11-06:** rejected by the operator. It leaves the test on the critical path after the verdict.
- **Put the tests beside the code in `src/lib/scan/`:** rejected. That path is fenced, so the session would need the fence lifted.

## Consequences

- E0's tests run in CI on every PR from when they merge. A test that a later engine PR breaks is that PR's evidence, as golden is today.
- The tests describe the engine as it is, defects included. A defect found is an `it.fails` with a DEBT id, and its fix waits for the verdict like every other engine change.
