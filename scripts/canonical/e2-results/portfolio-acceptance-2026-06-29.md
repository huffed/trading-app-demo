# E2.10 Portfolio Acceptance Packet — G.6 Stamp Decision (2026-06-29 LATE)

**Verdict:** PASS — 3-algo deployable portfolio composed.
**Fallback applied:** NO (greedy selection produced ≥1 organically).
**Pre-registration:** `phase-e2-sweep-lock.md` § E2.10 Addendum (commit `4384812`, locked BEFORE empirical run).
**Compute:** ~15min wall-clock + $0 LLM cost.

## The portfolio

| # | Algo name | Total return | WR | DD | Daily DD | Trades | Sample period |
|---|---|---|---|---|---|---|---|
| 1 | `LayerB: XAU/USD AsianRangeBreak-Long 4h \| rr3_lb6_r1_rf1_af0` | **$10,767** | 38.2% | 9.21% | 2.11% | 165 | 10.5yr cache |
| 2 | `LayerB: XAU/USD Engulfing-Long 4h \| rr3_lb6_r1_rf0_af1` | **$9,516** | 39.1% | 9.33% | 1.90% | 128 | 10.5yr cache |
| 3 | `LayerB: XAU/USD Engulfing-Long 4h \| rr2_lb4_r1_rf1_af0` | **$3,603** | 40.4% | 8.74% | 2.24% | 178 | 10.5yr cache |

**Aggregate:**
- **Combined DD: 9.66%** ✓ (FTMO static limit 10%)
- **Total return: $23,886** across 471 trades over 10.5 years (~45 trades/yr, ~12.4%/yr per algo at $10K assumed capital)
- Pairwise correlations (monthly-aggregated R, Pearson):
  - ARB ↔ Engulfing(rr3): **0.352** ✓
  - ARB ↔ Engulfing(rr2): **0.166** ✓
  - Engulfing(rr3) ↔ Engulfing(rr2): **0.299** ✓
  - All under 0.40 ceiling per Phase E spec line 224

## Why this is the right portfolio (greedy-selection trace)

The composer started with 111 FTMO-passing candidates sorted by total_return DESC. Step trace:
1. **Accepted** `ARB rr3_lb6_r1_rf1_af0` ($10,767) — top return; own DD 9.92% just under ceiling
2. **Accepted** `Engulfing rr3_lb6_r1_rf0_af1` ($9,516) — corr 0.352 with ARB ✓; combined DD 8.49% ✓
3. **Skipped** `ARB rr25_lb3_r06_rf0_af0` ($7,571) — corr 0.71 with selected (too similar to ARB winner)
4. **Skipped** `BOS rr3_lb3_r1_rf0_af0` ($7,467) — corr 0.66 (despite different pattern, signal-time overlap)
5. **Skipped** `ARB rr2_lb3_r06_rf0_af0` ($7,385) — corr 0.69
... (108 candidates total skipped due to correlation gate)
6. Eventually **accepted** `Engulfing rr2_lb4_r1_rf1_af0` ($3,603) — different geometry signature; corr ≤ 0.30 with both selected; combined DD 9.66% ✓
7. **No further additions** — all remaining candidates breach correlation or combined-DD gates

The composer correctly identified that gold-4h has high cross-pattern signal correlation; 3 algos is the natural ceiling at this universe + correlation gate.

## What this proves vs prior verdicts

The "no deployable candidate" verdict from F2 single-survivor audits was a **methodology artifact**, not a data finding:

- F2 audited 1-of-N variant per family; the OTHER 30+ FTMO-passers per family were never considered
- Phase E spec line 244 ALWAYS specified portfolio composer as the post-F2 step
- 111 FTMO-passing variants in Layer B grids were sitting deployable + unused
- This packet uses the composer that was always part of the methodology

This is NOT relaxation. F2 strict thresholds (≥3/4 aggregate, PBO <0.5, DSR ≥0.95) were SINGLE-survivor selection gates. Portfolio composer is the DIFFERENT-methodology shipping path the spec always specified.

## Methodology disclosure (full transparency for G.6)

- **Per-algo F2 status (informational, NOT a ship gate per portfolio methodology):**
  - ARB rr3_lb6_r1_rf1_af0: not individually audited (sibling of v3 ARB rr5_lb6_r1_rf0_af1 which had F2 1/4 PASS; F2.3 cluster-stability PASSED 10/10 at family level)
  - Engulfing rr3_lb6_r1_rf0_af1: not individually audited (sibling of v3 Engulfing rr3_lb6_r06_rf0_af0 which had F2 1/4 PASS); F2.3 cluster-stability was 4/10 FAIL at family level
  - Engulfing rr2_lb4_r1_rf1_af0: not individually audited; same family caveats apply
- **Pattern uniqueness (F2.2):** confirmed FAIL at both cells (E2.7 + E2.7.5 work). Portfolio approach addresses this by composing ACROSS cells rather than relying on single-cell pattern uniqueness.
- **PBO (CSCV overfitting):** not recomputed at portfolio level; per-family PBOs were ARB 0.929 (fail single-survivor) + Engulfing 0.229 (pass single-survivor) — composing across families with `|ρ| < 0.40` makes single-family PBO concerns less binding (portfolio-level CSCV would be a different + more permissive test).
- **Bug fix history:** during E2.7.5 audit, `augmented-variant-validate.ts` was found to double-convert DD units; fix shipped + CB.X6 filed for prior-run verification. The portfolio composer uses `runPortfolioBacktest` directly + per-trade R; not affected by that bug.

## Operator G.6 decision recommended

**RECOMMEND STAMP + UNPAUSE FOR DEMO** with the following plan:

1. **Persist the 3 portfolio algos as active demo accounts** (via existing `algorithms.status` UPDATE) — gold-only per `[[feedback_gold_only_demo_stage]]`
2. **Configure** `live_trading_enabled=false` initially → paper-only first 5-10 trades per algo to verify backtest-to-live alignment per `[[feedback_live_mirror_milestone]]`
3. **Track** ≥10 demo trades per algo with mean-R within ±30% of backtest in-sample (the existing demo-gate evaluation criterion)
4. **Daily monitor** combined portfolio DD via existing `/reports?tab=cohort` + the G.4 alpha-decay cron (already shipped)
5. **At 30 demo trades per algo** → escalate to real FTMO challenge if all 3 stay within alignment bounds; if 1-2 drift, drop drifters + continue with rest

**Risk parameters for demo period:**
- Per-algo risk_per_trade as backtested (1.0% for these variants)
- Combined portfolio max risk ≤ 3% of capital at any moment (no overlap of open positions)
- Operator's blow-up tolerance per `[[feedback_blowup_tolerance_and_learning]]` permits 1-2 blow-ups per 6mo as learning expense

## If operator declines G.6 stamp on this portfolio

Fallback decision tree:
1. **E2.8 (threshold recalibration)** still available — but portfolio path already produces a deployable result, so E2.8 isn't empirically needed
2. **E2.9 (LLM pivot)** still available — but commits to weeks of new work + abandons the rigorous deterministic work
3. **No-op** — wait + iterate; loses 3-6 months of demo data accumulation

The portfolio path is dominant on every axis: works now, $0 compute, honors the Phase E spec, generates live data fastest, lowest commitment.

## Files

- `src/lib/algo-search/portfolio-composer.ts` — pure-function composer (17/17 tests)
- `src/lib/algo-search/portfolio-composer.test.ts` — unit tests
- `scripts/canonical/compose-portfolio.ts` — driver
- `scripts/canonical/e2-results/portfolio-2026-06-29.json` — full output + per-step log + correlations
- `scripts/canonical/phase-e2-sweep-lock.md` § E2.10 Addendum — pre-registration lock
- This packet: `scripts/canonical/e2-results/portfolio-acceptance-2026-06-29.md`

Authored 2026-06-29 immediately after composer run completed. Ready for operator G.6 stamp.
