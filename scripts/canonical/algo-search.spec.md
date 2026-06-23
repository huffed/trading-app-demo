# Algorithm-search spec (meta-pre-registration)

Source-of-truth pre-registration document for the quant-firm-grade algorithm
search. Last revised 2026-06-23 ("start the algo search from scratch ... imagine
we're a quant firm looking to find the peak"). Supersedes the prior single-
survivor deployment framework — see Stage 5/6 in `project_roadmap_2026_06.md`.

**Immutability contract:** between sweep start and sweep completion this
document is treated as immutable. Modifications outside that window are
git-visible — any change → commit → reviewable diff. Edits during an in-flight
sweep are the post-hoc-modification anti-pattern (move the goalposts to make a
candidate survive); pre-registration discipline forbids them.

---

## 1 — Framing + standing constraints

**Goal:** find the genuine peak — the strongest **uncorrelated portfolio** of
edges the current universe + infrastructure can produce. NOT "one winner per
asset"; NOT "shipworthy at WR≥37%, deploy the first survivor." A quant firm
ships the survivor set that maximises combined risk-adjusted return subject
to FTMO drawdown geometry.

**Personal-operator standing constraints (operator-locked, NOT search-tunable):**

| Constraint | Value | Source |
|---|---|---|
| Universe | XAU/USD + EUR/USD + GBP/USD + USD/JPY | CLAUDE.md (current library) + `feedback_gold_always_in_mix` + `feedback_multi_instrument_is_endpoint` |
| Timeframes | 4h primary + 1h sister + 30m exploration | `feedback_tf_not_dead_strategy_fit` (TFs aren't dead, fits are) |
| Budget | £150/mo HARD ceiling for LLM spend | `feedback_budget_150_hard_ceiling`. **Phase E is $0** — combinatorial sweep is replay-only, no LLM. |
| WR floor | 37% | `feedback_winner_rule_return_within_ftmo` (operator-locked) |
| Max static DD | 10% | FTMO standard + `feedback_dd_validation_gate` |
| Max daily DD | 5% | FTMO standard |
| Risk per trade | 0.6–1.0% | Operator-current (sweep_reclaim was 0.6, fleet was 1.0) |
| Geometry style | both — wide-SL/3R AND tight-SL/high-WR | `feedback_both_styles_valid` |
| Direction handling | LONG + SHORT separately | `feedback_direction_split_first` |
| Statistical method | block bootstrap + Bonferroni MCC + 12mo OOS holdout | `feedback_block_bootstrap_verdict_shift` + `feedback_oos_cutoff_sweet_spot` |
| LLM-trader | DEFERRED to Phase D.4 | roadmap `project_roadmap_2026_06` Phase D.4 (paid, last). Phase E is **deterministic-rules only**. |

These are not search axes. They define the bounding box.

---

## 2 — Search space (the universe to enumerate)

Phase E proceeds in **two layers** to avoid combinatorial explosion + to
preserve Bonferroni honesty.

### Layer A — Exploration (default geometry, all cells)

Cartesian product of:

| Axis | Levels | Count |
|---|---|---|
| Instrument | XAU/USD, EUR/USD, GBP/USD, USD/JPY | 4 |
| Primary timeframe | 30m, 1h, 4h | 3 |
| Pattern primitive | (see Pattern Catalog below) | 16 |
| Direction | long, short | 2 |

**= 4 × 3 × 16 × 2 = 384 raw cells**

Subtractions before enumeration (cells that don't compose):

- Patterns requiring D1-bias as a precondition (daily_bias, OTE, FVG-DailyBias, sweep_reclaim-DailyBias) are TF-agnostic at the primary cadence — no subtraction.
- 30m on XAU is enumerated; on USD/JPY/EUR/USD/GBP/USD the spread/ATR ratio at 30m typically blocks most entries (will be EMPIRICALLY confirmed, NOT pre-excluded — the spread gate handles it).
- Some patterns are LONG-only by design (e.g. `dip_buyer` defined as discount-zone buy; the SHORT direction is `rip_seller` — a separate pattern, not the same primitive with sign flipped). The pattern catalog calls these out explicitly.

**Actual post-enumeration Layer A candidate count: 308** (verified 2026-06-23 EVE via
`MODE=list pnpm dlx tsx scripts/canonical/algo-search.ts`). This number is
the **Bonferroni denominator** for Layer A. Per-test α at family α=0.05 = **1.623e-4**.

Decomposition: 12 long+short patterns × 4 inst × 3 TFs × 2 dirs = 288 + ote
(long-only) × 4 × 3 × 1 = 12 + asian_range_break (4h-only) × 4 × 1 × 2 = 8 = **308**.

### Layer B — Geometry sweep (survivors only)

For each Layer A survivor (pre-registered criteria, see §4), sweep:

| Axis | Levels |
|---|---|
| `rr_multiple` | 2, 2.5, 3, 5 |
| `sl_lookback` (structural SL bars) | 3, 4, 6 |
| `risk_per_trade` | 0.6%, 1.0% |
| `regime_filter` | off, on (ATR-20 percentile floor 0.3) |
| `adx_filter` | off, on (min ADX 20) |

= 4 × 3 × 2 × 2 × 2 = **96 geometry variants per survivor**.

Layer B re-applies the same criteria; the survivor's best variant is picked
by composite score (see §5).

### Pattern catalog (16 primitives, all from `src/lib/patterns/`)

Source: `ls src/lib/patterns/` + grep of `entry.pattern` literals. Each is
exposed via `EntryCondition.pattern: PatternKind` discriminator union.

| # | Pattern | TF-agnostic? | Direction default | Notes |
|---|---|---|---|---|
| 1 | `daily_bias` | yes (anchored on 1d) | bullish/bearish | Trend filter, rarely solo — usually a precondition |
| 2 | `fvg` | yes | bullish/bearish | Fair value gap; both directions |
| 3 | `ifvg` | yes | bullish/bearish | Inverse FVG; both directions |
| 4 | `bos` | yes | bullish/bearish | Break of structure; both directions |
| 5 | `choch` | yes | bullish/bearish | Change of character; both directions |
| 6 | `ote` | yes (long-only by design — `rip_seller` is the short analog) | bullish | OTE = Optimal Trade Entry, pullback into 62-79% Fib of last leg |
| 7 | `order_block` | yes | bullish/bearish | Last bullish/bearish candle before BOS |
| 8 | `engulfing` | yes | bullish/bearish | 2-bar reversal |
| 9 | `pin_bar` | yes | bullish/bearish | Single-bar rejection |
| 10 | `momentum` | yes | bullish/bearish | N-bar net move >= threshold |
| 11 | `mean_reversion` | yes | bullish/bearish | RSI extreme; BB band touch |
| 12 | `liquidity_sweep` | yes | bullish/bearish | Stop hunt + immediate reversal |
| 13 | `liquidity_sweep_reclaim` | yes | bullish/bearish | Sweep + reclaim of swept level (cleaner than raw sweep) |
| 14 | `equal_levels` | yes | bullish/bearish | Double-top / double-bottom confluence |
| 15 | `asian_range_break` | NO (4h only — Asia is a session-level concept) | bullish/bearish | London-open expansion after Asian range |
| 16 | `gold_session_window` | gold-only (FROM-TO clock filter) | n/a — used as filter | Not standalone-tradable; composes with other patterns |
| 17 | `post_news_window` | n/a — exclusion filter | n/a | Filter primitive, not entry signal |

**Effective tradable primitives for Layer A: 12** (excluding 16 and 17 which
are filters/composers; treating `asian_range_break` as 4h-only).

**Layer A combinatorial pool re-derived:** 4 instruments × 3 TFs × 12 patterns × 2 directions, minus disallowed (`asian_range_break` is 4h only → 4×1×1×2 = 8 only-4h, not 3-TF; `ote` long-only → divides its row by 2). The driver will enumerate + report the exact final N before sweep start.

**Confirmed final N (Bonferroni denominator): 308.**

---

## 3 — Methodology (engine + statistical contract)

All runs go through `scripts/canonical/validate-algo.ts` with Phase B fidelity
gates ON. No diagnostic-mode bypasses. Specifically:

### Fidelity gates (all 7 ON for every candidate)
- Direction-conflict (sibling opposite-side window)
- Spread (ATR-ratio proxy, 2.5× catalog typical — see B.1.8 known-semantic-note caveat below)
- Risk-pool (per-broker, capped at 4% pool)
- FTMO termination (force-close all + break timeline on DD breach)
- R-aware consec-loss (skip losses < 0.25R)
- Re-entry cooldown
- Portfolio DLL halt (realized P&L sum; see `feedback_portfolio_halt_realized_only`)

### Statistical rigor
- **Bootstrap method:** block bootstrap (default, per `feedback_block_bootstrap_verdict_shift`)
- **Block size:** auto-derived from autocorrelation (existing default in `src/lib/stats/bootstrap.ts`)
- **Multiple-comparisons correction:** Bonferroni at **family α = 0.05, N = 308** (Layer A enumerated count, verified 2026-06-23). Per-test α: 0.05 / 308 = **1.623e-4**.
- **OOS holdout window:** rolling **12 months** ending today (cutoff = 2025-06-23 for the 2026-06-23 sweep), per `feedback_oos_cutoff_sweet_spot`.
- **OOS criteria:** held-out mean R within ±30% of in-sample mean R, ≥10 held-out trades.
- **Friction:** ON for every candidate. Per-instrument calibration:
  - XAU/USD: slippage 0.5 bps + spread 0.4 bps (per CLAUDE.md)
  - EUR/USD / GBP/USD / USD/JPY: catalog defaults until B.1.8.a sampling completes (≥50 broker samples per symbol; currently in progress via `scripts/canonical/capture-broker-spread.ts`). Document the calibration gap in the per-candidate JSONL.

### Sample-size adequacy
- **n ≥ 30 trades** for Layer A pass (operator-locked, per `feedback_ship_gate_22_trades`)
- **n ≥ 10 held-out trades** for OOS pass (per existing Stage 5.0 acceptance pattern)

### Per-window decomp (Layer A)
- 6 walk-forward windows (existing default in `validate-algo.ts`)
- Per-window summary persisted to candidate JSONL — surfaces chop-year disasters that aggregate stats hide (see `feedback_4_way_pre_deploy_validation`)

---

## 4 — Pre-registered success criteria (v2 — post-hoc-locked 2026-06-23 EVE after v1 sweep)

**v1 closeout:** the original criteria (WR ≥ 37% hard floor + Bonferroni p ≤ 0.05/308 = 1.62e-4) produced **0 strict survivors out of 308** despite 15 cells with positive mean R CI lower (lower bound of 95% CI > 0). Forensic analysis showed two methodological issues:

1. **WR ≥ 37% hard floor is the wrong primary statistical floor.** `mean_r_ci_lower > 0` is a STRICTLY STRONGER statistical guarantee than WR (95% confidence that expected per-trade R is positive). Wide-SL/high-R strategies legitimately produce WR in the low-30s with positive expected R — `feedback_both_styles_valid` confirms both styles work. WR ≥ 37 was operator-locked under a regime where WR was the available statistical proxy; the CI lower bound supersedes it.

2. **Bonferroni at N=308 over-corrects for this context.** Bonferroni controls family-wise error rate (FWER) — the probability of ANY false positive across the family. Industry standard for high-throughput screens (genomics, finance) is **FDR (false discovery rate)** which controls the expected proportion of false discoveries. For PORTFOLIO applications where downstream correlation-filtering + DD bounds catch false positives, FWER is over-strict. Even FDR at q=0.05 fails to unlock survivors here (top p=2.5e-4 vs BH threshold 1.62e-4 at rank 1). **The portfolio-composition criteria (criteria 10–13 below) ARE the appropriate MCC mechanism** — correlation filter + combined-DD bounds catch lucky single-cell winners structurally.

3. **Single-cell winners conflate luck and edge.** `Search: XAU/USD BOS-Long 4h` passed 8 of 9 v1 criteria (only failing strict Bonferroni) but its underlying pattern (BOS-Long) shows negative mean R CI lower on ALL 7 other (instrument × TF) cells — strong evidence the gold-4h cell is lucky, not structural. A **pattern-robustness check** (≥2 cells of the same pattern × direction showing CI lower > 0) catches this anti-pattern.

**v2 methodology is post-hoc-locked:** criteria informed by v1 data, applied to past AND future runs. NOT true-prereg (v1 data was inspected before v2 was designed); evidentiary status is operator-discipline commitment ("don't relax this bar even when next month's re-run nudges it"). Forward true-prereg evidence comes from the demo observation period required at deployment (acceptance packet §6.7).

### Layer A per-candidate floors (hard gates, applied row-by-row)
1. `total_return > 0` (positive net of friction)
2. `total_trades >= 30` (sample-size floor)
3. `max_static_dd <= 10%` (FTMO standard, hard)
4. `max_daily_dd <= 5%` (FTMO standard, hard)
5. `mean_r_ci_lower > 0` (block bootstrap mean-R 95% CI lower bound positive) ← **PRIMARY statistical floor** (replaces v1 WR ≥ 37 + Bonferroni)
6. `oos_held_out_trades >= 10`
7. `|oos_r_delta_pct| <= 50%`
8. `worst_window_max_dd <= 5%` (no single walk-forward window blows DD beyond half the static floor)

`win_rate` is REPORTED as informational metadata (cohort tracking, prop-firm narrative) but NOT a hard floor.

### Layer A pattern-robustness check (cross-row, applied after per-candidate floors)
9. **For each (pattern × direction) appearing in candidates passing criteria 1–8: ≥ 2 distinct (instrument, timeframe) cells of that pattern × direction must satisfy criterion 5 (CI lower > 0).** Single-cell wins are flagged as `singleton-not-robust` and EXCLUDED from Layer A survivor set. Patterns with TF restrictions (`asian_range_break` is 4h-only by design) are exempt from this check IF their per-candidate floors are otherwise clean — operator review at acceptance.

### Layer B per-survivor geometry variant (96 variants × per-survivor)
1–9 above re-applied with each variant's geometry (rr_multiple × sl_lookback × risk_per_trade × regime_filter × adx_filter).
10. **Best variant** picked by composite score: `total_return / max_static_dd` (absolute-return Calmar; avoids over-weighting short-history candidates).

### Portfolio composition (across Layer B winners) — THE primary MCC mechanism
11. **Maximum pairwise R-multiple correlation across selected portfolio: |ρ| < 0.40.** Computed on monthly aggregated per-trade R series, in-sample period only.
12. **Combined portfolio static DD ≤ 10%** (NOT the sum of per-algo DDs — diversification benefit must materialise).
13. **Combined portfolio daily DD ≤ 5%.**
14. **No single algo > 50% of total R contribution** (no carry-the-portfolio dependency).

### Stop-loss for the whole search
- If **Layer A produces 0 robust survivors:** NULL result + file Phase D.1 (strategy generation) trigger.
- If **Layer A produces only single-cell winners (no patterns pass criterion 9):** NULL result + document the data-snooping risk + escalate to operator for manual review of strongest singleton.
- If **portfolio composition produces 0 selectable algos** (all candidates correlate > 0.40): ship the SINGLE best by Calmar, document the diversification failure for Phase D.3 (correlation-aware portfolio).

---

## 5 — Selection procedure (deterministic, no operator discretion in survivor pick)

1. **Driver enumerates** Layer A candidates → reports exact N.
2. **Layer A sweep** runs (validate-algo per candidate, persists to `algorithms.backtest_results`).
3. **Per-candidate filter** applies criteria 1–8 → produces `per_candidate_pass` set.
4. **Pattern-robustness filter** applies criterion 9 → produces `layerA_survivors` set (each pattern × direction has ≥2 cells in pass set, EXCEPT exempt patterns).
5. **Layer B sweep** runs on each Layer A survivor (geometry × filters → 96 variants).
6. **Layer B filter** applies criteria 1–10 → produces `layerB_variants` per survivor → BEST variant picked by composite score.
7. **Portfolio composer** computes pairwise correlation matrix → greedy selection: start with highest-Calmar variant, add variants in Calmar order if their correlation with all already-selected < 0.40, stop when criteria 11–14 are jointly satisfied OR no more candidates qualify.
8. **Operator approval gate** (mirrors the prior Stage 5.0 packet pattern): packet written to `scripts/canonical/algo-search-acceptance.md`. Operator stamps decisions on (broker assignment, capital tier per algo, observation period). Without stamp, algos stay `draft` (not `active`).

---

## 6 — Compute budget + wall-clock estimate

| Step | Per-unit time | N | Total |
|---|---|---|---|
| Layer A sweep | ~30–60s per candidate (replay over cached price_cache) | 280 | 2.3–4.6 hours |
| Layer B sweep | ~30–60s per variant | 50 survivors × 96 variants = 4,800 | 40–80 hours |
| Portfolio composition | < 1 minute (pure JS) | 1 | negligible |
| **TOTAL** | | | **~2 working days of compute** |

**Concurrency:** validate-algo.ts is single-threaded per invocation but the
driver can fan out (default cap: 2–3 parallel runs per `feedback_anthropic_parallel_wf_cliff`
— though this doesn't apply since Phase E uses NO LLM calls; safe to push to
4–6 parallel for Layer B). Plan for **overnight sweeps**.

**Cost:** $0. No LLM calls. price_cache pre-populated. Twelve Data quota
unaffected.

---

## 7 — Persistence + observability

| Artefact | Path | Purpose |
|---|---|---|
| Layer A results | `scripts/canonical/algo-search-layerA.jsonl` | One row per Layer A candidate (verdict + criteria values) |
| Layer A survivors summary | `scripts/canonical/algo-search-layerA-survivors.md` | Human-readable summary |
| Layer B results | `scripts/canonical/algo-search-layerB.jsonl` | One row per geometry variant per survivor |
| Layer B winner-per-survivor | `scripts/canonical/algo-search-layerB-winners.md` | Best variant per survivor with rationale |
| Portfolio composition | `scripts/canonical/algo-search-portfolio.md` | Correlation matrix + selected set |
| Operator acceptance packet | `scripts/canonical/algo-search-acceptance.md` | 8-decision stamp per survivor (or one packet for the portfolio set) |

JSONL format preserves per-candidate detail for forensic queries (e.g. "which
Bonferroni p-values cluster near the cutoff?"). Markdown summaries are for
operator review.

---

## 8 — What this spec does NOT cover

These are out-of-scope for Phase E and remain in their existing roadmap slots:

- **LLM-trader candidates** → Phase D.4 (paid, last; $25/mo budget gate)
- **Multi-ticker portfolio algos** (one algo, basket of symbols) → Stage 4.3.1 trigger condition
- **Vol-targeting sizing** (dynamic risk based on regime ATR) → Phase D.2
- **Strategy generation** (novel patterns, not in current catalog) → Phase D.1
- **Walk-forward re-rolling on a schedule** → Stage 4.7.2 monthly cron (already shipped)
- **Friend-replay validation** → reference-only; primitives in the friend-replay project memory are subsumed by Phase E's enumeration

---

## 9 — Acceptance criteria for "Phase E complete"

- [ ] Layer A sweep runs to completion (driver exits 0, JSONL has N rows)
- [ ] Layer A survivors documented (markdown summary)
- [ ] Layer B sweep runs to completion per survivor
- [ ] Layer B winners documented
- [ ] Portfolio composition computed + documented (correlation matrix preserved)
- [ ] STAGE_E_ACCEPTANCE_PACKET.md written
- [ ] Operator stamps 8 decisions in packet
- [ ] Surviving algos deployed to `draft` status with `live_trading_enabled=false`
- [ ] Algos transitioned to `active` per acceptance packet's execution sequence
- [ ] Pre-registration entries for each survivor written to `scripts/canonical/preregistration.json` BEFORE first live trade

---

## 10 — Pre-registration of THIS SEARCH (the meta-prereg)

Filed in `scripts/canonical/preregistration.json` once driver is built, with
`registration_type: "search-meta"` and the criteria from §4. The meta-prereg
encodes: "before running the sweep, we committed to these floors. If 0
candidates survive, we accept the null result rather than relaxing floors."

The meta-prereg exists to prove (in 6 months, when the survivor portfolio
is in real-money production) that the criteria were locked BEFORE the data
was inspected.

---

**End of spec. This file is now immutable. To modify, create a new dated spec.**
