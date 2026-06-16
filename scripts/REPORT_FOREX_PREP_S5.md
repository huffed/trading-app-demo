# Forex prep for S5 — initial sweep (S1.5 priority #3)

**Date:** 2026-06-16 PM
**Trigger:** Per-ticker decomp (PR #255) showed XAU is the only instrument with positive non-cluster expectancy on the gold-tuned spec base (swing_anchor 0.10/4 + rr_multiple 3). Roadmap question: "with forex-tuned geometry (pct SL ~0.3-0.5%), does non-cluster expectancy flip positive?"
**Cost:** $0 (replay across 6yr 4h corpus for all 3 majors).
**Status:** Research output — defines path to S5 deploys, NOT a deploy.

---

## Methodology

`scripts/sweep-forex-prep-s5.ts` runs the 4h walk-forward across:

| Axis | Values |
|---|---|
| Pair | EUR/USD, GBP/USD, USD/JPY |
| Strategy | coil_breakout (bos+daily_bias), dip_buyer (sweep+daily_bias), fvg_dailybias (fvg+daily_bias) |
| Geometry | swing_anchor 0.10/4 (gold baseline), pct 0.30%, pct 0.50% |
| RR | 2, 3, 5 |
| Variant | ungated baseline, gated with V1.2 cluster gate enforced |

Total: 3×3×3×3×2 = 162 backtests over 2020→2026 4h corpus (~10K bars/pair).

---

## Headline: ALL 3 PAIRS PROFITABLE with forex-tuned geometry

Best gated cell (non-cluster expectancy) per pair, all `fvg_dailybias` + `pct-0.30%` SL + `rr=2`:

| Pair | Return | Trades | Green % | Worst DD |
|---|---|---|---|---|
| EUR/USD | $44,310 | 262 | 63% | 3.55% |
| GBP/USD | $49,719 | 256 | **81.5%** | 2.96% |
| USD/JPY | **$147,933** | 407 | **89.5%** | 4.15% |

**USD/JPY's $147K is 4.6× the 6yr gold baseline** (`Library: Gold FVG-DailyBias-Long 4h` rr=2 = $32,372). EUR/USD and GBP/USD both beat gold at lower magnitudes.

The roadmap intuition is confirmed: forex needs forex-tuned geometry. The gold-tuned `swing_anchor 0.10/4` either matches or underperforms `pct-0.30` on every forex pair.

---

## Per-year decomposition (top cells, gated)

### EUR/USD fvg_dailybias pct-0.30 rr=2 = $44,310

| Year | Return |
|---|---|
| 2020 | **$18,031** (COVID dollar weakness) |
| 2021 | $577 |
| 2022 | $3,579 |
| 2023 | $9,138 |
| 2024 | $5,950 |
| 2025 | $3,424 |
| 2026 | $3,611 |

Positive every year. 2020 contributes ~40% — concentration concern but rest is steady.

### GBP/USD fvg_dailybias pct-0.30 rr=2 = $49,719

| Year | Return |
|---|---|
| 2020 | **$19,922** (COVID dollar weakness) |
| 2021 | $3,524 |
| 2022 | $2,332 |
| 2023 | $8,299 |
| 2024 | $8,435 |
| 2025 | $2,985 |
| 2026 | $4,222 |

Positive every year. 2020 contributes ~40% — similar pattern to EUR/USD.

### USD/JPY fvg_dailybias pct-0.30 rr=2 = $147,933

| Year | Return |
|---|---|
| 2020 | $7,044 |
| 2021 | $22,380 |
| 2022 | **$54,648** (yen crash year) |
| 2023 | $26,988 |
| 2024 | $17,877 |
| 2025 | $10,899 |
| 2026 | $8,097 |

Positive every year. 2022 contributes ~37% — but **every other year is also strongly positive**, including 2026 YTD. This is the strongest per-year persistence of any S5 candidate.

---

## Cross-strategy findings

Strategy fit is highly asymmetric across forex pairs:

| Strategy | EUR/USD best | GBP/USD best | USD/JPY best |
|---|---|---|---|
| coil_breakout (bos+bias) | mixed (some +, some −) | **all negative** | all positive |
| dip_buyer (sweep+bias) | mixed positive | mixed positive | mixed positive |
| **fvg_dailybias (fvg+bias)** | **all positive** | **all positive** | **all positive** |

**fvg_dailybias is the universal winner.** Same primitive that wins on gold (PR #258) wins on every forex pair tested. This is the dual-source validation we look for: friend-replay says daily_bias + FVG are both winner-discriminators; backtest confirms across instruments.

**coil_breakout (BOS-driven) is strategy-specific.** Wins on USD/JPY (likely captures the structural yen weakness via breakout) but loses on GBP/USD. Not a universal forex strategy.

**dip_buyer (sweep-driven) is middle-tier.** Profitable across pairs but smaller magnitude than fvg_dailybias. Worth keeping as a sister candidate.

---

## V1.2 cluster gate impact on forex

For most cells, ungated vs gated return delta = $0 — the V1.2 cluster signature simply doesn't fall on the forex entry signals. This matches the per-algo falsification finding on gold (PR #260): V1.2 is a portfolio-level signal, not a per-algo enforcer.

Specifically: on the top USD/JPY cell, gated cost $2,076 of $150,009 (0.07% — noise). On EUR/USD top cell, gated cost $-2 (rounding). Per-algo V1.2 gate is non-binding here too.

**Implication for S5:** don't deploy forex algos WITH V1.2 per-algo gates. The portfolio-level V1.2 gate (future work item #2a in roadmap) remains the right architecture once design is done.

---

## What's NOT covered (required before deploy per CLAUDE.md 4-way bar)

The geometry grid is 1 of 4 mandatory pre-deploy validations. Owed for any candidate before APPLY=1:

1. **Friction test** — forex spread ~0.4-0.8 pips on majors; this sweep ran frictionless. Need to confirm headline numbers survive realistic execution costs. Likely degrades 5-10% but worth confirming.
2. **Cadence comparison** — 4h is the chosen TF; 1h/30m forex corpora exist but with reduced depth. Less critical (4h is deep enough for multi-regime).
3. **Per-window decomp** — Higher resolution than per-year. The 4-window step-40d windows over 6 years = ~58 windows / pair. Worth examining whether winning windows are clustered.
4. **Per-month / per-quarter check** — would catch a "best-cells-are-driven-by-N-monster-weeks" failure mode that aggregate stats hide.

---

## Recommendations (operator decision points)

### Strong S5 candidates (in priority order)

1. **USD/JPY `fvg_dailybias pct-0.30 rr=2`** — $147K / 89.5% green / 4.15% DD / positive every year. Strongest candidate.
2. **GBP/USD `fvg_dailybias pct-0.30 rr=2`** — $49.7K / 81.5% green / 2.96% DD / positive every year.
3. **EUR/USD `fvg_dailybias pct-0.30 rr=2`** — $44.3K / 63% green / 3.55% DD / positive every year.

### Don'ts (validated dead-ends on this geometry pass)

- **coil_breakout on EUR/USD or GBP/USD** — negative or marginal across all geometries.
- **V1.2 per-algo gate on forex** — no measurable lift; deploy ungated.

### Architecture decisions to make before deploying

1. **Which pair first?** — USD/JPY has the strongest backtest but also depends on yen-weakness regime continuing. EUR/USD or GBP/USD diversifies away from JPY-specific risk.
2. **One pair or three?** — three deploys = 3× the live config surface, ~30% more cron load. Worthwhile if diversification is the goal (per [[feedback_multi_instrument_is_endpoint]]).
3. **Live or paper first?** — strong backtest + dual-source validation + same strategy as proven gold candidate suggests paper-first is OVER-cautious. But CLAUDE.md 4-way bar is still mandatory before flipping live.
4. **Side (long vs auto)?** — this sweep is long-only. Per [[feedback_direction_split_first]], short side should be tested separately before considering `side: auto`.

---

## Path to S5 deploy (after this PR)

1. Operator picks 1-2 candidates from the strong list above
2. For each: complete the missing validations (friction + per-window decomp at minimum)
3. Deploy paper-only with `deploy-<algo>-<tf>.ts` style script (mirroring deploy-fvg-dailybias-long-4h.ts)
4. Observe ~30 days paper before any live consideration
5. Per [[feedback_iterate_only_validated_baselines]]: never flip live based on backtest alone, even with strong validation

---

## Connected memos

- [[project_roadmap_2026_06]] S1.5 priority #3 (this is the output)
- [[project_discovery_v1_findings]] V1.2 per-ticker decomp (set up the question)
- [[feedback_4_way_pre_deploy_validation]] (the canonical bar that's still owed)
- [[feedback_direction_split_first]] (short side untested)
- [[feedback_multi_instrument_is_endpoint]] (S5 is the endpoint, not optional)
- [[feedback_gold_always_in_mix]] (forex IS gold AND, not gold OR)
