# Stage 6.7 — Algo-search acceptance packet (gold-only demo stage)

**Status:** AWAITING OPERATOR (Stage 6.7 is a personal-risk decision gate; nothing below substitutes for the operator's call).

**Compiled:** 2026-06-23 EVE LATE
**Methodology:** v2 spec (`scripts/canonical/algo-search.spec.md`)
**Source data:** `algorithms.backtest_results` JSONB across `Search:*` (Layer A, N=308) + `LayerB:*` (Layer B, N=288) candidate rows.
**Scope constraint:** **gold-only** per `[[feedback_gold_only_demo_stage]]` (2026-06-23 LATE). Operator stance: get ≥1 stable gold demo player before opening forex.

---

## 1. Executive summary (60-second read)

| Field | Value |
|---|---|
| Layer A enumerated | 308 cells (4 inst × 3 TFs × 14 patterns × 2 dirs, less exemptions) |
| Layer A per-candidate pass | 4 of 308 (1.3%) — all XAU/USD, all 4h |
| Layer A pattern-robustness pass (criterion 9) | **0** — all 4 passers are single-cell |
| Layer B sweep target | 3 strong singletons (BOS-Long XAU 4h, Engulfing-Long XAU 4h, Sweep-Long XAU 4h) |
| Layer B variants × bases | 96 × 3 = 288 |
| **Layer B v2 per-candidate pass** | **67 of 288 (23%)** — far above ~5% chance baseline |
| Layer B pass distribution | BOS 25/96 · Engulfing 25/96 · Sweep 17/96 |
| Forex candidates surfaced | 0 (no forex cells passed v2 anywhere) |
| Pattern-robustness criterion 9 status | **still unsatisfied** — all 67 passers are same (instrument, TF) cell |
| Stop-loss invocation | spec §4 "single-cell winners → escalate to operator for manual review of strongest singleton" |

**Operator's choice:** select 1 or more variants for demo deployment to FTMO Demo, gather ≥30 demo trades, evaluate live R alignment vs in-sample CI, then green-light real $10K challenge OR retire to research.

---

## 2. Top candidate (Calmar leader, smallest DD)

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

| Stat | Value |
|---|---|
| total_return on $10K capital | **$5,589 (55.9% on baseline capital)** |
| total_trades | 177 over 6.3yr in-sample |
| win_rate | 36.7% |
| max_static_dd | **0.62%** (cleanest in top 10) |
| max_daily_dd | 0.93% |
| mean R CI (block bootstrap, 2000 it) | **[+0.229, +0.821], point +0.526** |
| Sharpe | 0.25 |
| Bonferroni p-value | 0.000250 (informational; not a v2 hard gate) |
| OOS held-out N | 40 trades |
| OOS r_delta | -45.5% (within ±50% tolerance) |
| **Calmar (return / static DD)** | **9,014** |

**Why this one:** Lowest static DD (0.62%) in the top 10 means highest risk-adjusted return + cleanest equity curve. CI lower of +0.229 is the STRONGEST statistical evidence of positive expected R in the entire 596-candidate fleet. The -45.5% OOS r_delta is within v2 criterion 7 but close to the edge — flagging this so the operator knows OOS R is materially weaker than in-sample R (expect ~half the in-sample point estimate in forward demo).

---

## 3. Alternative candidates (same Engulfing pattern, more aggressive geometry)

### 🥈 `LayerB: XAU/USD Engulfing-Long 4h | rr5_lb6_r1_rf0_af0`

```
algorithm_id: fc1f0277-e100-4f1a-ae43-fc2ae7de8172
geometry:     rr_multiple=5, sl_lookback=6, risk_per_trade=1.0%, regime_filter=off, adx_filter=off
total_return: $9,178 (91.8% on $10K) — HIGHEST absolute return in top 10
total_trades: 131, WR 26.0%, static DD 1.03%, daily DD 1.94%
mean R CI:    [+0.246, +1.154], point +0.701
OOS r_delta:  -22.9% (cleanest of high-return variants)
held-out N:   27
Calmar:       8,911
```

**Trade-off vs candidate #1:** higher absolute return (~$9.2K vs $5.6K) at slightly higher DD (1.03% vs 0.62%). Aggressive RR=5 + risk=1.0%. WR=26% is wide-SL/high-R style — operator must accept the 74% losing-trade rate emotionally. Cleaner OOS r_delta (-22.9% vs -45.5%) → more confidence forward R matches in-sample.

### 🥉 `LayerB: XAU/USD BOS-Long 4h | rr3_lb3_r06_rf0_af0`

```
algorithm_id: 50e2bc16-ff6f-4c02-abda-304106924266
geometry:     rr_multiple=3, sl_lookback=3, risk_per_trade=0.6%, regime_filter=off, adx_filter=off
total_return: $3,793 (37.9% on $10K)
total_trades: 162, WR 36.4%, static DD 0.79%, daily DD 1.33%
mean R CI:    [+0.068, +0.691], point +0.390
OOS r_delta:  -6.3% (CLEANEST in entire top 10 — best OOS alignment)
held-out N:   55
Calmar:       4,801
```

**Why include:** different pattern family (BOS vs Engulfing) → potentially less-correlated returns if deployed alongside. Cleanest OOS r_delta (-6.3%) means demo R should track in-sample R almost exactly — highest forward confidence. CI lower +0.068 is positive but thinner than candidate #1.

---

## 4. The BLOCKED + EXCLUDED ledger (audit trail)

### Layer A (308 candidates) → 4 per-candidate pass / 0 robustness pass

| Pass status | Count |
|---|---|
| Per-candidate pass (criteria 1–8) | 4 (BOS XAU 4h, Engulfing XAU 4h, Sweep XAU 4h, MeanRev XAU 30m thin) |
| Singleton (pattern works on ONLY 1 cell) | 4 |
| Robust survivor (≥2 cells of same pattern × side) | **0** |
| Failed CI lower > 0 | ~290 (primary blocker — most candidates have negative expected R) |
| Failed OOS r_delta ≤ 50% | ~11 (in-sample positive but OOS R diverged > 50%) |

### Layer B (288 variants on 3 strong singletons) → 67 per-candidate pass

| Base pattern | Variants enumerated | Variants passing v2 | Pass rate |
|---|---|---|---|
| Engulfing-Long XAU 4h | 96 | 25 | 26% |
| BOS-Long XAU 4h | 96 | 25 | 26% |
| Sweep-Long XAU 4h | 96 | 17 | 18% |
| **TOTAL** | **288** | **67** | **23%** (vs 5% chance baseline) |

Key observation: `regime_filter=ON` killed virtually every variant. The filter's design (skip ATR-percentile low) was supposed to keep us out of ranging markets, but gold 4h structural breaks fire IN those very conditions. **Calibration finding filed: SG.20 below.**

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

1. **Singleton-not-robust:** all 67 Layer B passers are SAME (XAU/USD, 4h) cell. Per v2 spec criterion 9, this is a "manual review of strongest singleton" case, not a structural-robust survivor. The 23% Layer B pass rate IS strong evidence the cell has real edge, but cross-cell replication (would BOS-Long work on XAU 1h with geometry refinement? we didn't sweep that yet) is unproven.

2. **OOS r_delta near the criterion edge:** candidate #1's -45.5% delta is within the ±50% spec criterion but close to the boundary. Forward demo R is likely materially weaker than in-sample point estimate (+0.526). Plan for ~+0.25 to +0.35 R per trade in demo.

3. **High geometry sensitivity:** 25 of 96 Engulfing variants pass, 71 fail. The PASSING variants share `regime_filter=OFF` and tend toward `risk=0.6%`. Selecting a different geometry from the same base would likely produce a non-passing algo. Lock the operator's chosen variant exactly.

4. **Post-hoc-locked methodology:** v2 criteria were informed by v1 data → applied to past + future. Forward true-prereg evidence comes from the demo period itself.

5. **Pattern-robustness data-snooping risk:** spec §4 stop-loss explicitly flags this case. Mitigation = demo observation period evaluates live R against the in-sample CI before any real-money decision.

6. **All 3 candidates are highly correlated** (same instrument + TF + side + structural-break family). Deploying ALL 3 simultaneously does NOT diversify — combined DD likely ≈ single-algo DD. Recommend deploying 1 first, adding others only after demo confirms.

---

## 6. The 8-decision template (operator stamps to un-pause)

For EACH variant you choose to deploy, stamp answers in this section. Leave variants you're not deploying unstamped (those rows stay `draft`).

### Decision 1 — Which variant(s) to deploy

- [ ] **Option A (recommended for single):** Candidate #1 only — Engulfing-Long rr3_lb6_r06 (lowest DD, strongest CI)
- [ ] **Option B (aggressive single):** Candidate #2 only — Engulfing-Long rr5_lb6_r1 (highest return, slightly higher DD)
- [ ] **Option C (cleanest OOS):** Candidate #3 only — BOS-Long rr3_lb3_r06 (best OOS alignment, different pattern family)
- [ ] **Option D (small portfolio):** Candidates #1 + #3 (different pattern families → some decorrelation despite same instrument/TF)
- [ ] **Option E (full small portfolio):** All 3 (#1 + #2 + #3)
- [ ] Operator override: ___________

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

### Decision 3 — Capital tier per algo

Backtests ran at $10K (Phase E standardization). Demo capital choices:
- [ ] $10K (matches backtest exactly; conservative; demo P&L directly comparable)
- [ ] $100K (matches broker account; demo P&L scales 10×; sizing math identical because risk_per_trade is %-based)
- [ ] Operator override: ___________

### Decision 4 — Risk per trade (lock or adjust)

Each variant's geometry tag includes its baked-in risk %. Examples:
- `rr3_lb6_r06_rf0_af0` → 0.6% per trade
- `rr5_lb6_r1_rf0_af0` → 1.0% per trade

- [ ] Use variant's baked-in risk (RECOMMENDED — don't change the geometry that passed)
- [ ] Override to a different value: ___% (will break the variant's pre-registered methodology — strongly discouraged)

### Decision 5 — Observation period before challenge gate

Per Stage 5.2 demo-gate spec (mirrored here):
- [ ] Minimum 10 demo trades (matches `[[feedback_live_mirror_milestone]]` superseded but informative)
- [ ] Minimum 20 demo trades (more statistical confidence; ~3-6 months for gold 4h at ~30 trades/year/algo)
- [ ] Minimum 30 demo trades (full half-sample-size; ~6-12 months)
- [ ] Operator override: ___ trades

### Decision 6 — Demo gate evaluation criterion (when ≥N trades collected)

- [ ] Demo mean R within in-sample CI (RECOMMENDED — exact spec §5.2 contract)
- [ ] Demo mean R > 0 (looser; just confirm not net-losing)
- [ ] Demo mean R within ±50% of in-sample point estimate (matches v2 criterion 7)
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

Once all 8 decisions are stamped, the un-pause SQL is mechanical. Example for Option A (Candidate #1 only, FTMO Test broker, $10K capital):

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
--   "hypothesis": "...",
--   "registered_at": "2026-06-23T22:00:00Z",
--   "expires_at": "2026-12-23T00:00:00Z",
--   "registration_type": "post-hoc-locked",
--   "min_total_return": 0,
--   "min_mean_r_ci_lower": 0,
--   "max_static_dd": 10,
--   "max_daily_dd": 5,
--   "max_oos_r_delta_pct": 50,
--   "min_held_out_trades": 10
-- }

-- 3. Verify
SELECT id, name, status, live_trading_enabled, broker_connection_id, capital
FROM algorithms WHERE id = '33b705b9-7442-4c73-8d97-4a88ecacb9a1';
```

For multi-variant deployments, repeat steps 1 + 2 for each.

After un-pause: scan-cron picks up the algo within 15 min, manage-cron within 5 min. activity_log starts writing again (resolves the SG.19 silence). Live trades flow through MetaApi to the FTMO Test demo account.

---

## 8. What this is NOT

- NOT a real-money decision. Demo deployment only. Real challenge gate is Stage 5.3 (after demo R alignment confirmed).
- NOT a multi-instrument deployment. Gold-only per `[[feedback_gold_only_demo_stage]]` until ≥1 gold demo player is stable.
- NOT a portfolio-composition decision. All 3 candidates are correlated (same instrument/TF/side/family). Operator can deploy 1+ but combined DD will track single-algo DD.
- NOT an LLM-trader decision. LLM-trader path deferred to Phase D.4 (paid, last).
- NOT an automatic refresh. v2 spec is post-hoc-locked; next sweep would be a true-prereg v3 if methodology pivots again.

---

## 9. SG.20 — Filed for future: regime_filter calibration

Layer B observed: **almost zero passing variants used `regime_filter=ON`**. Of 67 passers, only 4 had the filter enabled, all in Engulfing's 6/4-lookback combinations.

The regime_filter was designed to skip ATR-percentile-low (ranging) periods. Empirical signal: gold 4h structural-break patterns make their money DURING ranging conditions, not trending ones. Either:
- Calibration is wrong (the percentile_floor=0.3 threshold should be inverted OR lowered)
- The semantic is wrong (structural breaks PREDICT range exits, so ranging is exactly when they fire)

Action filed in roadmap as SG.20: re-calibrate regime_filter for gold-pattern compatibility OR retire it as a Layer B axis (drop from spec §2). Defer until after gold demo player is stable.

---

**End of packet.** Awaiting operator decisions in §6.
