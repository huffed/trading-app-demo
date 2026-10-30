---
name: ftmo-rules
description: The FTMO 2-Step Swing rules the engine is built against (daily loss, max loss as a fixed floor, no account-failing consistency rule, Swing leverage) and this codebase's R conventions (risk per trade, R-multiple formulas, the lot floor, the win-rate floor). Use before sizing, reading a drawdown, or calling a backtest a pass.
---

# FTMO 2-Step Swing — the rules the engine is built against, and the R conventions

Use this when sizing, when reading a drawdown number, when judging whether a backtest "passes", or when a conversation mentions FTMO, daily loss, max loss, consistency, or R.

## The account the operator trades

**FTMO 2-Step Challenge, Swing variant** (decided 2026-05-02). Numbers below were verified against FTMO's FAQ on 2026-05-02 and must be re-verified before any new account purchase; FTMO changes rules. The engine's preset is `src/lib/constants/prop-firm.ts` (`PROP_FIRM_PRESETS.ftmo`).

| Rule | Challenge (phase 1) | Verification (phase 2) | Funded |
|---|---|---|---|
| Profit target | 10 % | 5 % | none |
| Max daily loss | 5 % of initial balance, measured on closed + open P&L for the day | same | same |
| Max loss | 10 % of **initial** balance | same | same |
| Minimum trading days | 4 | 4 | — |
| Time limit | none | none | — |
| Payout | — | — | 80 % to the trader, 90 % with scaling; every 14 days |

**Max loss is a fixed floor, not a trailing drawdown:** the account fails if equity touches `initial × 0.90`, whatever the peak was. Stress it as `min(equity) − initial` over rolling 60-day challenge windows, never as peak-to-trough. The operator-locked sizing rule is worst-window max loss **≤ 7–8 %** (headroom under the 10 % floor); the engine's hard gates are **≤ 5 % daily** and **≤ 10 % static** (`DEBT.md`, `feedback_ftmo_dd_gates_clarified`).

**Daily loss** trips on the lower of the two boundaries FTMO computes; the engine's `daily_loss_limit: 5` plus the portfolio halt (`src/lib/scan/portfolio-halt.ts`) and the risk pool cap (4 % combined open risk) are what keep a bad day under it.

**Consistency:** FTMO 2-Step has **no** account-failing consistency rule. The only consistency check is the payout-timing "Best Day ≤ 50 % of positive days' profit" review on funded accounts. The engine's `consistency_rule: 40` halt is a self-imposed safety, not an FTMO requirement; do not describe it as one.

**Swing leverage:** forex 1:30, indices 1:15, **metals 1:9**. On a $50K Swing account a 1 % risk gold trade with a ~100-pip stop needs ~0.05 lots and ~$2,500 margin (5 % of the account); keep concurrent gold positions to two. Standard-account leverage maths (1:30 gold) does **not** transfer.

**Swing privileges:** positions may be held through news and over weekends; that is why the 4h algorithms, with mean holds above 13 hours, use this variant.

## R conventions in this codebase

- **R** is risk-per-trade in money: `risk_dollars = equity_at_entry × risk_per_trade %`. Deployed algorithms use `risk_per_trade` sizing at **0.42 %** (interim; `scripts/canonical/ROADMAP.md`).
- **R-multiple of a trade** = `pnl / risk_dollars`. The baseline statistic (`r_nominal` in the golden file) uses the *nominal* risk; the live tracker and the LLM audit compute R with `(entry − stop) × quantity`. Three formulas exist and differ at the edges (`DEBT.md` D-02, D-11); say which one you mean.
- **Lot floor:** the backtester rounds to 0.01 lots and **skips** signals that would size below it; the paper engine does not floor; the broker mirror rounds down then clamps up to the minimum. At a $10K pool this removes 22 of 39 golden-file signals (`tests/golden/`). Never compare a $10K number with a $100K number without saying so.
- **Win rate floor:** 35 % per candidate and for the blended account (operator-locked from E2.30 onward).
- **"Passes FTMO" in a backtest** means: daily loss never ≥ 5 %, equity never ≤ initial − 10 %, and the stress over ≥ 500 rolling 60-day windows keeps the worst max loss ≤ 7–8 %. Profit target and minimum days are secondary.

## What not to assume

- Standard-account rules do not apply to Swing; Swing is a separate product.
- There is no hard consistency rule on 2-Step; only payout timing is affected.
- The 4-day minimum is a challenge-phase rule about lottery passes, not a distribution rule.
- `max_drawdown: 10` in the preset is the fixed floor from initial balance, not peak-to-trough.

Sources: FTMO FAQ pages for the 2-Step Challenge, consistency rules, Swing account type, news trading and overnight/weekend holding (verified 2026-05-02); `src/lib/constants/prop-firm.ts`; `docs/DEBT.md` D-02 and D-08; `scripts/canonical/ROADMAP.md` "Deploy methodology v4".
