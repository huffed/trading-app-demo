# Locked test window — pre-registration (2026-10-28)

**Decision (operator, 2026-10-28):** lock **XAU/USD from 2026-07-10 to 2026-10-28** as the final untouched test window. It is the only data the selection process never saw: every pinned gold bar ends 2026-07-09 and the last 12 months of the pins were re-cut as "out-of-sample" at least ten times during 2026-06 → 07. Everything after the pin date stays out of selection permanently; the window extends forward as time passes.

## Data
- Bars: `review/data/xau-usd-h4-pinned-2026-10-28.json` (sha256 `8551a4ce…`), `…-d-…` (`6658a9dc…`), `…-h1-…` (`0388b6eb…`) — OANDA practice, mid, complete candles, fetched 2026-10-28. Verified identical to the canonical pins on their overlap (`review/results/data-quality.json`).
- Window bars: H4 from `2026-07-10T01:00Z`; the window is **110 calendar days / ~79 trading days**.

## What has already touched the window, and why that is allowed
Phase 1's parity replay (`review/scripts/paper-replay.ts`) necessarily ran the deployed rules over this window to match live trades to backtest trades. Its outputs are **mechanics** (match rate, fill deltas, blocker table). No parameter, variant or gate decision may reference the window's performance; the sibling-aware backtest produced **10 trades** there (gross mean R +0.147) and that number is recorded here only so it cannot later be "discovered".

## Pre-registered criteria for "consistent with the backtest" (not precise thresholds)
Derived from the $100K sibling-aware baseline over 569 rolling 110-day windows (`pnpm dlx tsx review/scripts/window-stats.ts`, `review/results/window-stats.json`):

| Statistic in a 110-day window | Backtest distribution (2015 → 2026-07) | Consistency reading |
|---|---|---|
| Trade count | p5 = 7, p25 = 14, p50 = 22, p75 = 30, p95 = 46 (since 2025-07: p50 = 48) | **consistent** if the candidate's count on the window falls inside [p5, p95] = [7, 46]; outside → "cadence inconsistent" |
| Sign of mean R | positive in 66% of windows; mean R p5 = −0.79, p50 = +0.30, p95 = +1.20 | **consistent** if mean R > 0; a negative mean R is not a falsification on its own (34% of in-sample windows are negative) but the FINAL candidate must show mean R > 0 on this window to be called "not inconsistent" |
| Both together | — | "consistent" = count in range AND mean R > 0; "unclear" = exactly one holds; "inconsistent" = neither |

These are deliberately coarse: a 110-day window holds ~10–50 trades, so no precise mean-R threshold has power (Phase 1 §8).

## Rules of use
1. Phases 2–6 use only data up to 2026-07-09 for any fit, selection, ranking or gate derivation.
2. The window is evaluated **once**, at the end of Phase 6, for the single final candidate, and the result is reported whatever it says.
3. If the final candidate equals the deployed configuration, its window result is the 10-trade backtest already recorded above plus the live trades — reported, not re-fitted.
4. Any further OANDA refresh extends the window forward with a new hashed file under `review/data/`; the canonical pins are never modified.
