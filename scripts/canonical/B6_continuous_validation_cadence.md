# B.6 — Continuous validation cadence

Stage 4.7 deliverable (2026-06-20). Defines how often `validate-algo` is
re-run + how the holdout window evolves over time.

## Decision summary

| Cadence | Action | OOS holdout |
|---|---|---|
| **Weekly** (optional) | Per-algo `ALGO=NAME PERSIST=0` dry-run on the operator's go | Same as current (rolling 12mo) |
| **Monthly** (1st of month, UTC) | Full-fleet `PERSIST=1 pnpm dlx tsx scripts/canonical/validate-algo.ts` | Rolling 12mo (`OOS_CUTOFF=today-12mo`) |
| **Quarterly** (1st of Jan/Apr/Jul/Oct) | Full-fleet re-run + pre-registration sweep audit (see below) | Same — rolling 12mo |
| **Annually** (1st of Jan) | Full-fleet re-run + methodology audit (reconsider POOL_CAP_PCT, BOOTSTRAP_ITERATIONS, FAMILY_ALPHA) | Same — rolling 12mo |

## Why rolling 12-month holdout, not quarterly-re-roll-with-fresh-3mo

The original Phase B punch said "quarterly re-roll 3 months." Empirical
sweep (per `[[feedback_oos_cutoff_sweet_spot]]`) showed a 3-month holdout
produces 0 ELIGIBLE algos under current pre-registration floors — the
held-out N is too small for `min_held_out_trades` thresholds.

**Resolution:** the OOS HOLDOUT is rolling 12-month — fixed length, slides
forward as time advances. The CADENCE (how often validate-algo runs) is
independent. Running monthly produces fresher verdicts; the holdout
length stays scientifically defensible.

The `OOS_CUTOFF` env var defaults to `2025-06-18` (hardcoded literal —
B.6.3 punch is to derive dynamically). Until B.6.3 lands, the operator
or cron entrypoint must compute today−12mo manually and pass
`OOS_CUTOFF=YYYY-MM-DD`.

## Cron entries (operator's Mac crontab — add when adopting)

Current production crons (per scripts/README.md):
- `manage-cron.sh` every 5 min
- `scan-cron.sh` every 15 min
- `heartbeat-cron.sh` every 5 min
- `oanda-positioning-cron.sh` every 20 min
- `prune-sentiment-cache-cron.sh` daily 04:00 UTC

**Proposed addition for B.6:**

```cron
# B.6 monthly fleet validation. 1st of each month, 06:00 UTC (after Asia
# closes, before London opens — quiet window). Output captured to a
# rolling log; operator reviews next morning.
#
# Date arithmetic note: macOS BSD `date` uses `-v-12m`; Linux GNU `date`
# uses `-d "12 months ago"`. The `||` fallback covers both so the same
# cron line works if the operator ever migrates the cron to Linux.
0 6 1 * * cd /Users/jack.jones/Documents/trading-app/demo-1 && \
  OOS_CUTOFF=$(date -u -v-12m +\%Y-\%m-\%d 2>/dev/null || date -u -d '12 months ago' +\%Y-\%m-\%d) \
  PERSIST=1 pnpm dlx tsx scripts/canonical/validate-algo.ts \
  > /tmp/validate-algo-$(date -u +\%Y\%m\%d).log 2>&1
```

Or wrap in a shell script for consistency with the other crons:
- `validate-algo-monthly-cron.sh` in `scripts/`
- Includes the `OOS_CUTOFF=today-12mo` derivation (with the cross-platform
  `||` fallback above), log rotation, and HEARTBEAT_PING_URL on success

## Quarterly pre-registration sweep audit

On 1st of Jan/Apr/Jul/Oct, run:

```bash
# Print every prereg entry's distance-to-expiry + last-passed-status
pnpm dlx tsx scripts/canonical/audit-preregistrations.ts
```

This script doesn't exist yet — file as **Stage 4.7.1**. Spec:
1. Load `scripts/canonical/preregistration.json`
2. For each entry: `(distance_to_expiry_days, last_validate_pass_or_fail, last_run_at)`
3. Highlight entries within 30d of expiring — operator decides whether to
   re-register (with new `registered_at`) or let them lapse
4. Highlight entries that PASSED in the last fleet run but the algo is
   still `status='paused'` — eligibility-but-not-deployed gap

## Annual methodology audit (Jan)

Each January the operator reviews:
1. **OOS_CUTOFF length** — does 12mo still produce balanced eligibility?
   Re-run the empirical sweep across {3, 6, 9, 12, 15, 18} months.
2. **POOL_CAP_PCT** — has FTMO's DLL changed? Has the operator's blow-up
   tolerance shifted? Per `[[feedback_3_phase_b_decisions]]` the 4% cap
   was chosen as 1% buffer below FTMO 5% DLL; re-derive if either
   threshold moves.
3. **BOOTSTRAP_ITERATIONS** — 2000 is the current default. Bump to 5000
   if any algo's CI bounds materially shift run-to-run (would indicate
   instability at the current iteration count).
4. **FAMILY_ALPHA** — 0.05 family-wise. Tighten to 0.01 if false-positive
   ELIGIBLE algos appear in live trading (Stage 5 → Phase D feedback).
5. **BONFERRONI_STATISTICAL_TESTS_PER_ALGO** — currently 1 (one mean-R
   test per algo; per `feedback_3_phase_b_decisions` Decision 1). Revisit
   if the algo count grows past 30 (Bonferroni's conservatism eats power
   too aggressively at high N — alternatives: Benjamini-Hochberg FDR).

## What this REPLACES

The original B.6 spec ("quarterly re-roll 3 months") is superseded by
the 12mo rolling holdout reconciliation per Stage 2B.3 + this doc. The
cadence (monthly/quarterly/annual actions above) is what continues.

## Cross-references

- `[[feedback_oos_cutoff_sweet_spot]]` — 12mo derivation
- `[[feedback_3_phase_b_decisions]]` — POOL_CAP_PCT + Bonferroni decisions
- `project_roadmap_2026_06.md` Phase B.6 — original cadence spec
- `scripts/README.md` validate-algo.ts env vars — full env reference
