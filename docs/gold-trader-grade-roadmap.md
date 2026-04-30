# Gold trader-grade roadmap

Status: **planning** · Drafted 2026-04-30 · Multi-week, sequenced

## Why

Goal: gold (XAU/USD) profit profile matching top algos and top manual traders — sustained 50-65% WR, 2-2.5× WLR, 8-15%/mo realised, 5-10% peak DD, 1-3 trades/day. Today's work brought Candidate B (Gold 15m RSI Fade Short) to 42.9% WR / 1.94× WLR / ~7.6%/mo at 1% risk on a 51-day sample — a real edge, but short of the target on stat width and trade frequency. The gap is closeable but requires multi-week compounding across signal density, exit sophistication, and stacking discipline.

## Anti-goals

- **Don't chase 80%+ WR via cherry-picked over-fitting.** Candidate A's failed inspect after a 86% green-window walk-forward was the warning shot — search-engine ranking is unreliable when per-window trade count < ~10.
- **Don't push risk_per_trade to the FTMO-safe ceiling.** The 1.92% calibration on Candidate B produced 10.28% DD on a 21-day sample (right at the FTMO 10% breach line). Dropping to 1% restored 7.37% DD with margin while staying positive-EV.
- **Don't deploy candidates straight from search rank.** Insert as draft → `inspect-algo.ts` on the long corpus → activate only if the fresh backtest holds the search's promise.
- **Don't fetishise win rate.** Optimise expectancy (R per trade). 50% × 2× WLR = same EV as 80% × 0.8× WLR with much better robustness across regimes.

## Current state (2026-04-30 EOS)

| Algo | Status | WR | WLR | Realised mo | DD | Notes |
|---|---|---|---|---|---|---|
| Forex testing (1h ICT 2-of-5) | paused + flattened | n/a | n/a | -1.25% today | n/a | Stale baseline + zero TP hits over 2.7yr corpus. Closed cleanly. |
| Candidate A (Gold 1h Multi-TF Confluence) | draft (NOT activated) | 28.6% | 2.39× | n/a | 2.85% | Fresh inspect on 173 days: 7 trades, -$307 net. Negative EV, won't activate as-is. |
| Candidate B (Gold 15m RSI Fade Short) | LIVE | 42.9% | 1.94× | ~7.6% | 7.37% | At 1% risk_per_trade, exit_conditions=[RSI>80]. Validated on 51-day sample, 35 trades. |

`inspect-algo.ts` available for any algorithm row: `ALGO_ID=<uuid> pnpm tsx scripts/inspect-algo.ts`. Generalised from the original active-algo-only inspector.

## Phase 1 — Stacking + exit conditions (3-5 days)

**Goal:** 4-6 validated gold algos live, each with appropriate exit conditions, aggregate 1-3 trades/day, aggregate 50%+ WR.

Tasks:
1. **Vet candidates 3-10 from the gold combinatorial search via `inspect-algo.ts` on long corpus.** Reject any with: negative EV; WR < 35%; trade count per sample < 5. Expect 30-50% of candidates to fail (Candidate A's lesson).
2. **Deploy 2-4 surviving candidates as drafts** at risk_per_trade=1%, max_positions=1, max_per_ticker=1. Total live risk caps at ~4-6%, well inside FTMO 5% DLL.
3. **Add `exit_conditions` to each** based on signal class:
   - RSI fade family → exit on RSI extreme opposite (e.g., RSI > 80 for short-side fade)
   - Momentum family → exit on opposite momentum confirmation
   - Multi-TF confluence → exit on `daily_bias` flip or 4h pattern reversal
   - Trend pullback → exit on RSI back to neutral / trend invalidation
4. **Re-validate each draft with `inspect-algo.ts` after exit conditions added.** Activate only those that pass post-exit validation.
5. **Diversify by direction.** Candidate B is short-side mean-reversion. Find at least one long-side gold strategy that survives validation. Different signal class.

**Definition of done:** 4-6 active gold algos, each independently validated, aggregate trade frequency 1-3/day, no single algo at FTMO-safe-cap risk.

## Phase 2 — Exit infrastructure (1-2 weeks)

**Goal:** Trailing stops + breakeven SL moves in schema + backtest engine + scan engine. Expected +0.3-0.5× WLR ratio uplift across all algos.

Tasks:
1. **Schema:** add `trailing_stop` (activation R-threshold + trail R-distance) and `breakeven_move` (R-threshold trigger) to `AlgorithmRules`. Update Zod validators.
2. **Backtest engine:** implement trailing stop logic (ratchet SL up as price moves favourable, never backstep) + breakeven move (after first R-threshold reached, move SL to entry).
3. **Scan engine:** same logic on the live side; manage cron updates SL price on the broker via MetaApi.
4. **Tests:** trailing fires at correct prices, doesn't backstep, doesn't trigger before activation threshold. Breakeven moves once.
5. **Re-run `inspect-algo.ts` on Candidate B + stacked candidates** to measure uplift. Compare WR / WLR / DD before vs after.
6. **Update persisted `backtest_results`** for any algo whose stats materially change.

**Risk:** schema migration. Existing rules without these fields default to "disabled" — backwards compatible.

## Phase 3 — Multi-leg positions / partial profit-taking (2-3 weeks)

**Goal:** Match the "scale out at 1R, runner with trailing" pattern that successful manual scalpers use. Biggest single uplift to total return per algo.

Tasks:
1. **Schema:** position model becomes multi-leg. Each entry can have N take-profit levels with proportional position split (e.g., 33% off at 1R, 33% at 2R, 33% runner).
2. **Backtest engine:** track legs separately. Each leg has its own TP price; SL applies to all legs (or per-leg if configured).
3. **Scan engine:** place multiple TP orders on the broker. Update broker mirror to track each leg's broker_position_id.
4. **`paper_positions` schema:** add leg metadata or refactor to multi-row representation.
5. **UI:** position card shows leg states (filled / running / closed).
6. **Migration plan** for existing single-leg positions; backwards compatibility.
7. **Tests + dual validation** against single-leg behaviour at the simplest config.

**Risk:** biggest engineering project. Touches schema, engine, scan, broker mirror, UI, tests. Treat as a 2-3 week branch with multiple PRs.

## Phase 4 — Pattern library expansion + adaptive systems (2-4 weeks)

**Goal:** 10-15 new pattern detectors. Regime detection. Auto-pause on rolling drift. Continuous discovery loop.

Tasks:
1. **New pattern detectors:** volume profile breaks, divergence types (RSI / MACD / OBV), specific candle confluences (3-bar reversal, hammer at structural level, etc.). Each goes through research → build → walk-forward → accept/reject.
2. **Regime classifier per asset:** trending vs ranging, high-vol vs low-vol. Combinatorial search filters candidates by regime fit.
3. **Auto-tuning:** parameters adjust based on rolling performance. Conservative — only adjust by ±20% from baseline, only after N trades.
4. **Auto-pause on drift:** algo halts when rolling WR drifts > X pp below baseline OR rolling DD exceeds Y% of cap. Existing `drift-detector.ts` is the foundation.

## Open questions

1. **Phase 1 entry breadth.** RSI fade entry uses RSI > 70. Loosening to RSI > 65 or RSI > 60 could increase trade frequency but lower WR. Worth a parameter sweep — but only after stacking saturates as a frequency lever.
2. **Phase 2 timing.** Start in parallel with Phase 1 stacking, or after Phase 1 stabilises? Recommend after — avoid changing engine behaviour while stacking validation is in flight.
3. **Phase 3 priority.** Multi-leg is the biggest uplift but biggest engineering project. Could it be deferred until Phase 1+2 saturate? Probably yes — Phase 1+2 likely take Candidate B from 7.6%/mo to 12-15%/mo without multi-leg, before diminishing returns kick in.
4. **Cross-asset expansion.** Move to silver / oil / forex once gold profile matures, or stay gold-only? XAU/USD has strong directional trends + clear macro drivers; gold-specific competence may transfer poorly. Defer until Phase 1+2 done on gold.

## Definition of done (overall)

The roadmap is "complete" when:
- 4+ gold algos live, each with WR ≥ 45%, WLR ≥ 1.8×, validated on long corpus
- Aggregate 1-3 trades/day on XAU/USD
- Aggregate realised return ≥ 8%/mo with peak DD ≤ 8% over a 60-day rolling window
- Trailing stops + partial profit-taking standard infrastructure
- Drift detector + auto-pause active on each algo
- Pattern library has at least 20 detectors validated

That's the destination. Each phase is a step toward it; each step has its own go/no-go criterion before moving to the next.
