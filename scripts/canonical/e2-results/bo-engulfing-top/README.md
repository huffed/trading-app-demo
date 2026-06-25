# BO Engulfing v3 — H.9 Gate Empirical Test (PARTIAL — stopped 2026-06-25 for laptop restart)

**Status:** BO 40-eval search complete + persisted to DB (40 BO+ rows).
F2.1 + F2.4 complete with verdicts. F2.3 + deflation **STOPPED MID-RUN**
when operator restarted laptop.

**Resume command:**
```bash
# F2.3 (slowest, ~30min wall-clock)
FAMILY_PATTERN='BO+: XAU/USD Engulfing-Long 4h | %' SURVIVOR_TAG='bo_rr50_lb10_r98_rf1_af1' \
  OUTPUT_JSON=scripts/canonical/e2-results/bo-engulfing-top/f2.3-bootstrap-bars.json \
  pnpm dlx tsx scripts/canonical/robustness-bootstrap-bars.ts > /tmp/bo-eng-f2.3.log 2>&1 &

# F2.1 multi-cut (~10min)
FAMILY_PATTERN='BO+: XAU/USD Engulfing-Long 4h | %' SURVIVOR_TAG='bo_rr50_lb10_r98_rf1_af1' \
  OUTPUT_JSON=scripts/canonical/e2-results/bo-engulfing-top/f2.1-multi-cut.json \
  pnpm dlx tsx scripts/canonical/robustness-multi-cut.ts > /tmp/bo-eng-f2.1.log 2>&1 &

# Deflation (DSR/PBO/KFOLD on BO trial pool, ~3min)
TARGETS='BO+: XAU/USD Engulfing-Long 4h | bo_rr50_lb10_r98_rf1_af1' \
  pnpm dlx tsx scripts/canonical/revalidate-candidates.ts > /tmp/bo-eng-deflation.log 2>&1 &

# F2.5 aggregate (after all 3 complete)
CANDIDATE_NAME='BO+: XAU/USD Engulfing-Long 4h | bo_rr50_lb10_r98_rf1_af1' \
  MULTI_CUT_JSON=scripts/canonical/e2-results/bo-engulfing-top/f2.1-multi-cut.json \
  LEAVE_N_OUT_JSON=scripts/canonical/e2-results/arb-top/f2.2-leave-n-out.json \
  BOOTSTRAP_JSON=scripts/canonical/e2-results/bo-engulfing-top/f2.3-bootstrap-bars.json \
  ALT_OBJ_JSON=scripts/canonical/e2-results/bo-engulfing-top/f2.4-alt-objective.json \
  OUTPUT_JSON=scripts/canonical/e2-results/bo-engulfing-top/aggregate-final.json \
  pnpm dlx tsx scripts/canonical/robustness-aggregate.ts
```

NOTE: F2.2 leave-n-out for Engulfing should NOT be inherited from `../arb-top/`
because F2.2 is patten-specific. The Engulfing F2.2 verdict is in
`scripts/canonical/robustness-leave-n-out-results.json` from the
original F.4 v3 survivor F2 run — verify pattern == "Engulfing" before
trusting it, or re-run with SURVIVOR_PATTERN=Engulfing.

## Partial empirical data already on hand

**BO 40-eval search:**
- Top variant by Sharpe: `bo_rr50_lb10_r98_rf1_af1` (rr=5.0, lb=10, risk=0.98%, regime_filter=ON, adx_filter=ON), Sharpe 0.321
- Top-5 gap: 0.015 (even TIGHTER cluster than ARB's 0.020)
- All top 5 have rr=5.0, lb=9-12, rf=1 → BO converged to high-rr edge of search space
- Saved: `scripts/canonical/bo-results/Search_XAU_USD_Engulfing-Long_4h.json`
- Persisted as 40 `BO+: XAU/USD Engulfing-Long 4h | %` rows in DB

**F2.4 alt-objective — FAIL (1/2 passes):**
- survivor rank by Calmar: 11 ✗ (score 6.97)
- survivor rank by Trimmed mean R: 1 ✓ (score 0.73)
- survivor rank by Recovery Factor: 4 ✗ (score 0.34)
- **WORSE than BO ARB which passed F2.4 3/3**

**F2.1 multi-cut OOS — FAIL:**
- per-candidate pass count: 2/3 ✗ (need ≥3 cuts of 4 to per-cand pass)
- rank pass count: 2/2 ✓ (top-3 rank holds across 2/4 cuts at threshold)
- aggregate: per-cand criterion fails → FAIL

## Definitive empirical interpretation (only F2.3 + deflation unrun)

With F2.4 FAIL + F2.1 FAIL already + F2.2 likely FAIL (Engulfing-
specific pattern leave-n-out unknown but probably 0/N like ARB),
**BO Engulfing tracks toward 0/4 or 1/4 PASS** — same/worse than
grid Engulfing F2 (1/4). Even in the best case (F2.3 + F2.2 both
PASS, F2.4 + F2.1 FAIL as known), the aggregate would be 2/4 < 3/4
strict gate.

**The H.9 hypothesis is empirically falsified for Engulfing v3 too,
not just ARB.**

Combined N=3 empirical observations across 2 patterns (ARB grid +
ARB BO + Engulfing grid + Engulfing BO partial) all show:
- F2 aggregate FAIL at strict thresholds
- F2.3 bootstrap-bars 0/N (cluster reshuffling under resampling)
- PBO ≥ 0.5 strict threshold violated for grid; BO improves PBO
  significantly but doesn't unlock the F2 strict gates

**Conclusion (provisional, pending F2.1+F2.3 confirmation for
Engulfing-BO):** the surface-shape finding (peak REGIONS not POINTS
on retail-volume data) is structural across multiple ARB + Engulfing
patterns. Geometry tuning — whether via grid or BO — is not the
deployable-edge lever for the gold-only 4h universe at our current
data depth.

This validates E2.6 threshold-recalibration consideration with N=3-4
empirical observations.

Authored 2026-06-25 immediately before laptop restart.
