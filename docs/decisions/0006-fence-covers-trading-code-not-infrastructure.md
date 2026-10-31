# 0006 — The live-path fence covers trading code, not infrastructure; the exact list

**Date:** 2026-10-31 · **Status:** active, amends 0004 · **Phase:** D.1.

## Decision

The live-path fence (`.claude/hooks/live-paths.txt`, enforced by `guard-paths.sh` and `guard-bash.sh`) exists to freeze **trading behaviour** until the audit verdict. Its list is therefore the trading code and nothing else:

| Glob | Why it is trading code |
|---|---|
| `src/lib/scan/**` | the engine and runner: scan, manage, entry, exits, halts, sizing helpers, live execution, broker-truth sync |
| `src/lib/brokers/**` | execution: the broker adapters |
| `src/lib/algorithm/**` | strategy rules, gates, structural SL, sizing, rules post-processing |
| `src/lib/patterns/**` | strategy detectors (ICT/SMC, daily bias) |
| `src/lib/market-data/**` | the paper engine's price and fill config (provider chain, caches, indicators, condition evaluation) and the backtesters the golden file pins |
| `src/lib/validators/algorithm.ts` | the rules schema and its legacy normalisation |
| `src/lib/constants/markets.ts`, `src/lib/constants/prop-firm.ts`, `src/lib/constants/defaults.ts` | sizing inputs (pip sizes, typical spreads, catalog), FTMO risk presets, and the engine defaults applied when rules omit a field |
| `src/lib/cohort/**` | the auto-pause the engine applies |
| `src/lib/api/**` | the bearer check every cron route runs |
| `supabase/migrations/**` | the schema the engine depends on |
| `src/app/api/**` | every API route the cron wrappers and the operator hit |
| `scripts/*-cron.sh` | the cron wrappers |
| `scripts/cohort-report.ts`, `scripts/canonical/deploy-*.ts`, `scripts/canonical/m1-progress.ts`, `scripts/canonical/validate-algo.ts`, `scripts/canonical/validate-preregistration.ts`, `scripts/canonical/capture-broker-spread.ts`, `scripts/canonical/snapshot-broker-health.ts`, `scripts/canonical/lib/pinned-eval.ts` | the scripts the crons run and the baseline harness library |

**Not fenced:** `ops/**` and `scripts/ops/**`. They are infrastructure, not behaviour. Their protection is the one they already have: `shellcheck -S warning` in `make lint-shell`, lint-staged and CI; a fresh-context review on every PR that touches them; and the operator's approval of every command that runs on the host (`make deploy`, `make status` and `make logs` all prompt). This removal is permanent, not a Phase D exemption. `QT_ALLOW_LIVE_EDITS` stays unused until the audit verdict.

Relative to 0004's list, this decision **adds** `src/lib/algorithm/**`, `src/lib/patterns/**`, `src/lib/market-data/**`, `src/lib/validators/algorithm.ts`, `src/lib/constants/markets.ts`, `src/lib/constants/prop-firm.ts`, `src/lib/constants/defaults.ts`, `src/lib/cohort/**`, `src/lib/api/**` and `supabase/migrations/**`: they implement the categories the operator named (strategies, risk, sizing, the engine's migrations, the paper engine's config). The operator strikes any of these at the next check-in if the mapping is too wide; the cost of a wrong inclusion is one stop-and-ask, the cost of a wrong exclusion is a silent behaviour change during the freeze.

## Why

PR #309 fenced the deploy scripts it introduced, and the fence then blocked the review fixes to those same scripts: decision 0004's condition says no session lifts the fence before the verdict. The operator ruled that the fence was never about infrastructure. Deploy scripts cannot change a trade; they can break the host, which review, CI and the per-command approval catch.

## Alternatives considered

- A Phase D exemption with the fence restored afterwards: rejected by the operator — temporary rules are the thing this project avoids.
- An override session (`QT_ALLOW_LIVE_EDITS=1`): rejected — the override stays unused until the verdict.
- Keeping 0004's list unchanged apart from the removal: the operator's definition names risk, sizing, strategies, migrations and paper-engine config, which 0004's list did not cover; recording the definition without the paths would leave the fence narrower than the decision.

## Consequences

- `docs/decisions/0004` stands, amended: the "deploy scripts" item is gone and the list above is the list. `CLAUDE.md`, `docs/DEV_SETUP.md` §16 and the hooks' refusal messages say "trading code".
- The hook tests pin the new scope: ops paths allowed, the added paths blocked (`tests/hooks/cases.ts`).
- Colocated `*.test.ts` files under the fenced directories are fenced too; a test change there during the freeze is a stop-and-ask.
