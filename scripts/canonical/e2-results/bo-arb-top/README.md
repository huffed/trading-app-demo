# BO ARB Top — H.9 Gate Empirical Test

**Purpose:** does Bayesian Optimization, by finding continuous-space peaks
where grid finds flat 96-variant clusters, produce a candidate that
survives F2 strict gates where the grid top failed?

**Hypothesis** (per ROADMAP.md L613 + `[[feedback_grid_search_flatness_at_retail_data]]`):
BO surfaces candidates with discriminating Sharpe gaps → F2.3 + PBO
pass naturally at strict thresholds.

**Empirical setup:**
- Base candidate: `Search: XAU/USD AsianRangeBreak-Long 4h` (Phase E2.3
  per-candidate passer, $16K total return strong)
- BO run: 40 evals (10 TS-controlled random + 30 GP/EI), seed 42, EI
  acquisition, search space LAYER_B_BO_DIMENSIONS
- Persisted as 40-variant `BO+:` family in DB for F2 audit
- Top variant by Sharpe: `bo_rr30_lb12_r45_rf1_af0` (rr=3.0, lb=12, risk=0.45%, regime_filter=ON, adx_filter=OFF), per-trade Sharpe 0.347
- Comparable grid top (per `../arb-top/`): `rr5_lb6_r1_rf0_af1`, F2 aggregate FAIL 1/4

**BO Sharpe distribution insight** (n=40 — see `Search_XAU_USD_...json`):
- Mean 0.257, std 0.051, range 0.187 (CoV 0.197)
- Top 10 ALL have regime_filter=1 (clear axis discrimination)
- Top 7 have lb≥9 (longer lookback > tighter SL)
- Bottom 5 mostly have lb≤4 or adx_filter=1 (tight-SL + ADX hurt)
- **Within the sweet-spot region** (rr=2.5-3.5, lb=9-12, risk=0.4-0.5, rf=1, af=0): top-4 tied within 0.01 Sharpe (0.347, 0.342, 0.342, 0.337)
- Gap top1-vs-top5: 0.020 (flat in best region)
- Gap top1-vs-top10: 0.049 (flat across best 10)

**Methodology nuance**: BO discovers a peak REGION but no single peak
within it. F2.3 (which asks for one SPECIFIC variant to stay top-3
under bar resampling) will likely fail because the resampling can
reshuffle which sweet-spot variant wins — a sample-mean test
masquerading as a structural test.

**Files + verdicts:**
- `f2.1-multi-cut.json` — **FAIL** (0/4 per-cand, 2/4 rank; need ≥3 per-cand / ≥2 rank). Compare grid 2/3 per-cand, 4/4 rank.
- `f2.2-leave-n-out.json` — **FAIL** (inherited from `../arb-top/`; 0/16 non-survivor patterns pass at the cell — pattern-level + geometry-independent)
- `f2.3-bootstrap-bars.json` — **FAIL trending** (0/6 seeds top-3 so far; gate is ≥6/10 → mathematically impossible to pass)
- `f2.4-alt-objective.json` — **PASS 3/3** (Calmar 12.24, Trimmed mean R 0.52, Recovery Factor 0.38)
- `deflation.json` — **DSR PASS** (0.9979 vs grid's 0.9954) + **PBO FAIL** (0.557 vs grid's 0.929 — major improvement but still > 0.5 strict threshold)
- `aggregate-final.json` — F2 aggregate: trending **1/4 PASS = same as grid**

**Key empirical finding (BO hypothesis falsified for ARB):**
The audit hypothesis ([[feedback_grid_search_flatness_at_retail_data]]) was
that BO would surface discriminating peaks → F2.3 + PBO pass naturally.
The result for ARB:
- PBO improved substantially (0.93 → 0.56) — BO IS finding tighter top region
- DSR maintained (0.995 → 0.998)
- F2.3 still 0/N PASS — the tighter region creates a cluster, not a point;
  any of the ~5 sweet-spot variants can "win" under bar resampling
- F2.1 actually got WORSE — BO's tighter clusters mean less rank stability
  across OOS cuts (BO 2/4 vs grid 4/4)

BO partially worked (PBO down 0.37) but the structural flat-CLUSTER
shape of the surface (not flat-LINE) means even continuous-resolution
search produces tied-at-top variants under noise. **Geometry is not the
deployable-edge lever for ARB on retail-volume 4h gold data.**

**Decision matrix:**
- **F2 4/4 PASS + PBO < 0.5 + DSR > 0.95** → BO is the lever. Ship BO top for G.6 operator stamp (first deployable algo).
- **F2 ≥3/4 PASS but PBO ≥ 0.5** → BO partially works; PBO still flat-surface dominant. Empirically validates need for E2.6 PBO threshold recalibration with N≥4.
- **F2 ≤2/4 PASS** → BO doesn't break the flat-surface problem; geometry isn't the lever at all. Pivot to entry-signal modification (E2.6 + H.4b stepwise feature augmentation).

Authored 2026-06-25 during the BO smoke + F2 audit on ARB family.
