## RETRACTION — Portfolio Acceptance Packet 2026-06-29 v1

**This file SUPERSEDES `portfolio-acceptance-2026-06-29.md`.** That earlier packet recommended G.6 STAMP based on a crude `combinedDrawdownPct` proxy that **understated true combined DD by 3x**. Operator-prompted audit (2026-06-29 EVE LATE) ran realistic dollar-pool simulation that exposed the error.

## Retraction summary

| Metric | v1 packet (crude proxy) | Realistic dollar-pool sim | Reality |
|---|---|---|---|
| Combined static DD | **9.66%** ✓ "FTMO compatible" | **28.98%** | **3x over FTMO 10%**, **6x over operator 5% gate** |
| Worst peak-trough period | not surfaced | 2016-07-06 → 2018-08-15 (~2 yrs) | underwater for 2 years |
| Monthly return | implied by per-algo annual | 1.79%/mo combined | below operator 2-3%/mo target |
| Daily DD | not computed | 3.95% | ✓ passes FTMO 5% |

**The v1 packet's recommendation to G.6 STAMP this portfolio is RETRACTED.**

## What went wrong (root cause)

`src/lib/algo-search/portfolio-composer.ts::combinedDrawdownPct` line 122:
```ts
// 1R = 1% capital DD by convention (matches portfolio-backtest assumption)
return maxDd;  // <-- maxDd computed in 1/N-scaled R units, not dollars
```

The 1/N scaling assumed equal-weight risk distribution (each algo runs at 1/N risk to share pool). In **actual deployment**, each algo runs at its own backtested risk_per_trade (1.0% each) and the pool absorbs ALL losses. The proxy is structurally too optimistic for any multi-algo portfolio at the same per-algo risk.

Verified empirically by `scripts/canonical/portfolio-realistic-sim.ts`:
- Per-algo individual DDs: 8.74%, 9.21%, 9.33% (matches step2 values)
- Crude proxy combined: 9.66% (≈ max-of-individual; structurally suspicious)
- Realistic dollar-pool combined: **28.98%** (algos share enough drawdown periods to stack losses over 10.5yr)

Filed as **E2.11 (composer bug fix)** in roadmap.

## The genuinely honest verdict (NO across operator's 3 questions)

1. **Will it likely never blow FTMO?** **NO.** 28.98% historical DD vs FTMO 10% — any challenge starting in 2016-2018 blows day 1.
2. **Will it get top profits?** **NO.** 1.79%/mo at full risk (below 2-3% target); at FTMO-safe risk (~0.17% per trade to fit DD ≤ 5%) it drops to ~0.3%/mo.
3. **Top quant firm happy?** **NO.** Single instrument + single timeframe + 2/3 same pattern + PBO 0.929 for ARB family + F2 1/4 single-survivor + per-trade Sharpe 0.20-0.27 + 2-year underwater period.

## What ACTUALLY needs to happen (filed as E2.12 — genuine operator input)

The empirical work establishes a 3-way deadlock at gold-only 4h deterministic-rules:
- DD gate ≤ 5% (operator) + Return target 2-3%/mo + Gold-only stage = 0 deterministic-rules solutions

Operator must pick from (per E2.12 in roadmap):
- **(a) Lower-risk single-algo demo** at ~0.5% risk per trade — accepts ~0.2-0.5%/mo, builds live data, $0 cost, 1-day ETA
- **(b) Override gold-only stage** → enable forex enumeration (4 instruments) — 1-2 week sweep + composer re-run
- **(c) Intraday 1m/5m gold scalper** per `[[project_gold_scalper_1m]]` — 3-4 week build, statistical power from ~240× more bars
- **(d) Phase I.2 LLM-trader restore** from archive — 1-2 weeks build, $25/mo within budget, LLM picks entries decorrelated from deterministic patterns
- **(e) Lower return target** to 0.5-1%/mo for first demo — accepts empirical floor, builds live track record

Recommend (a)+(e) IMMEDIATE + file (b)/(c)/(d) as next-quarter strategic decisions.

## Files

- `scripts/canonical/portfolio-realistic-sim.ts` — the realistic dollar-pool simulator built this turn (proves the bug)
- `scripts/canonical/e2-results/portfolio-realistic-2026-06-29.json` — empirical output
- `scripts/canonical/e2-results/portfolio-acceptance-2026-06-29.md` — v1 packet (NOW RETRACTED, see this doc)
- `scripts/canonical/ROADMAP.md` — lineage 2026-06-29 EVE LATE + E2.11 + E2.12 entries
- Memory: `feedback_combined_dd_proxy_misleading.md` (filed this turn)

Operator may proceed with E2.12 decision OR may direct further audit.
