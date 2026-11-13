# 0014 — E0's live-path tests may land before the audit verdict

**Date:** 2026-11-13 · **Status:** active.

## Decision

E0 of `docs/MODERNISATION.md`, the live-path test (D-05), is no longer held for `review/VERDICT.md`. Its PRs may merge before the verdict under four conditions:

1. They add new test files under `tests/characterisation/` and helper modules under `tests/`. An existing test file changes only to import a helper moved out of it: no existing assertion or `it.fails` marker changes, and nothing under `tests/golden/` or `tests/hooks/` changes. Outside `tests/`, the only lines they change are the docs the PR affects: `docs/DEBT.md`, the count of `it.fails` cases in `docs/DEV_SETUP.md` §13, and `docs/MODERNISATION.md`.
2. They change nothing under a fenced path (`.claude/hooks/live-paths.txt`).
3. They use fixtures and stubs only, and pinned data, never the live tables, a broker or the network. Each E0 test file stubs `fetch` to throw and mocks the broker adapter as a module, so that a missed mock fails the test instead of reaching out.
4. A known defect they expose is an `it.fails` that points at the audit or a DEBT id, and nothing is fixed. Its assertion is that the defect is absent, not which fix removes it. Where a Part 2 item decides the fix, the test's name gives that item.

The rest of Phase E still waits for the verdict, except E13, which never did.

## Why

The first engine or strategy change is gated by the audit verdict, then the fence, then E0: the golden replay runs no code under `src/lib/scan/`, so no engine PR can show it left trades alone without E0. Writing E0 now takes it off that path. It changes no behaviour and moves no line the audit cites. The operator adopted it on 2026-11-13 (Evidence).

## Alternatives considered

- **Hold E0 for the verdict, as the plan said on 2026-11-06:** rejected by the operator. It leaves the test on the critical path after the verdict.
- **Put the tests beside the code in `src/lib/scan/`:** rejected. That path is fenced, so the session would need the fence lifted.

## Consequences

- E0's tests run in CI on every PR from when they merge. A test that a later engine PR breaks is that PR's evidence, as golden is today.
- The tests describe the engine as it is, defects included. A defect's fix waits for the verdict like every other engine change, and the PR that fixes it removes the `it.fails` marker in the same PR.
- How the conditions are checked: condition 2 is also refused by the session's fence hooks (`tests/hooks/cases.ts`); conditions 1, 3 and 4 by review only. The `fetch` stub catches a missed mock only in code that calls `fetch`, which is why the broker adapter is mocked as a module.

## Evidence

- The operator's order of 2026-11-13: "Adopt your B9g items 1, 3 and 4 now: one review round for docs without runnable commands, E0 tests before the verdict, and the turn-ending rule." B9g is a recommendation in the session's retrospective of Parts A and B (2026-11-12), a private document outside this repo.
- The golden replay reaches no file under `src/lib/scan/`. esbuild bundled `tests/golden/replay.ts` with packages external (2026-11-13, `src/` as at `a6ba8de`); its metafile lists 56 source files and none under `src/lib/scan/`: 23 in `src/lib/patterns`, 14 in `src/lib/market-data`, 10 in `src/lib/algorithm`, the rest in `conditions`, `constants`, `validators`, `src/types` and `scripts/canonical/lib`.
- Tests alone can reach the live engine: `scanAlgorithm` (`src/lib/scan/engine.ts:65`) and `manageActiveAlgorithms` (`src/lib/scan/manage.ts:187`) are exported; `applyPortfolioHalts` (`src/app/api/cron/scan-active-algorithms/route.ts:52`) is not, and the route's exported `GET` (`:90`) calls it.
