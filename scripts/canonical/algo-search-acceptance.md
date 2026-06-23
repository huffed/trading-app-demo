# Stage 6.7 — Algo-search acceptance packet (gold-only demo stage) — v3

**Status:** AWAITING OPERATOR

**Compiled:** 2026-06-23 (re-issued under v3 methodology; supersedes v2 packet of 2026-06-23 EVE LATE)
**Methodology:** v3 spec (`scripts/canonical/algo-search.spec.md` §4) — per-candidate criteria 1–7 + deflated criteria 8–10 (DSR + PBO + purged k-fold CV)
**Source data:** `algorithms.backtest_results` JSONB across `Search:*` (Layer A, N=308) + `LayerB:*` (Layer B, N=288) candidate rows. `statistical_rigor.deflated` sub-block populated by `scripts/canonical/revalidate-candidates.ts`.
**Scope constraint:** **gold-only** per `[[feedback_gold_only_demo_stage]]`. Operator stance: get ≥1 stable gold demo player before opening forex.

---

## 1. Executive summary (60-second read)

| Field | Value |
|---|---|
| Layer A enumerated | 308 cells (4 inst × 3 TFs × 14 patterns × 2 dirs, less exemptions) |
| Layer A per-candidate pass | 4 of 308 (1.3%) — all XAU/USD, all 4h |
| Layer B sweep target | 3 strong cells (BOS-Long XAU 4h, Engulfing-Long XAU 4h, Sweep-Long XAU 4h) |
| Layer B variants × bases | 96 × 3 = 288 |
| Layer B per-candidate pass | 67 of 288 (23%) — far above ~5% chance baseline |
| **v3 deflated re-evaluation** (3 Stage 6.7 candidates) | **1 PASSES** / 2 ELIMINATED |
| Forex candidates surfaced | 0 (no forex cells passed any layer) |
| Stop-loss invocation | not triggered — v3 produced one clean survivor (spec §5) |

**v3 verdict on the 3 Stage 6.7 candidates:**

| Candidate | DSR | PBO | k-fold | v3 verdict |
|---|---|---|---|---|
| **Engulfing-Long rr3_lb6_r06_rf0_af0** | **0.983** ✓ | **0.229** ✓ | **5/5** ✓ | **PASSES** |
| Engulfing-Long rr5_lb6_r1_rf0_af0 | 0.929 ✗ | 0.229 ✓ | 5/5 ✓ | near-miss (DSR below 0.95 threshold) |
| BOS-Long rr3_lb3_r06_rf0_af0 | 0.162 ✗ | 0.786 ✗ | 4/5 ✓ | ELIMINATED (severe overfit) |

**Operator's choice:** deploy the sole v3 survivor (Engulfing rr3_lb6_r06) to FTMO Demo, gather ≥10 demo trades, evaluate live R alignment vs in-sample CI, then green-light real $10K challenge OR retire to research.

---

## 2. The v3 survivor

### 🥇 `LayerB: XAU/USD Engulfing-Long 4h | rr3_lb6_r06_rf0_af0`

```
algorithm_id: 33b705b9-7442-4c73-8d97-4a88ecacb9a1
status:       draft (inserted by Layer B sweep)
ticker:       XAU/USD
timeframe:    4h
side:         long
pattern:      engulfing (bullish)
geometry:     rr_multiple=3, sl_lookback=6, risk_per_trade=0.6%, regime_filter=off, adx_filter=off
```

#### Per-candidate stats (criteria 1–7)

| Stat | Value | Threshold |
|---|---|---|
| total_return on $10K capital | **$5,589 (55.9%)** | > 0 ✓ |
| total_trades | 177 over 6.3yr in-sample | ≥ 30 ✓ |
| win_rate | 36.7% | (informational under v3) |
| max_static_dd | **0.62%** | ≤ 10% ✓ |
| max_daily_dd | 0.93% | ≤ 5% ✓ |
| mean R CI (block bootstrap, 2000 it) | **[+0.229, +0.821], point +0.526** | lower > 0 ✓ |
| OOS held-out N | 40 trades | ≥ 10 ✓ |
| OOS r_delta | -45.5% | \|·\| ≤ 50% ✓ (close to edge) |

#### Deflated stats (criteria 8–10) — **the v3 layer**

| Stat | Value | Threshold |
|---|---|---|
| **Deflated Sharpe Ratio** (Bailey & López de Prado 2014) | **0.983** | ≥ 0.95 ✓ |
| **Probability of Backtest Overfitting** (CSCV, N=96 trials × T-weeks) | **0.229** | < 0.5 ✓ |
| **Purged k-fold consistency** (5 folds + embargo, AFML ch.7) | **5/5 positive folds** | ≥ 4/5 ✓ |
| family Sharpe σ (sibling variants, N=96) | 0.044 | (informational — narrow distribution = low selection bias) |

**Why DSR = 0.983 is decisive:** the deflated Sharpe accounts for (a) the 96-variant selection grid (`nTrials=96`), (b) the trade-level non-normality (skew 0.57, kurt 1.47 — close to normal), and (c) the finite sample of 177 trades. A DSR above 0.95 means the probability that this Sharpe is a genuine edge — not a random max over 96 trials — is ≥ 95%. The 4 percentage-point margin above threshold is real, not marginal.

**Why PBO = 0.229 is decisive:** combinatorial symmetric cross-validation over the 96-variant Sharpe matrix. PBO < 0.5 = IS Sharpe rank predicts OOS Sharpe rank. PBO = 0.229 means in 77% of CSCV partitions the in-sample winners stay above-median out-of-sample. This is empirical, not asymptotic.

**Why k-fold = 5/5 is decisive:** 5 contiguous folds of the trade ledger, each with purge + embargo to prevent leakage, ALL produced positive mean R. No fold-specific dependence; the edge is distributed across the in-sample window.

#### Risk notes specific to this variant

1. **OOS r_delta -45.5% is within the ±50% gate but close to the edge.** Forward demo R is likely materially weaker than in-sample point estimate (+0.526). Plan for ~+0.25 to +0.35 R per trade in demo.
2. **High geometry sensitivity within the Engulfing family.** Of 96 Engulfing variants, 25 pass per-candidate criteria; the passing variants share `regime_filter=OFF` and tend toward `risk=0.6%`. Lock the chosen geometry exactly — selecting a different variant from the same base would likely produce a non-passing algo.
3. **Single-instrument / single-TF concentration.** This is the only v3 survivor, so the demo portfolio has zero diversification. Acceptable for gold-only demo stage; revisit after demo proves out.

---

## 3. Eliminated candidates (audit trail for the 2 that did NOT pass v3)

### ❌ `LayerB: XAU/USD Engulfing-Long 4h | rr5_lb6_r1_rf0_af0` — near-miss

```
algorithm_id: fc1f0277-e100-4f1a-ae43-fc2ae7de8172
geometry:     rr_multiple=5, sl_lookback=6, risk_per_trade=1.0%, regime_filter=off, adx_filter=off
total_return: $9,178 (91.8%) — HIGHEST absolute return of the 3 candidates
DSR:          0.929 (< 0.95) ✗
PBO:          0.229 ✓
k-fold:       5/5 ✓
```

**Why eliminated:** DSR sits 2.1 percentage points below the 0.95 threshold. The numerator (raw observed Sharpe) is strong, but the DSR denominator penalises this variant for fatter tails — trade-level skew 1.19 + kurt 2.69 (vs the winner's 0.57 + 1.47). Big-R wins exist, but the path is bumpier. Under v3 this is treated as evidence the apparent edge is partly attributable to a few outlier trades, not a stable distribution.

**Why not promoted as fallback:** v3 is a hard gate. A 2-point DSR shortfall isn't a "close enough" — it means the formal probability of genuine edge is ~91% rather than ≥95%. The whole point of switching from v2 to v3 was to stop selecting on raw point estimates.

### ❌ `LayerB: XAU/USD BOS-Long 4h | rr3_lb3_r06_rf0_af0` — severe overfit

```
algorithm_id: 50e2bc16-ff6f-4c02-abda-304106924266
geometry:     rr_multiple=3, sl_lookback=3, risk_per_trade=0.6%, regime_filter=off, adx_filter=off
total_return: $3,793 (37.9%)
DSR:          0.162 (severe) ✗
PBO:          0.786 (severe overfit) ✗
k-fold:       4/5 ✓
```

**Why eliminated:** the BOS-Long family has σ_Sharpe = 0.102 across its 96 variants (vs Engulfing's 0.044). Wide sibling distribution → high expected-max-Sharpe under the null (E[max Sharpe over 96 trials] ≈ 0.256). This variant's observed Sharpe (0.186) is **below** what would be expected from random selection alone — the apparent edge is selection bias, not signal. PBO 0.786 confirms it: in 78.6% of CSCV partitions the in-sample winners ended BELOW the median out-of-sample. This is the canonical overfit signature.

**This is exactly the failure mode v2 couldn't detect.** Under v2 this variant looked acceptable — positive CI lower, OOS r_delta clean at -6.3%, win-rate 36.4%. v2's pattern-robustness criterion (≥2 cells) would have flagged it anyway as a singleton, but the operator-facing read would have been "promising candidate, escalate for manual review." v3 calls it what it is: not a real edge.

**Recommendation:** archive this row alongside other failed candidates; do not stamp.

---

## 4. The BLOCKED + EXCLUDED ledger (full audit trail)

### Layer A (308 candidates) → 4 per-candidate pass

| Pass status | Count |
|---|---|
| Per-candidate pass (criteria 1–7) | 4 (BOS XAU 4h, Engulfing XAU 4h, Sweep XAU 4h, MeanRev XAU 30m thin) |
| Failed CI lower > 0 | ~290 (primary blocker — most candidates have negative expected R) |
| Failed OOS r_delta ≤ 50% | ~11 (in-sample positive but OOS R diverged > 50%) |

### Layer B (288 variants on 3 strong cells) → 67 per-candidate pass / 1 v3-pass

| Base pattern | Variants enumerated | Variants passing per-candidate | Variants passing v3 deflated | Notes |
|---|---|---|---|---|
| Engulfing-Long XAU 4h | 96 | 25 | **1** (rr3_lb6_r06 only — see §2) | low family σ → clean DSR signal |
| BOS-Long XAU 4h | 96 | 25 | **0** (best variant DSR 0.162; severe selection bias) | wide family σ → DSR + PBO eliminate all |
| Sweep-Long XAU 4h | 96 | 17 | not run | not part of F.4 Stage 6.7 candidate set |
| **TOTAL evaluated under v3** | **288** | **67** | **1** | |

Key observation: `regime_filter=ON` killed virtually every variant. Filed as SG.20 below.

### Forex audit (per `[[feedback_gold_only_demo_stage]]` — would be ignored anyway)

| Instrument | Layer A cells | CI lower > 0 cells | Per-candidate pass |
|---|---|---|---|
| XAU/USD | 77 | 16 (21%) | 4 (5.2%) |
| USD/JPY | 77 | 1 (1.3%) | 0 |
| GBP/USD | 77 | 0 | 0 |
| EUR/USD | 77 | 0 | 0 |

**Forex shows no edge under current pattern catalog.** Phase D.1 (strategy generation) trigger should design forex-specific entry conditions. Out of scope for this packet.

---

## 5. Risk acknowledgements (read before stamping)

1. **OOS r_delta near the criterion edge:** the survivor's -45.5% delta is within the ±50% spec criterion but close to the boundary. Forward demo R is likely materially weaker than in-sample point estimate (+0.526). Plan for ~+0.25 to +0.35 R per trade in demo.

2. **High geometry sensitivity:** 25 of 96 Engulfing variants pass per-candidate criteria, 71 fail. The PASSING variants share `regime_filter=OFF` and tend toward `risk=0.6%`. Selecting a different geometry from the same base would likely produce a non-passing algo. Lock the operator's chosen variant exactly.

3. **Post-hoc-locked methodology:** v3 criteria were informed by the F.4 re-evaluation data → applied to past + future. Forward true-prereg evidence comes from the demo period itself.

4. **Single-instrument / single-TF concentration:** the v3 survivor is the only deployable candidate. The demo portfolio has zero diversification. Acceptable for gold-only demo stage per operator's stance; revisit after demo proves out.

5. **DSR-based deflation depends on the family-σ estimate:** the Engulfing family's narrow Sharpe distribution (σ=0.044) made DSR easier to clear. If a different geometry-grid choice had produced a wider σ, even the same variant might have failed. This is a feature (DSR adapts to selection-grid size) not a bug, but it means deflation is grid-specific. The 96-variant grid is pre-registered in spec §3.

---

## 6. The 8-decision template (operator stamps to un-pause)

Under v3 there is **one** deployable variant. Decisions 1's option set collapses accordingly; the other decisions retain the previous template.

### Decision 1 — Which variant to deploy

- [ ] **Option A (ONLY v3 survivor):** Engulfing-Long rr3_lb6_r06 (DSR 0.983, PBO 0.229, k-fold 5/5)
- [ ] **Option B (do NOT deploy):** archive the survivor too; re-enter research (Phase D.1 trigger)
- [ ] Operator override: ___________

The previous v2 packet's options B/C/D/E (Engulfing rr5_lb6_r1, BOS rr3_lb3, portfolios of 3) are not available under v3 — those candidates did not pass deflation.

### Decision 2 — Broker connection

Existing broker connections (verify in `broker_connections` table):
- `22e479ed-...` FTMO Demo $100k 1
- `1bc8dd11-...` FTMO Demo $100k 2
- `9a79809e-...` Gold test $100k 1
- `c508808c-...` FTMO Test $100k (previously used for Gold sweep_reclaim demo)
- `d31ac28f-...` Gold $50k v5
- `11325c4b-...` Gold swing demo $100k

**Recommended:** `c508808c-...` (FTMO Test $100k) — already wired through MetaApi, prior Stage 5 acceptance pattern used this connection.

- [ ] FTMO Test $100k (c508808c)
- [ ] FTMO Demo $100k 1 (22e479ed)
- [ ] FTMO Demo $100k 2 (1bc8dd11)
- [ ] Gold test $100k 1 (9a79809e)
- [ ] Gold swing demo $100k (11325c4b)
- [ ] Gold $50k v5 (d31ac28f)
- [ ] Operator override: ___________

### Decision 3 — Capital tier

Backtests ran at $10K (Phase E standardization). Demo capital choices:
- [ ] $10K (matches backtest exactly; conservative; demo P&L directly comparable)
- [ ] $100K (matches broker account; demo P&L scales 10×; sizing math identical because risk_per_trade is %-based)
- [ ] Operator override: ___________

### Decision 4 — Risk per trade (lock or adjust)

The survivor's geometry tag is `rr3_lb6_r06_rf0_af0` → 0.6% per trade.

- [ ] Use baked-in 0.6% (RECOMMENDED — don't change the geometry that passed v3)
- [ ] Override to a different value: ___% (will break the variant's pre-registered methodology — strongly discouraged; will invalidate the DSR/PBO/k-fold deflation)

### Decision 5 — Observation period before challenge gate

Per Stage 5.2 demo-gate spec (mirrored here):
- [ ] Minimum 10 demo trades (matches `[[feedback_live_mirror_milestone]]` superseded but informative)
- [ ] Minimum 20 demo trades (more statistical confidence; ~3-6 months for gold 4h at ~30 trades/year/algo)
- [ ] Minimum 30 demo trades (full half-sample-size; ~6-12 months)
- [ ] Operator override: ___ trades

### Decision 6 — Demo gate evaluation criterion (when ≥N trades collected)

- [ ] Demo mean R within in-sample CI [+0.229, +0.821] (RECOMMENDED — exact spec §5.2 contract)
- [ ] Demo mean R > 0 (looser; just confirm not net-losing)
- [ ] Demo mean R within ±50% of in-sample point estimate +0.526 (matches v2/v3 criterion 7)
- [ ] Operator override: ___________

### Decision 7 — Failure escalation (if demo fails)

If the demo R falls outside the chosen gate:
- [ ] Pause + research (no money risked — return algo to draft)
- [ ] Pause + re-evaluate at Layer B level (sweep a different geometry per spec §4)
- [ ] Phase D.1 trigger fires (acknowledge pattern doesn't generalize live)
- [ ] Operator override: ___________

### Decision 8 — Scan + manage cron status

After un-pausing, the scan + manage crons (on operator's Mac) will pick up the algo automatically. Currently 0 active algos → cron has been idling per `[[feedback_gold_only_demo_stage]]`.

- [ ] Confirm: cron is running on the Mac, will pick up the algo within 5–15 min of un-pausing
- [ ] Confirm: SG.19 cron-idle visibility gap is acknowledged (cron will start writing `activity_log` again once 1 active algo exists)
- [ ] Operator override: ___________

---

## 7. Execution sequence (after operator stamps)

Once all 8 decisions are stamped, the un-pause SQL is mechanical. Example for Option A (the v3 survivor, FTMO Test broker, $10K capital):

```sql
-- 1. Wire broker_connection_id + activate
UPDATE algorithms
SET status               = 'active',
    live_trading_enabled = true,
    broker_connection_id = 'c508808c-e799-444e-a34e-47c36af23bc4',  -- FTMO Test $100k
    capital              = 10000,
    updated_at           = NOW()
WHERE id = '33b705b9-7442-4c73-8d97-4a88ecacb9a1';  -- Engulfing-Long rr3_lb6_r06

-- 2. Pre-register the deployment (locks demo criteria in writing BEFORE first live trade)
-- Edit scripts/canonical/preregistration.json to add:
-- "LayerB: XAU/USD Engulfing-Long 4h | rr3_lb6_r06_rf0_af0": {
--   "hypothesis": "Engulfing pattern with rr3/lb6/r0.6 will generate positive mean R in forward demo, within in-sample CI [+0.229, +0.821]",
--   "registered_at": "2026-06-23T22:00:00Z",
--   "expires_at": "2026-12-23T00:00:00Z",
--   "registration_type": "post-hoc-locked-v3",
--   "min_total_return": 0,
--   "min_mean_r_ci_lower": 0,
--   "max_static_dd": 10,
--   "max_daily_dd": 5,
--   "max_oos_r_delta_pct": 50,
--   "min_held_out_trades": 10,
--   "deflated_sharpe_min": 0.95,
--   "pbo_max": 0.5,
--   "purged_kfold_min_pass_ratio": 0.8
-- }

-- 3. Verify
SELECT id, name, status, live_trading_enabled, broker_connection_id, capital
FROM algorithms WHERE id = '33b705b9-7442-4c73-8d97-4a88ecacb9a1';
```

After un-pause: scan-cron picks up the algo within 15 min, manage-cron within 5 min. activity_log starts writing again (resolves the SG.19 silence). Live trades flow through MetaApi to the FTMO Test demo account.

---

## 8. What this is NOT

- NOT a real-money decision. Demo deployment only. Real challenge gate is Stage 5.3 (after demo R alignment confirmed).
- NOT a multi-instrument deployment. Gold-only per `[[feedback_gold_only_demo_stage]]` until ≥1 gold demo player is stable.
- NOT a portfolio-composition decision. v3 produced exactly one survivor → single-algo deployment.
- NOT an LLM-trader decision. LLM-trader path deferred to Phase D.4 (paid, last).
- NOT an automatic refresh. v3 spec is post-hoc-locked; the next true-prereg sweep would be v4 if methodology pivots again.

---

## 9. SG.20 — regime_filter calibration ✅ RESOLVED 2026-06-24 (H.7)

**Resolution: KEEP the axis. No calibration change.** Original framing
("killed virtually every variant") was a cross-family aggregation artifact;
the per-family data shows the axis behaves as designed.

**Evidence (per-family Engulfing-Long 4h, 48 + 48 = 96 variants):**

| Axis | n | per-cand pass | avg Sharpe | max Sharpe | avg static DD | avg trades |
|---|---|---|---|---|---|---|
| rf=0 | 48 | **45 (94%)** | 0.196 | 0.317 | 0.53% | 171 |
| rf=1 | 48 | **36 (75%)** | 0.184 | 0.295 | 2.61% | 129 |

`rf=1` has a meaningfully wider DD (5× the rf=0 average) and ~25% fewer
trades (gate filters out range-detected periods), driving its single-model
underperformance. The 75% pass rate is solid — not pathological. The
original 4/67 cross-family stat conflated this family with BOS + Sweep
where rf=1 fared much worse.

**H.6 per-regime evidence:** the medium_vol regime winner among the 96
Engulfing variants is `rr3_lb6_r1_rf1_af1` (medium_vol Sharpe 0.4656 vs
the single-model pooled 0.3136). `rf=1` IS the right call within that
specific regime — keeping the axis preserves regime-routing optionality
(H.6-live-routing, task #352) at zero cost (the 96-variant grid is
already iterated by validate-algo + WFO + revalidate-candidates).

**Action items (all complete):**
- Spec §2 updated with the per-family empirical pattern + the "keep
  axis" decision rationale (`scripts/canonical/algo-search.spec.md`)
- Layer B enumerator unchanged (`src/lib/algo-search/layer-b-enumerate.ts`)
- walk-forward-opt unchanged (still iterates 96 variants per algo per
  cycle)
- This SG.20 entry marked RESOLVED

---

## 10. v2 → v3 lineage (what changed in this packet)

This packet supersedes the v2 packet of 2026-06-23 EVE LATE. The substantive differences:

| Aspect | v2 packet | v3 packet (this file) |
|---|---|---|
| Methodology | per-candidate criteria 1–8 + pattern-robustness ≥ 2 cells | per-candidate criteria 1–7 + DSR ≥ 0.95 + PBO < 0.5 + k-fold ≥ 4/5 |
| Ranking | Calmar (return / static DD) DESC | Deflated Sharpe Ratio DESC |
| Deployable candidates | 3 (Engulfing rr3_lb6_r06, Engulfing rr5_lb6_r1, BOS rr3_lb3_r06) | 1 (Engulfing rr3_lb6_r06) |
| Stop-loss invocation | "single-cell winners → escalate for manual review" | not triggered — clean v3 survivor exists |
| Operator decision tree | 5 options (single + small portfolio + full portfolio) | 2 options (deploy survivor OR archive + research) |

The v2 packet was correct under v2 criteria; v3 supersedes those criteria because v2's pattern-robustness heuristic could not distinguish real edge from family-selection-bias-induced apparent edge (the BOS rr3_lb3 case demonstrates the failure mode). The Engulfing rr3_lb6_r06 candidate appears in both packets as a deployable — v3 strengthens, not weakens, the case for that variant.

---

**End of packet.** Awaiting operator decisions in §6.
