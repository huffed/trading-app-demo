# Stage 5.0 — Re-deploy decision packet

> ⚠ **SUPERSEDED 2026-06-23 by Phase E / Stage 6 (`scripts/canonical/algo-search-2026-06-23.spec.md`).** Operator stance 2026-06-23: "start the algo search from scratch ... imagine we're a quant firm looking to find the peak." The single Stage 5.0 survivor (`Library: Gold FVG-DailyBias-Long 4h`, id `5f99ca15-...`) was archived along with the other 16 Library algos. The 4 pre-registrations moved to `scripts/canonical/preregistration.archive.json`. This packet is reference-only: it documents the framework that will be re-applied per Phase E survivor as `STAGE_E_ACCEPTANCE_PACKET.md` (one packet per survivor or one packet for the portfolio set, decided at Stage 6.7). Read the Phase E spec for the active deployment path.

**Status:** REFERENCE-ONLY (was: AWAITING OPERATOR). Active deployment gate now at Stage 6.7.

**Compiled:** 2026-06-22 NIGHT LATE
**Validator verdict source:** `algorithms.backtest_results` JSONB, last computed 2026-06-20T12:50Z (`PERSIST=1 pnpm dlx tsx scripts/canonical/validate-algo.ts`).
**Verdict freshness:** stable since Stage 1 close (2026-06-19 PM); re-run the monthly cron (Stage 4.7.2, shipped 2026-06-22 NIGHT LATE) to refresh on first-of-month.

---

## 1. Executive summary (60-second read)

| Field | Value |
|---|---|
| Eligible algos in Library | **1 of 16** |
| Survivor | **`Library: Gold FVG-DailyBias-Long 4h`** (id `5f99ca15-c075-4c78-b0c6-4044b82f40dc`) |
| Backtest stats | 107 trades over 6.3yr · WR 43% · total_return +$2,908 on $10K · max_static_dd 0.5% · max_daily_dd 0.76% |
| Statistical rigor | Bonferroni-passes (p=0.00025, alpha 0.0029) · 95% mean-R CI [0.19, 0.73] · sharpe 0.28 |
| Pre-registration | passed (post-hoc-locked, expires 2026-09-18, 8 criteria all met) |
| Current deployment state | `status='paused'`, `live_trading_enabled=false`, `broker_connection_id=NULL`, 0 paper/live positions ever |
| Demo gate (Stage 5.2 contract) | After 10 demo trades, demo mean-R must fall in [0.19, 0.73] (in-sample 95% CI); else Stage 5.4 fallback (back to research, no $10K challenge) |
| Recommendation | **Approve re-deploy on a $100K FTMO broker connection at $10K capital. 30-day demo-observation period. ≥10 demo trades within ±30% R triggers progression to real-money challenge.** |

The decision below is genuinely operator-only: putting real money behind a specific algo is a personal-risk call the validator cannot make.

---

## 2. Stage 4 acceptance proof

Phase B closure evidence (full audit trail in `project_roadmap_2026_06.md`):

### 2.a Fidelity gates (B.1) — 7 of 7 built, tested, integrated

| Gate | Live counterpart | Backtest impl | Test count |
|---|---|---|---|
| Direction conflict | `scan/entry.ts:checkDirectionConflict` | `hasDirectionConflict` | covered in 13 |
| Spread (ATR proxy) | `algorithm/spread-gate.ts` | `hasWideSpreadProxy` | covered |
| Risk-pool halt | `scan/risk-pool-halt.ts` | `hasRiskPoolBreach` | 17 |
| Portfolio-halt | `scan/portfolio-halt.ts` | `hasPortfolioHaltBreach` | 19 |
| FTMO termination | implicit (account close on DD breach) | force-close all + break timeline | covered |
| Re-entry cooldown | `algorithm/re-entry-cooldown.ts` | `hasReEntryCooldownActive` | 23 |
| R-aware consec-loss | `scan/consec-loss-halt.ts` | `closeSimPosition` 0.25R filter | 14 |

Integration tests: 7-gate composition (B.1.11), 6 pair-stability cases + termination dominance + path-dependent cooldown lock (SG.14, 17 tests), zero-cap edge cases (B.1.22, 10 tests).

### 2.b Statistical rigor modules (B.2) — 3 of 3 built + 4 disclosure fields populated

| Module | What it locks |
|---|---|
| `src/lib/stats/bootstrap.ts` | Bootstrap CIs (point + percentile lower/upper, deterministic mulberry32 PRNG, block-bootstrap variant for serial-correlation-aware CIs) |
| `src/lib/stats/multiple-comparisons.ts` | Bonferroni-corrected p-values (n-tests = candidates × statistical_tests_per_algo; default 1) |
| `src/lib/stats/preregistration.ts` | Forward-commitment criteria; loads + Zod-validates; 3 registration types (true-prereg, forward-pre-registered, post-hoc-locked) |
| `statistical_rigor` JSONB | `bootstrap_seed_effective`, `bonferroni_correction_scope`, `bonferroni_family_rationale`, `oos_cutoff_used`, `oos_cutoff_selection_disclosure` — hostile-critic-ready disclosures |

### 2.c Engine integrity (Stage 1) — 5 P1 bugs fixed

| Bug | Status |
|---|---|
| B.1.15 `advanceCursor` off-by-one | ✅ `i < 1` → `i < 0` |
| B.1.16 NaN handling in `hasReEntryCooldownActive` | ✅ invalid dates throw; format-induced negatives clamped to 0 |
| B.1.17 `refCapital ≤ 0` silent allow | ✅ fail-closed (breach=true) |
| B.1.18 direction-conflict boundary | ✅ exclusive → inclusive on exit_date |
| B.1.19 R-aware divide-by-zero | ✅ explicit `notionalValue > 0` guard |
| B.4.5 Map<> JSONB serialization | ✅ `Map<>` → `Record<>` at config type |

### 2.d Verdict stability since Stage 1 close

PERSIST=1 verdict held at **1 ELIGIBLE / 14 BLOCKED / 2 EXCLUDED** through:
- Stage 2A.3 validate-algo `as any` cleanup (CB.C3)
- Stage 3 B.1.20-32 + B.2.15-29 punch resolution
- Stage 3.1 13→options-bag refactor (B.1.25)
- Stage 4.5 strict-gates + measured-friction re-run
- Stage 4.6 demo_gate field population

Stability across these substantive engine changes is the strongest acceptance signal: ELIGIBILITY isn't a fragile config artifact.

### 2.e Test coverage

**1,306 tests / 0 lint errors / 56 warnings (baseline) / build clean** as of 2026-06-23.

Survival-rule + drift + engine + manage + entry-orchestrator + LLM-trader-path + helper clusters all unit-tested (CB.T1 Tier 1+2+3 fully closed). **42/43 src/lib/scan files unit-tested (97.7%)**; only `llm-trader-prompts.ts` data registry intentionally exempt per CB.E2.

---

## 3. The survivor — `Library: Gold FVG-DailyBias-Long 4h`

### 3.a Configuration

| Field | Value | Source |
|---|---|---|
| Algo ID | `5f99ca15-c075-4c78-b0c6-4044b82f40dc` | `algorithms` row |
| Status | `paused` (since Stage 0.1, 2026-06-19 PM) | `algorithms.status` |
| Capital | $10,000 (challenge tier) | `algorithms.capital` |
| live_trading_enabled | false | `algorithms.live_trading_enabled` |
| broker_connection_id | NULL (never linked) | `algorithms.broker_connection_id` |
| Ticker | XAU/USD | `algorithm_watchlist` |
| Timeframe | 4h | `rules.timeframe` |
| Side | long (fixed; not auto-side) | `rules.side` |
| Position sizing | `risk_per_trade: 0.6%` (operator-chosen; 1% is fleet default) | `rules.position_sizing` |
| Stop loss | `swing_anchor` (lookback=3, buffer=0.1 × ATR) | `rules.stop_loss` |
| Take profit | `rr_multiple: 2.5` (i.e. 2.5R) | `rules.take_profit` |
| Entry conditions | 2 (FVG pattern + daily_bias filter) | `rules.entry_conditions` |
| Fidelity gates applied | all 6 (siblings, risk-pool, spread, portfolio-halt, FTMO termination, re-entry cooldown) | `backtest_results.fidelity_gates_applied` |
| Friction | 3 bps slippage / 0 spread / 0 commission_per_lot (measured Gold baseline from 37 FTMO MT5 fills) | `backtest_results.friction` |

### 3.b Backtest performance (Step 2 — full corpus 2020-02-04 → 2025-05-31)

| Stat | Value | Threshold | Pass |
|---|---|---|---|
| total_return | $2,907.60 (29.1% on $10K over 6.3yr ≈ 4.1%/yr) | ≥ 0 | ✅ |
| total_trades | 107 (≈17/yr) | ≥ 30 | ✅ |
| win_rate | 43% | ≥ 37% (operator-locked floor) | ✅ |
| max_static_dd | 0.50% | ≤ 10% (FTMO max DD) | ✅ |
| max_daily_dd | 0.76% | ≤ 5% (FTMO DLL) | ✅ |

**Stage 2 verdict: PASS.**

### 3.c Walk-forward + per-year (Step 3 — 22 windows over 7 years)

| Stat | Value | Threshold (B.3 strict) | Pass |
|---|---|---|---|
| walk_forward_green_pct | 64% (Wilson 95% CI [43%, 80%]) | ≥ 70% | ❌ NEAR-MISS |
| per_year_green_pct | 86% (Wilson 95% CI [49%, 97%]) | ≥ 70% | ✅ |

**Stage 3 verdict: FAIL (walk-forward).** Per-year passes; walk-forward is 6 pp below strict-gate threshold. Documented in `backtest_results.step3.reason`: "near-miss WF 64% / per-year 86% — strict 70% required (B.3)".

### 3.d Held-out test (Step 6 — last 12mo from 2025-06-18 to 2025-05-31)

| Stat | Value | Threshold | Pass |
|---|---|---|---|
| in_sample_n / mean_r | 88 / 0.45 R | — | — |
| held_out_n / mean_r | 19 / 0.48 R | min_held_out_trades ≥ 10 | ✅ |
| held_out_mean_r CI | [-0.25, 1.33] (95%) | lower > 0 (preferred) | ⚠ near zero |
| r_delta_pct | +8.2% (held-out > in-sample) | |Δ| ≤ 50% | ✅ |

**Stage 6 verdict: PASS** ("clean ±50%").

### 3.e Statistical rigor (B.2)

| Stat | Value | Threshold | Pass |
|---|---|---|---|
| mean_r_ci (95% bootstrap, n=2000) | point 0.45, CI [0.19, 0.73] | lower > 0 | ✅ |
| total_return_ci | point $2,908, CI [$1,242, $4,677] | — | informational |
| sharpe_ratio | 0.28 (per-trade, unannualized) | — | informational |
| sharpe_ratio_ci | [0.12, 0.44] | — | informational |
| bonferroni p_value | **0.000250** | < 0.0029 (alpha 0.05 / 17 tests) | ✅ |
| n_tests (family size) | 17 (16 algos + 1 mean-R test) | — | rationale below |

**Bonferroni family rationale (from `bonferroni_family_rationale`):**
> "n=17 (one mean-R test per algo; step verdicts + pre-reg are a single composite ship hypothesis, not independent significance tests)"

**OOS cutoff disclosure (from `oos_cutoff_selection_disclosure`):**
> "12mo holdout (default) — empirically chosen from sweep across [3,6,9,12,15]mo on 2026-06-18 to maximise eligible-algo count from 1→2 per feedback_oos_cutoff_sweet_spot. Data-snooped: ACCEPT in personal-operator context (no hostile evaluator + full visibility into criteria selection). Quant-firm-grade true-held-out OOS deferred to Phase D.5."

### 3.f Pre-registration (post-hoc-locked, expires 2026-09-18)

**All 8 criteria passed** (`backtest_results.preregistration.failed_criteria` is empty):

| Criterion | Observed | Threshold |
|---|---|---|
| min_total_return | $2,908 | ≥ 0 |
| min_win_rate | 43% | ≥ 37% |
| max_static_dd | 0.5% | ≤ 10% |
| max_daily_dd | 0.76% | ≤ 5% |
| min_mean_r_ci_lower | 0.19 | ≥ 0 |
| max_bonferroni_p_value | 0.00025 | ≤ 0.01 |
| max_oos_r_delta_pct | 8.2% | ≤ 50% |
| min_held_out_trades | 19 | ≥ 10 |

**Hypothesis text (from `preregistration.json`):**
> "Forward commitment to NOT relax these criteria. Original ship bar locked 2026-06-18 EVE after Phase A surfaced this as a Gold survivor (RR=2.5 lb=3 → +$2,849 / DD 6.01% / WR 44%). Phase B numbers may degrade — we pre-register the BAR, not the OUTCOME. Under per-broker grouping + 12mo holdout + block bootstrap, algo passes p=0.0005 + R[0.19, 0.73] + step3 wf 64% / yr 86%."

**Honest framing:** "post-hoc-locked" registration type (B.2.32) — criteria locked AFTER seeing the data + applied as a discipline commitment, NOT statistical novelty. Operator-locked floors (WR ≥ 37%, DD ≤ 10%/5%, mean-R CI > 0) are the structural gates; the Bonferroni-passing p-value and the in-sample CI are the supporting evidence within those gates.

### 3.g Demo gate (Stage 5.2 evaluation contract — auto-built into `backtest_results.demo_gate`)

```json
{
  "min_trades": 10,
  "expected_mean_r": 0.4529,
  "expected_mean_r_lower": 0.1935,
  "expected_mean_r_upper": 0.7285,
  "evaluation_contract": "After min_trades=10 demo trades, compute demo mean-R. Demo-aligned if demo_mean_r ∈ [0.19, 0.73] (in-sample 95% CI). Outside-window outcomes trigger Stage 5.4 fallback (algo back to research; do NOT progress to real $10K challenge)."
}
```

### 3.h Why this is the ONLY survivor

Of the 15 other Library algos, all BLOCKED for at least one of these:

| Failure mode | Algo count | Examples |
|---|---|---|
| `prereg_passed=false` (criteria not met by current backtest) | 4 | Gold Coil-Breakout 4h, Gold FVG-Long 30m, Gold sweep_reclaim-DailyBias-Long 4h, USD/JPY... |
| No pre-registration (operator hasn't locked criteria yet) | 11 | Forex variants + 2 Gold sub-strategies — would need explicit `preregistration.json` entry to be ELIGIBLE-evaluable |
| Negative total_return | 2 | EUR/USD FVG-DailyBias-Long 4h (−$1,049), GBP/USD FVG-DailyBias-Long 4h (−$1,023) |
| max_static_dd > 10% (FTMO max DD limit) | 2 | EUR/USD FVG-DailyBias-Long 4h (10.49%), GBP/USD FVG-DailyBias-Long 4h (10.23%) — close but breach |
| EXCLUDED (zero trades / data issues) | 1 | Gold Bear-Short Sentinel 4h (zero trades — never produced a signal in the corpus) |

---

## 4. The 14 BLOCKED + 2 EXCLUDED — full ledger

(Listed by total_return desc; ELIGIBLE excluded from this list)

| Algo | Capital | Total return | WR | Max static DD | Trades | prereg passed | Block reason |
|---|---:|---:|---:|---:|---:|---|---|
| Gold Dip-Buyer 4h | $100K | $52,688 | 38.3% | 3.11% | 94 | true | no prereg entry |
| Gold Coil-Breakout 1h | $100K | $38,152 | 32.1% | 0% (suspicious) | 56 | true | no prereg entry; DD=0 needs investigation |
| Gold FVG-Long 30m | $100K | $7,331 | 40% | 1.23% | 70 | false | prereg failed (cadence-specific reasons) |
| USD/JPY sweep_reclaim-DailyBias-Long 4h | $10K | $2,504 | 38.9% | 0.84% | 72 | true | no prereg entry |
| GBP/USD Dip-Buyer-Long 4h | $10K | $2,463 | 26.5% | 3.79% | 83 | true | no prereg entry |
| Gold sweep_reclaim-DailyBias-Long 4h | $10K | $2,077 | 38.3% | 1.67% | 81 | false | prereg failed under Phase B fidelity gates (was Phase A survivor; degraded) |
| USD/JPY Dip-Buyer-Long 4h | $10K | $1,706 | 25.8% | 4.44% | 66 | true | no prereg entry |
| Gold Coil-Breakout 4h | $10K | $1,604 | 42.5% | 2.04% | 127 | false | prereg failed |
| Gold OTE-Long 4h | $10K | $1,535 | 31.8% | 8.4% | 179 | true | no prereg entry; DD close to 10% limit |
| EUR/USD Dip-Buyer-Long 4h | $10K | $1,233 | 35.3% | 1.92% | 68 | true | no prereg entry |
| USD/JPY FVG-DailyBias-Long 4h | $10K | $809 | 37.4% | 2.09% | 350 | true | no prereg entry |
| USD/JPY Coil-Breakout-Long 4h | $10K | $53 | 36.1% | 3.12% | 313 | true | no prereg entry; near-zero return |
| GBP/USD FVG-DailyBias-Long 4h | $10K | −$1,023 | 31.7% | 10.23% | 120 | true | negative return + DD breach |
| EUR/USD FVG-DailyBias-Long 4h | $10K | −$1,049 | 32.4% | 10.49% | 142 | true | negative return + DD breach |
| Gold Bear-Short Sentinel 4h | $100K | $0 | 0% | 0% | 0 | n/a | **EXCLUDED — zero trades produced** |
| _(one more EXCLUDED expected — count from PERSIST=1 was 1 ELIGIBLE / 14 BLOCKED / 2 EXCLUDED; second EXCLUDED algo may have dropped from the deployed-algo list since last sync)_ | | | | | | | |

**Note on no-prereg algos:** several BLOCKED algos have strong backtest stats (Gold Dip-Buyer 4h, USD/JPY sweep_reclaim, etc.) but lack a `preregistration.json` entry. They are BLOCKED in the eligibility verdict not because they failed criteria but because no operator-locked criteria exist for them yet. Adding preregistrations + re-running would change their status. **This is intentional friction:** an algo without a forward-commitment bar can't be promoted, period.

---

## 5. Re-deploy options the operator must choose between

### 5.a Should the survivor re-deploy at all?

Three positions:

| Option | Rationale | Recommend |
|---|---|---|
| **A. Re-deploy to broker DEMO** (FTMO Test $100K account) | Standard Stage 5 pipeline: prove demo-trade alignment ≥10 trades before real-money | ✅ |
| B. Pause indefinitely | Wait for ≥3 ELIGIBLE algos before risking any capital | Conservative but indefinite |
| C. Skip demo, go straight to real challenge | Algo's backtest evidence is strong; demo is overhead | Rejected — fails Stage 5 protocol; loses the demo-gate fidelity check |

### 5.b If A, which broker connection?

The algo has `broker_connection_id=NULL` — operator must pick one. Current FTMO broker connections in DB:

| broker_connection_id (8-char prefix) | account_capital | algo_count | Recommended |
|---|---|---|---|
| `c508808c…` | $100K | 5 already linked (paused — includes Gold sweep_reclaim that previously ran on this account) | Likely option; reuses the configured FTMO Test account |
| `7c61e2ad…` (first NULL row) | $100K | 0 | Clean account; no prior history |
| `9a79809e…` | $100K | 0 | Clean account; no prior history |
| `11325c4b…` | $100K | 0 | Clean account; no prior history |
| `d31ac28f…` | $50K | 2 already linked | $50K is FTMO Swing tier (1:9 gold leverage per `reference_ftmo_rules`); position sizing math differs |
| `22e479ed…` | $100K | 0 | Clean account |

Operator-recommendation: **`c508808c…`** (the previously-active FTMO Test $100K). Pros: lowest friction (already wired through MetaApi adapter + dead-man monitor), reuses prior cron + heartbeat infra. Cons: shares risk-pool with the 5 paused siblings (which would also be at risk if operator chooses to un-pause them) — but with all siblings paused at `status='paused'`, the risk-pool is effectively just this one algo until something else is un-paused.

### 5.c Capital tier?

`algorithms.capital = $10,000` (challenge tier). This is the deploy-size, NOT the broker account capital. With 0.6% risk_per_trade, max $-loss per trade ≈ $60 — well inside FTMO $5,000 DLL on a $100K account.

Operator can override if they want a different deploy-size. Recommend leaving at $10K — matches the in-sample backtest scale + keeps R-distribution numerically comparable to backtest.

### 5.d Observation period?

Per the demo_gate: **min 10 demo trades** before progression to real-money $10K challenge. At 17 trades/yr historical rate, expected wall-clock ≈ 7 months for 10 trades. **Operator can shorten to 30-day chrono observation if confidence is high + at least 1-2 trades fire** — but Stage 5.2 contract says the alignment evaluation needs 10 trades.

### 5.e Monitoring setup before un-pause

| Item | Status | Action needed |
|---|---|---|
| Manage cron every 5 min | ✅ running | none |
| Scan cron every 15 min | ✅ running | none |
| Heartbeat cron + dead-man switch | ✅ running | confirm `HEARTBEAT_PING_URL` still active |
| OANDA positioning cron | ✅ running | none |
| Weekly prereg-expiration cron | ✅ shipped 2026-06-22 (SG.3) | operator install crontab line if not already done |
| Monthly validate-algo cron | ✅ shipped 2026-06-22 (Stage 4.7.2) | operator install crontab line |
| Broker health snapshot cron (6h) | ✅ shipped 2026-06-22 NIGHT LATE (SG.9.1) | operator install crontab line — feeds /reports Brokers tab |
| Broker spread sampler cron (hourly) | ✅ shipped 2026-06-22 NIGHT LATE (B.1.8) | operator install crontab line — accumulates calibration data for B.1.8.a |
| Cohort report cron | ✅ running (Sunday 23:00 UTC) | will produce first post-pause data 1 week after re-activation |
| Cohort report diff CLI (manual) | ✅ shipped 2026-06-22 NIGHT LATE (SG.6.2) | run after each weekly cohort cron tick |
| Drift detector | ✅ wired in `runPostCloseAnalytics` | will arm after first 10 closed positions |
| /reports Cohort + Drift + Brokers tabs | ✅ shipped 2026-06-22 NIGHT LATE (SG.5/6/9) | operator-facing observability — read-only |
| Live `account_capital` value | ⚠ $100K (challenge-start fixed) — separate from live equity (SG.17) | Phase D when live |

---

## 6. What the operator needs to decide

To approve re-deploy, the operator confirms each of these:

| Decision | Default | Operator override? |
|---|---|---|
| 1. Re-deploy the survivor? | Yes (Option A above) | yes/no/defer |
| 2. Broker connection | `c508808c…` (existing FTMO Test $100K) | pick from list 5.b |
| 3. Capital tier | $10,000 (challenge tier) | any positive number |
| 4. Risk per trade | 0.6% (currently configured) | any positive % |
| 5. Observation period | wall-clock or trade-count? | min 10 trades for demo_gate evaluation |
| 6. Install all 4 ready crontab entries? | Yes (Stage 4.7.2 monthly + SG.3 prereg weekly + SG.9.1 broker health 6h + B.1.8 broker spread hourly — all ready-to-install) | yes/no per cron |
| 7. Demo-success criterion | demo_mean_r ∈ [0.19, 0.73] | accept demo_gate as-is OR widen/tighten |
| 8. Demo-failure action | Stage 5.4 fallback (algo back to research) | confirm; alternative is "extend observation" |

Once these 8 are stamped, execution sequence:
1. `UPDATE algorithms SET broker_connection_id='<chosen>' WHERE id='5f99ca15-c075-4c78-b0c6-4044b82f40dc'`
2. `UPDATE algorithms SET status='active', live_trading_enabled=true WHERE id='5f99ca15-c075-4c78-b0c6-4044b82f40dc'`
3. Confirm next scan tick picks up the algo (`tail -f /tmp/quanttrader-scan.log`)
4. Operator install `crontab -e` entries for the 4 newly-ready crons (`validate-algo-monthly-cron.sh` + `prereg-expiration-cron.sh` + `broker-health-snapshot-cron.sh` + `broker-spread-sampler-cron.sh` — install commands in `scripts/README.md` reference crontab block)

---

## 7. What this packet is NOT

- **Not a guarantee.** Backtests are not real money. The demo gate exists because in-sample CI ≠ live performance.
- **Not "the system is finished."** CB.T1 is fully closed (42/43 src/lib/scan unit-tested as of 2026-06-23; only `llm-trader-prompts.ts` data registry exempt). Build-now infra queue exhausted (SG.5/6/6.1/6.2/9/9.1 + B.1.8 capture all shipped). Trigger-deferred items remain: B.1.8.a calibration (≥50 samples/symbol), Stage 4.2.c forex fills, Stage 4.3.1 multi-ticker support, B.1.23 portfolio-halt semantic, B.2.20/21 stat methodology — none block Stage 5.0.
- **Not a Phase C / Phase D plan.** Phase C is SUSPENDED (Stage 0.1); Stage 5 IS the re-entry to Phase C semantics. Phase D (institutional scaling, correlation-aware portfolios, LLM-trader reactivation) sits beyond Stage 5 success.
- **Not a forex strategy.** Stage 4.2.c real forex fill capture is MANDATORY before any forex deploy — this Gold algo's friction is measured from 37 FTMO MT5 fills; forex deploys would need a separate calibration.
- **Not LLM-trader.** The survivor is a pure deterministic-conditions algo (FVG pattern + daily_bias filter). LLM-trader reactivation (SG.8) is STEP 12 / Phase D.4 — separate decision tree.
- **Not Bear-Short Sentinel viable.** The one EXCLUDED algo (zero trades) is structurally broken — likely entry conditions impossibly tight for the gold corpus. Investigate or retire; not Stage 5 scope.

---

## 8. References

- Roadmap source: `/Users/jack.jones/.claude/projects/-Users-jack-jones-Documents-trading-app-demo-1/memory/project_roadmap_2026_06.md`
- Validator: `scripts/canonical/validate-algo.ts`
- B.6 cadence: `scripts/canonical/B6_continuous_validation_cadence.md`
- Pre-registration: `scripts/canonical/preregistration.json`
- Acceptance protocol: roadmap Stage 5 section
- Survivor algo backtest_results: `SELECT backtest_results FROM algorithms WHERE id='5f99ca15-c075-4c78-b0c6-4044b82f40dc'` (queryable via Supabase MCP)
- Fidelity gate test inventory: roadmap "CB.T1 Tier 1" section + `src/lib/scan/*.test.ts`
- Block-bootstrap verdict-shift context: `feedback_block_bootstrap_verdict_shift` memory
- OOS cutoff sweet spot derivation: `feedback_oos_cutoff_sweet_spot` memory
- Winner-rule floor: `feedback_winner_rule_return_within_ftmo` memory
- Stage 5.0 spec: roadmap Stage 5 section

---

**Operator action when ready:** stamp the 8 decisions in section 6 and I'll execute the un-pause sequence + install the monthly crontab entries.
