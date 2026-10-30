# 0001 — Remove the dead LLM strategy-template selector (and 21 other unreachable files)

**Date:** 2026-10-28 · **Status:** active · **Phase:** B (zero-behaviour-change cleanup), operator-approved 2026-10-28.

## Decision

Delete `src/lib/strategies/selector.ts` and `templates.ts` (the Groq-backed strategy-template selector from the deleted onboarding wizard era) together with the other files that no page, route, server action, script or middleware reaches (list in the PR that cites this entry). `src/lib/env.ts` is explicitly **kept** although unreachable: wiring it in is the right fix and changes startup behaviour, so it is a high-priority Phase E item (DEBT D-09).

## Why

The import-graph reachability check (`scripts/dev` tooling, Phase A `metrics/reachability.mjs`) plus `knip` and a grep for dynamic imports and string-based requires found no reference to any of these files outside their own cluster. CLAUDE.md justified keeping the Groq client because "the combinatorial-search template selector still uses it"; the selector itself had no importer, so the justification was false and misled every reader. Dead code that still compiles and lints is the cheapest debt to remove and the most expensive to keep (every search returns it; docs cite it).

## Alternatives considered

- Keep behind a "dormant-by-design" label — rejected: the dormant list in CLAUDE.md names journal, trades/CSV import, stocks scaffolding and cTrader; the selector is not on it and nothing planned reuses it.
- Move to `scripts/archive/` — rejected: git history is the archive; a revert restores it in one command.

## Consequences

- The Groq client (`src/lib/ai/client.ts`) stays for journal analysis (dormant) and the LLM-trader fallback provider only; CLAUDE.md is corrected in the same PR.
- If the audit's Phase 7 reinstates an LLM selector, `git revert <this PR's merge commit>` brings everything back unchanged.

## Evidence

`docs/DEBT.md` D-10; `docs/CODE_QUALITY.md` §1.2 ("Everything else" table); the deleting PR's description carries the per-file proof.
