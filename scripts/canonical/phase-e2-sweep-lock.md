# Phase E2 Sweep Pre-Registration Lock

**Sweep ID:** `phase-e2-2026-06-24`
**Registered at:** 2026-06-24T15:00:00Z
**Status:** ACTIVE — sweep in progress (no candidates promoted yet)

This document is the **immutable pre-registration** for the Phase E2
re-search launched 2026-06-24 after F + F2 + H.4b empirical work
confirmed the v3 survivor fails F2 robustness gates. The binding artifact
is the code state at commit time (referenced below); this markdown is
the operator-readable summary.

Per `[[feedback_no_presupposed_features]]`, this sweep enumerates
features as discoverable axes — no signal feature is hardcoded as a
required base condition. Per `[[feedback_gold_only_demo_stage]]`, the
universe enumerates all 4 instruments but acceptance-packet filtering
restricts deploy candidates to gold-only until ≥1 stable gold demo
player exists.

---

## Universe (CORRECTED 2026-06-24 EVE — gold-only, after operator pushback)

| Axis | Cardinality | Detail |
|---|---|---|
| Instruments | **1 (XAU/USD)** | Gold-only per `[[feedback_gold_only_demo_stage]]`. Earlier "all 4 enumerated + filter at acceptance" framing was a methodology error (scope decision conflated with no-pre-supposition). Forex enumeration opts in via `ENABLE_FOREX_SEARCH=1` env var ONLY after ≥1 stable gold demo player exists. |
| Timeframes | 3 | 30m, 1h, 4h |
| Patterns | 17 | 14 from original spec + 3 added by H.4c (inside_bar, outside_bar, doji) |
| Directions | 2 (per pattern, with exemptions) | long + short for 14 patterns; long-only for ote + doji; 4h-only for asian_range_break |
| **Layer A cells** | **92** | gold-only: 14 L+S × 3 TFs × 2 dirs (84) + 2 long-only × 3 TFs (6) + 1 4h-only × 2 dirs (2) = **92** |
| Layer B variants per cell | 96 | 4 rr × 3 lb × 2 risk × 2 regime_filter × 2 adx_filter (`src/lib/algo-search/layer-b-enumerate.ts`) |

**Empirical correction:** the E2.3 sweep ran against all 368 cells (276 forex + 92 gold) before this correction. The 276 forex `backtest_results` rows remain in DB as audit trail but are EXCLUDED from E2.4/E2.5/H.4b downstream per `[[feedback_gold_only_demo_stage]]`. Bonferroni denominator for ship deflation = 92 (gold cells only), NOT 368.

## Data (per H.0 extension)

| Cache | Bars | Span | Earliest |
|---|---|---|---|
| XAU/USD 4h | 19979 | 10.5 years | 2015-12-31 |
| XAU/USD 1h | 39524 | 6.46 years | 2020-01-01 |
| Other instruments | (varies) | (legacy cache; not extended in H.0) | — |

## Methodology lock

| Artifact | Commit hash | Date |
|---|---|---|
| `algo-search.spec.md` v3 (criteria 1-10) | `187aa9a` | 2026-06-23 (H.7 last touch) |
| `criteria.ts` (SEARCH_LAYER_A_CRITERIA + DEFLATED_CRITERIA) | `0850f5e` | 2026-06-24 (F2 + H.4-methodology-revision shipped) |
| `enumerate.ts` (universe definition) | `0850f5e` | 2026-06-24 (H.4c added inside_bar + outside_bar + doji) |
| `layer-b-enumerate.ts` (96-variant grid) | unchanged from G.5 | 2026-06-23 |

Modifying ANY of those files between sweep launch and acceptance packet
constitutes a re-registration — would invalidate post-hoc-locked
discipline.

## Bonferroni denominator (gold-only)

`Layer A cells × statistical tests per cell = 92 × 1 = 92`

`Family alpha 0.05 ÷ 92 = 0.0005435 per-test`

Validators compute this automatically via `enumerateLayerACandidates().length` (gold-only by default; opts to forex via `ENABLE_FOREX_SEARCH=1`); do not hardcode. The 0.0005435 per-test threshold is LOOSER than the prior 0.0001359 (used when sweep was 368-cell) — gold-only sweep is less penalized by selection bias, meaning candidates need a less-extreme p-value to clear Bonferroni.

## OOS cutoff

`2025-06-18` — 12-month held-out per `[[feedback_oos_cutoff_sweet_spot]]`.

## Acceptance criteria (locked from criteria.ts)

### Per-candidate (criteria 1-7; floor)

| # | Criterion | Threshold |
|---|---|---|
| 1 | total_return | > 0 |
| 2 | total_trades | ≥ 30 |
| 3 | max_static_dd_pct | ≤ 10 (FTMO) |
| 4 | max_daily_dd_pct | ≤ 5 (FTMO) |
| 5 | mean_r_ci_lower (95% block bootstrap) | > 0 |
| 6 | min_oos_held_out_trades | ≥ 10 |
| 7 | max_oos_r_delta_pct | ≤ 50 (absolute) |

### Deflated (criteria 8-10; ship-readiness)

| # | Criterion | Threshold |
|---|---|---|
| 8 | DSR (Bailey/López de Prado deflated Sharpe) | ≥ 0.95 |
| 9 | PBO (CSCV probability of backtest overfitting) | < 0.5 |
| 10 | purged k-fold consistency | ≥ 4/5 (= 0.8 pass ratio) |

### Robustness gates (F2; locked in robustness-* driver scripts)

| Sub-gate | Threshold |
|---|---|
| F2.1 multi-cut OOS | ≥3/4 cuts pass per-candidate AND ≥2/4 cuts rank top-3 by Sharpe |
| F2.2 pattern leave-N-out | ≥3 non-survivor patterns also pass at survivor's cell |
| F2.3 bootstrap-bars | survivor in top-3 in ≥6/10 block-bootstrap seeds (block_size=24) |
| F2.4 alt-objective | survivor top-3 under ≥2/3 alternatives (Calmar / trimmed mean R / recovery factor) |
| **Aggregate** | **≥3/4 sub-gates PASS** |

## Post-sweep workflow

1. **E2.4** — Phase F deflation (`revalidate-candidates.ts` → DSR + PBO + k-fold) on each per-candidate-passer (criteria 1-7)
2. **E2.5** — Phase F2 robustness audit (`robustness-aggregate.ts` → 4 sub-gates) on each F-survivor (criteria 8-10)
3. **H.4b proper** (stepwise feature addition; PENDING BUILD) on each F+F2-survivor — augments with top-K features as binary axes; re-deflates against augmented family
4. **G.6 re-stamp** — operator decision, ONLY for candidates that pass un-augmented F+F2 AND/OR stepwise-augmented F+F2

## Scope filter (CORRECTED 2026-06-24 EVE)

Per `[[feedback_gold_only_demo_stage]]`, the sweep ENUMERATES gold-only at the enumerator level (`enumerateLayerACandidates()` filters to XAU/USD by default; `ENABLE_FOREX_SEARCH=1` opts in). E2.3 ran 368 cells before this correction; the 276 forex `backtest_results` stay in DB as audit but downstream gates exclude them.

This is a SCOPE decision (operator's risk-management boundary), distinct from signal-feature pre-supposition (which IS forbidden per `[[feedback_no_presupposed_features]]`). Scope decisions are operator inputs to the search; signal features are search outputs.

**Earlier framing in this document** ("enumerates ALL 4 instruments but filters at acceptance") was wrong — operator clarified 2026-06-24 EVE: "we're only working on gold for now, why are we working on forex". Corrected: gold-only at enumerator. Forex enumeration triggers `[[feedback_multi_instrument_is_endpoint]]` review when operator declares it ready.

## Lineage

| Date | Event | Reference |
|---|---|---|
| 2026-06-24 LATE | Phase E2 spec filed in ROADMAP.md after operator approved 3 items | ROADMAP.md Phase E2 section |
| 2026-06-24 LATE | Pre-reg locked via this markdown + git commit of underlying spec/criteria/enumerate files | commits `187aa9a` + `0850f5e` |
| 2026-06-24 LATE | E2.1 smoke-test confirmed driver picks up extended cache + 368-cell universe + H.4c patterns | `MODE=list pnpm dlx tsx scripts/canonical/algo-search.ts` |
| 2026-06-24 LATE | E2.2 pre-reg lock filed (this document) | this file |
| 2026-06-24 EVE | E2.3 sweep ran against 368 cells before gold-only correction; 276 forex backtests wasted but stay in DB as audit | `/tmp/e2.3-sweep.log` |
| 2026-06-24 EVE | Operator pushback: "we're only working on gold for now, why are we working on forex" | conversation |
| 2026-06-24 EVE | Gold-only enforced at enumerator (`enumerate.ts` default-filters to XAU/USD; `ENABLE_FOREX_SEARCH=1` opts in); Bonferroni denominator drops 368 → 92 | this commit |
| 2026-06-25 EVE | H.9 BO gate test FALSIFIED — all 4 candidates (grid+BO × ARB+Engulfing) fail F2 strict aggregate. ROADMAP E2.7/E2.8/E2.9 filed | h9-gate-verdict-2026-06-25.md |
| 2026-06-29 | E2.7 cluster-stability F2.3 sub-gate pre-registration appended (this commit, BEFORE empirical re-evaluation run); parameters locked: TOP_K=3, GATE_THRESHOLD=6/10, METRIC=set-intersection≥1, COMPOSITION=PASS iff point-OR-cluster | this commit |

---

## E2.7 Pre-registration Addendum — Cluster-stability F2.3 sub-gate (LOCKED 2026-06-29 BEFORE empirical run)

**Why this addendum exists:** the N=4 H.9 gate test (2026-06-25 EVE) empirically established that at gold-only 4h retail data depth, parameter surfaces are flat-CLUSTER (peak regions 4-10 variants tied within 0.02-0.05 Sharpe), not flat-LINE. F2.3 point-stability ("does THIS specific variant stay top-3 under bar resampling?") is structurally incompatible with cluster surfaces — under resampling, within-region variants reshuffle stochastically → named survivor drops to rank 10-22/40 even when its absolute resampled Sharpe is high. This addendum adds a cluster-stability sub-gate as an ALTERNATIVE PASS PATH (composition, NOT replacement of point-stability), pre-registered with parameters LOCKED before any empirical re-evaluation.

**New gate definition (cluster-stability F2.3-C):**

> For seed s, compute top-K variants by per-trade Sharpe on (a) the REAL bars and (b) the RESAMPLED bars (block-bootstrap with the seed). Cluster-stability passes for seed s iff
>
>   `|original_top_K ∩ resampled_top_K| ≥ MIN_INTERSECT`
>
> i.e. at least MIN_INTERSECT of the original top-K variants is still in the resampled top-K. Aggregate cluster-stability passes iff `cluster_pass_count ≥ GATE_THRESHOLD` across N seeds.

**Pre-registered parameters (LOCKED; do NOT tune after empirical run):**

| Parameter | Value | Rationale |
|---|---|---|
| TOP_K | 3 | Same as point-stability; preserves "top quartile of best variants" semantic |
| MIN_INTERSECT | 1 | Most lenient cluster definition: ANY original-top-K variant survives. Stricter values (2 or 3) tested post-hoc would be data-snooped. |
| GATE_THRESHOLD | 6 of 10 seeds | Same as point-stability; same rigor on aggregate |
| BASE_SEED | 42 | Same as point-stability; shared bar resampling for direct comparison |
| N_RESAMPLES | 10 | Same as point-stability |
| BLOCK_SIZE | 24 bars (= 1 day at 4h) | Same as point-stability |

**Composition rule (LOCKED):**

`F2.3 overall PASS = (point-stability ≥ 6/10) OR (cluster-stability ≥ 6/10)`

Composition is OR, not AND, so cluster-stability provides an ALTERNATIVE PASS path. F2.3 only FAILS if BOTH point-stability AND cluster-stability fail.

**Rationale for OR composition (not AND or replacement):**
- AND (point AND cluster): mathematically stricter than point alone — guarantees no candidate could ever pass the gate without also passing point. Defeats the purpose.
- Replacement (cluster only, no point): weakens the gate for surfaces that DO have discriminating peaks (e.g., future forex H.4b candidates with feature-augmented signals may have steeper surfaces). Keeping point-stability preserves rigor for those cases.
- OR (this choice): adds an ALTERNATIVE pass path for cluster surfaces while preserving the gate for point surfaces. Methodology refinement that fits OBSERVED surface shape per `[[feedback_grid_search_flatness_at_retail_data]]` "rigor before relaxation" rule.

**E2.7 PASS criterion (LOCKED):** at least 1 of the N=4 candidates (Grid Engulfing rr3_lb6_r06, Grid ARB rr5_lb6_r1_rf0_af1, BO ARB bo_rr30_lb12_r45_rf1_af0, BO Engulfing bo_rr50_lb10_r98_rf1_af1) passes cluster-stability ≥ 6/10. If yes → that candidate's full F2 aggregate is recomputed with the new sub-gate and ships for G.6 stamp if aggregate ≥ 3/4. If no → E2.7 falsified, escalate to E2.8 (pre-registered threshold recalibration).

**Implementation lock:** the cluster-stability code is in `scripts/canonical/robustness-bootstrap-bars.ts` (commit hash to be added at E2.7 commit time). The cluster-stability gate runs IN ADDITION TO point-stability in a single pass — same backtests, same bars, just two aggregations of the same per-seed ranked list. No new compute cost vs the existing F2.3 run.

**Forensic-archive policy:** if these parameters are changed after the E2.7 empirical run completes, this entire addendum becomes invalid — copy to `phase-e2-sweep-lock.archive.md` and start a new pre-registration with E2.7v2.

**End of pre-registration lock.** Modifying this document after sweep launch constitutes a forensic-archive event — copy to `phase-e2-sweep-lock.archive.md` first.
