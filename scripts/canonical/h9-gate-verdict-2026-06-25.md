# H.9 Gate — Empirical Verdict (ARB family, 2026-06-25)

**Question (ROADMAP.md L613):** Does Bayesian Optimization, by finding
continuous-space peaks where grid finds flat 96-variant clusters,
produce a candidate that passes the F2 strict-gate suite where the
grid top failed?

**Answer:** **NO — empirically falsified for ARB.**

## Results table — BO vs Grid on the ARB-Long 4h family

| Gate                          | Grid top (`rr5_lb6_r1_rf0_af1`) | BO top (`bo_rr30_lb12_r45_rf1_af0`) | Δ |
|-------------------------------|----------------------------------|--------------------------------------|---|
| In-sample per-trade Sharpe    | ~0.27                            | **0.347**                             | +29% |
| **DSR (deflated Sharpe)**     | 0.9954 ✓                          | **0.9979** ✓                          | +0.003 |
| **PBO**                       | 0.929 ✗                          | **0.557** ✗ (borderline)              | **−0.372 (major improvement)** |
| F2.1 multi-cut (per-cand)     | 2/3 ✗                            | 0/4 ✗                                 | worse |
| F2.1 multi-cut (rank top-3)   | 4/4 ✓                            | 2/4 ✗                                 | worse |
| F2.2 leave-N-out (pattern)    | FAIL                             | FAIL (inherited; geometry-independent) | — |
| F2.3 bootstrap-bars (top-3)   | 0/10 ✗                           | 0/10 ✗                                | unchanged |
| F2.4 alt-objective (3 obj.)   | 3/3 ✓                            | 3/3 ✓                                 | unchanged |
| **F2 aggregate (≥3/4)**       | **1/4 FAIL**                     | **1/4 FAIL**                          | unchanged |
| Trial pool size               | 96 grid variants                 | 40 BO evals                           | smaller |

## Interpretation

**What BO succeeded at:** PBO dropped from 0.929 → 0.557. BO's
continuous-space exploration genuinely found a TIGHTER region of the
parameter surface than the grid did. DSR improved marginally (already
high in both cases).

**What BO failed at:** the strict F2 gate set assumes a single peak,
not a peak REGION. The BO top variant lives in a cluster of ~5
sweet-spot variants (gap top-1 vs top-5 = 0.020 Sharpe). Under bar
resampling (F2.3), the within-cluster ranking is noise-dominated —
any of the ~5 cluster members can "win," dropping the nominated
survivor to rank 10-19/40 consistently. F2.1 (multi-cut OOS) got
WORSE for the same reason: BO's tighter cluster means less rank
stability across cuts.

**Structural finding:** the ARB-Long 4h surface on retail-volume 4h
gold data has a peak REGION, not a peak POINT. F2.3 + F2.1 test for
POINT robustness. BO can find the region but can't reduce a region
to a discriminating point — that's not a BO failure, it's the surface
geometry telling us geometry isn't the deployable-edge lever for this
pattern/instrument at this data volume.

## Hypothesis status

`[[feedback_grid_search_flatness_at_retail_data]]` predicted: "BO finds
discriminating peaks via continuous parameter resolution → F2.3 + PBO
pass naturally."

- "Discriminating peaks": **partially correct** — BO found a tighter
  best region (PBO −0.37), but the region itself has multiple
  near-tied variants
- "F2.3 passes naturally": **falsified** (0/10 → 0/10)
- "PBO passes naturally": **falsified at the strict 0.5 threshold**
  (0.557), though the IMPROVEMENT direction is correct

The hypothesis is mostly false. Updated mental model: at retail-volume
data, the SURFACE itself has flat plateaus around the best region;
search method (grid vs BO) affects how those plateaus are discovered
but cannot create a single point where the data has a cluster.

## Empirical N for E2.6 threshold-recalibration consideration — N=4 COMPLETE 2026-06-26 EVE

ROADMAP.md L687 gate for E2.6: "IF BO under STRICT thresholds still
produces 0 survivors, THEN E2.6 recalibration becomes the next-best
action with stronger empirical justification (N=2-from-grid +
N=2-from-BO observations)."

**N=4 final table:**

| Candidate | DSR | PBO | F2.1 | F2.2 | F2.3 | F2.4 | F2 Agg |
|---|---|---|---|---|---|---|---|
| Grid Engulfing rr3_lb6_r06 | 0.983 ✓ | 0.229 ✓ | n/a | 2/3 ✗ | 0/10 ✗ | (n/a) | 1/4 FAIL |
| Grid ARB rr5_lb6_r1_rf0_af1 | 0.995 ✓ | 0.929 ✗ | 2/3 ✗ + 4/4 rank ✓ | 0/16 ✗ | 0/10 ✗ | 3/3 ✓ | 1/4 FAIL |
| BO ARB bo_rr30_lb12_r45_rf1_af0 | 0.998 ✓ | **0.557 ✗** | 0/4 ✗ + 2/4 ✗ | 0/16 ✗ | 0/10 ✗ | 3/3 ✓ | 1/4 FAIL |
| BO Engulfing bo_rr50_lb10_r98_rf1_af1 | 0.971 ✓ | **0.814 ✗** | 2/3 ✗ + 2/2 ✓ | 2/13 ✗ | 0/10 ✗ | 1/2 ✗ | **0/4 FAIL** |

**Surprise empirical finding:** BO's PBO improvement is NOT universal.
ARB: BO went 0.929 → 0.557 (−0.37, improved). Engulfing: BO went
0.229 → 0.814 (+0.59, WORSE). BO converged to the high-rr=5.0 edge
of the search space for Engulfing → CSCV reads as MORE overfit-shaped.
Pair BO with cluster-stability F2.3 (E2.7), don't use either alone.

**N=2-from-grid: ✓ COMPLETE. N=2-from-BO: ✓ COMPLETE.** All four
candidates fail F2 strict gates. E2.6 (now READY-NOW) has full empirical
foundation, BUT per `[[feedback_grid_search_flatness_at_retail_data]]`
"rigor before relaxation" rule, the pre-registered ordering is:
E2.7 → E2.8 → E2.9. E2.6's prior framing is subsumed by E2.8
(threshold recalibration is just one lever, methodology refinement
comes first).

## Recommended next moves (operator decision)

In priority order, NOT mutually exclusive:

1. **Wait for Engulfing-BO** (~5min) — completes the N=2+2=4
   empirical base required by the roadmap. Don't commit to E2.6
   recalibration without it.

2. **E2.6 recalibration with cluster-aware F2.3** — propose a NEW F2.3
   variant ("any of the original top-K stay in the resampled top-K")
   in ADDITION to the original (not replacement). Pre-register the
   change in `phase-e2-sweep-lock.md`. Re-evaluate all 4 candidates
   under both old + new F2.3.
     - **Why this first**: methodology refinement to fit observed
       surface shape, not threshold relaxation. Honors
       `[[feedback_grid_search_flatness_at_retail_data]]` "rigor
       before relaxation" rule.

3. **E2.6 PBO threshold consideration** — at N=4 observations:
     - Grid Engulfing: PBO 0.93
     - Grid ARB: PBO 0.93
     - BO ARB: PBO 0.56
     - BO Engulfing: TBD
     If the average BO PBO is meaningfully below 0.5 across N=2 BO
     samples (Engulfing TBD), recalibrate strict gate to ≤0.6 with
     full empirical justification documented.

4. **Pivot to entry-signal lever** — H.4b stepwise feature
   augmentation already ran on Engulfing v3 with 0/4 F2 PASS. Even
   the entry-signal lever isn't producing deployable algos at our
   data volume. This says the limiting factor is the DATA itself
   (10yr 4h gold), not the methodology.

5. **Accept no-deploy + extend data window** — H.0 already extended
   gold to 10.5yr 4h. Further data extension would need higher-
   resolution intraday or new symbols (blocked by gold-only demo
   stage `[[feedback_gold_only_demo_stage]]`). This is the honest
   bottom of the decision tree.

## What this means operationally

The empirical conclusion after 4 substantial test runs is that the
QuantTrader pipeline, under quant-firm-grade F2 strict thresholds,
produces 0 deployable algos on the gold-only 4h universe at current
data depth. The methodology is sound. The data + thresholds
combination is the binding constraint.

The path forward IS NOT to abandon rigor (relax thresholds
arbitrarily). It IS to:
- Acknowledge the surface-shape finding empirically (clusters not
  points)
- Refine F2.3 to test cluster-stability alongside point-stability
- Recalibrate PBO based on N=4 empirical PBO observations
- THEN if a candidate emerges that passes the refined gates, ship it
  with full disclosure of the methodology change

This is the spirit of "rigor before relaxation": methodology
refinement that fits observed surface shape is rigor; threshold
relaxation without empirical justification is relaxation.

Authored 2026-06-25 during BO ARB F2 audit (this run) + BO Engulfing F2 audit (running).
