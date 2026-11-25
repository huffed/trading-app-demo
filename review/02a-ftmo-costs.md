# 02a — Phase 2's headline with FTMO's swap, and FTMO's nightly break

**Date:** 2026-11-25 · **Inputs:** the canonical pins (H4, D, M30), the rules snapshot (`review/inputs/deployed-rules-2026-11-21.json`), the 18 closed paper trades (`review/inputs/paper-record-2026-11-25.json`) and FTMO's XAU/USD costs as the operator read them on 18 November 2026 (§1). **Status:** first order. The swap is charged per trade on the Phase 2 trade list, with no re-sizing and no path effects (halts, cooldowns, sizing). Phase 6 puts it in the harness. The entry list is complete; nothing is re-priced.

**Reproduce:** `pnpm exec tsx review/scripts/ftmo-costs.ts` (§2, about 45 s), `pnpm exec tsx review/scripts/ftmo-break.ts` (§3 and §4, about 60 s) and, on a machine with the local journal, `pnpm exec tsx review/scripts/ftmo-clock.ts` (§1). Results: `review/results/ftmo-costs.json`, `ftmo-break.json`, `ftmo-break-trades.csv`, `ftmo-break-exits.csv`.

## 1. FTMO's costs, and what was checked about them

| Item | Value | Status |
|---|---|---|
| Long swap | −58.41 points a night, $0.5841 an ounce, 0.0156% of price, 5.7% a year | the operator's reading, 18 November 2026 |
| Long swap, second reading | $1.004 an ounce a night, 0.0196% of price, 7.1% a year | one real trade: a long of 0.1 lot at 5,126.69 held over the rollover of Tuesday 24 February 2026 was charged 10.04. It is in the operator's friend's MT5 journal (local file, gitignored) |
| Short swap | −4.2 points a night | the operator's reading; not used, no short trades here |
| Triple-swap night | Wednesday | unverified; FTMO's swap article says it is Wednesday for most instruments, not XAU/USD by name |
| Commission | 0.0014% of volume | in the journal, 22 of 22 gold trades carry exactly 0.0014% of entry notional in the Commissions column. That reads as a round turn; if the column is the opening leg only, it is half of one. Both cases are reported |
| Session | Monday to Friday, 01:05 to 23:50 platform time | operator's reading; one trade closed at 01:05:00 exactly on 25 February, the session open |
| Platform clock | GMT+2 in winter, GMT+3 from the US summer-time change | confirmed for GMT+2 and for the US calendar in March 2026 (below); the autumn change only from FTMO's notice |

**The platform clock, checked against FTMO fills in this repo.** This is independent of FTMO's notices.
- The friend's FTMO journal (the same gitignored file) has 22 gold trades between 13 February and 5 March 2026. Both prices of a trade lie inside the M30 bars (with one dollar of slack) for 22 of the 22 at GMT+2, against 4 of 22 at GMT+0, 3 at GMT+1 and 5 at GMT+3 (two of those have no bar). The winter offset is therefore GMT+2.
- The test between calendars needs the weeks of 8 to 29 March, when the US is in summer time and Europe is not. The journal has three FX trades there (one on 11 March, two on 13 March), with two legs each. All six legs lie inside the M30 pins at GMT+3; at GMT+2, three do not. The platform was on the US calendar, and so is the NY-close reading of the clock.
- FTMO fills from the mirrored demo in May 2026 at 22:15 and 22:30 UTC (archived `paper_positions`) would fall inside a break of 21:50 to 23:05 UTC, so the platform was not on a fixed GMT+2.
- Not confirmed: the autumn change. FTMO's 22 October 2026 notice dates it to 2 November, the US date (the first weekday after it); no fills in the week of 25 October to 1 November were found to test it.
- Not confirmed at all: the 01:05 and 23:50 times, which come from the symbols page and one trade; and the Friday close.

## 2. Phase 2's headline restated

The swap is charged as: the number of 17:00 New York rollovers the trade was open over (Monday to Friday, Wednesday counted three times), times the fraction of price per night, on the entry price. In R, that is units × fraction × price ÷ stop distance. A trade filled exactly at 17:00 New York is not charged for that night. The exit bar is placed by the engine's own rule on 4h bars, so each rollover is counted exactly.

| Case | Mean R | 95% interval (block bootstrap, 10,000) | Win rate | PF | Max DD (fixed $100K path) | Sum R |
|---|---|---|---|---|---|---|
| Phase 2, no swap (as published) | 0.343 | [0.180, 0.507] | 36.3% | 1.57 | 22.3% | 296 |
| **A: 0.0156% a night (the headline)** | **0.255** | **[0.093, 0.418]** | 36.3% | 1.41 | 27.7% | 220 |
| A with commission 0.0014%, round turn | 0.253 | [0.091, 0.416] | 36.3% | 1.40 | 27.8% | 218 |
| A with commission 0.0014% per side | 0.251 | [0.090, 0.414] | 36.3% | 1.40 | 28.0% | 217 |
| B: 0.0196% a night, as in February 2026 | 0.232 | [0.070, 0.395] | 36.3% | 1.37 | 29.1% | 200 |
| C-low: fed funds + 1.72 points, ÷ 360 | 0.278 | [0.120, 0.437] | 36.3% | 1.45 | 25.8% | 240 |
| C-high: fed funds + 3.41 points, ÷ 360 | 0.252 | [0.094, 0.410] | 36.3% | 1.40 | 27.4% | 217 |

Phase 2's figures reproduce exactly in the swap-free row (mean R 0.343, interval [0.180, 0.507], per-trade Sharpe 0.193).

- **The long hold is the cost.** A trade is open over 4.8 rollovers on average (the maximum is 114), and 19% are open over none. With Wednesday tripled the mean is 6.8 units, so a trade costs 0.088R on average (median 0.048R, 95th percentile 0.31R). One R here is a stop distance of about 1/123 of price (the mean), which is why a small fraction of price matters.
- **The swap is not a fixed cost.** Two readings of FTMO's long swap nine months apart differ by a quarter (0.0196% against 0.0156%). FTMO says its swaps are subject to regular change.
- **Which model is most honest.** A uses today's rate on the whole history. That overstates the cost in 2015–2017 and 2020–2021, when financing was near zero, and slightly understates it in 2023–2024 (C-low's fraction for mid-2023 is 0.0187%). C follows the interest rate and has the right shape, but the markup differs by a factor of two between the two FTMO readings, so it is not better calibrated. **A is the headline, per the brief. The honest range is 0.232 to 0.278, and the two-sided doubt is about the level of the swap, not its sign.** Every variant's interval excludes zero.

**The mean by year under A:** 2015 +0.012, 2016 +0.063, 2017 +0.216, 2018 −0.261, 2019 −0.141, 2020 +0.312, 2021 +0.053, 2022 +0.418, 2023 +0.427, 2024 +0.468, 2025 +0.789, 2026 (to 9 July) +0.351. Since July 2025 the mean is 0.609 (interval [0.142, 1.087]), against 0.653 without swap. The longest holds are 158, 102 and 97 days, so a few trades pay a lot of swap.

### The deflated Sharpe, restated

Per-trade Sharpe 0.146 under A, against 0.193 before. The grid is Phase 2's: trial counts 2,000 to 3,300 and cross-trial Sharpe spread σ.

| σ | Swap-free, N 2,000 / 3,300 | A, N 2,000 / 3,300 |
|---|---|---|
| 0.044 (the ROADMAP's within-family figure) | 0.903 / 0.867 | 0.436 / 0.366 |
| 0.060 | 0.337 / 0.252 | 0.032 / 0.018 |
| 0.069 (as observed across the five algorithms) | 0.083 / 0.047 | 0.003 / 0.001 |
| 0.100 | 0.000 | 0.000 |

N = 96, σ 0.044 (one Layer-B family): 0.995 → 0.863 under A.

**Correction to 02-validation.** Its §2.4 and verdict-inputs row quote "0.25–0.34 at the observed σ_SR 0.069". The stored grid has those cells at σ = 0.060, the nearest grid point, which the table's header calls "≈ observed … 0.069". At 0.069 itself the swap-free deflated Sharpe is 0.05 to 0.08. Phase 2's own text uses 0.060 in the table and 0.069 in the sentence, so the sentence overstates the result. The table and the conclusion ("under no defensible combination at N ≥ 2,000 does the portfolio clear 0.95") do not change. An erratum is appended to `02-validation.md`, with no line moved.

## 3. Entries in FTMO's nightly break

**The code, settled.** In the backtester the entry price is the signal bar's close (`src/lib/market-data/portfolio-backtest.ts:990`, `applySlippage(state.closes[i], …)`) and the trade's `entry_date` is that bar's opening stamp (`:1046`). The fill time is therefore `entry_date` + 4 hours: the bar's close. Live, the scan runs a few seconds after the bar closes (paper entries open within the same minute, or within a few). An entry dated 17:00 UTC is filled at 21:00 UTC in summer. So the only exposed slot is the bar that opens at 13:00 New York and closes at 17:00: 17:00 UTC in summer, 18:00 UTC in winter, 22:00 UTC once fills are counted in UTC.

**Which times count as the break.** FTMO's XAU/USD is closed from 23:50 to 01:05 platform time, Monday to Friday. With the US clock that is 16:50 to 18:05 New York, plus the weekend from Friday 16:50 to Sunday 18:05. A fill at 17:00 New York on Monday to Thursday falls in the nightly break; on Friday it falls in the weekend.

**The count, under the US clock:** 85 of the 862 backtest entries (9.9%), on 55 distinct signal bars, are filled at 17:00 New York.

| Algorithm | Summer nightly | Summer weekend | Winter nightly | Winter weekend | Total |
|---|---|---|---|---|---|
| ARB rr3_lb3 (r085) | 13 | 3 | 4 | 1 | 21 |
| Engulfing25 rr25_lb4 (r042) | 10 | 2 | 7 | 1 | 20 |
| ARB rr25_lb3 (r080) | 11 | 3 | 4 | 0 | 18 |
| Engulfing rr3_lb6 (r080) | 6 | 3 | 6 | 1 | 16 |
| OutsideBar v2 rr3_lb3 (r066) | 7 | 2 | 1 | 0 | 10 |
| **All** | **47** | **13** | **22** | **3** | **85** |

By season: summer 60, winter 25. By kind: nightly 69, weekend 16. The full list is `review/results/ftmo-break-trades.csv` (entry, UTC and New York fill times, exit, R after engine costs, exit placement). Before swap, their mean R is 0.26, against 0.34 for all 862; leaving them out would lift the mean of the rest by about 0.01R (0.343 to 0.352).

**How the clock changes the count:** US calendar 85; a clock fixed at GMT+2, 25 (winter only); European calendar, 76. The fixed clock is ruled out by the fills in §1. Seasonal only: in summer 60 under US, 51 under the European calendar and 0 under the fixed clock.

**What would have happened on FTMO:**
- **Nightly (69 entries):** the order is sent into a closed market and rejected. The paper row is closed with `broker_rejected` and zero P&L (`src/lib/scan/live-execution.ts:253-266`; the same comment records a Saturday 00:00 UTC rejection of 18 May 2026). Later scans read the same signal bar (it is the latest closed bar until 21:00 New York) and try again every 15 minutes. The re-entry cooldown counts losses only. So the entry is filled at the first tick after 18:05 New York, about 18:15, at a price up to 75 minutes later: **a fill at the reopen**, not at the bar's close. The reopen price is in the M30 pin for the following bar. Not modelled, as instructed.
- **Weekend (16 entries):** the last bar closes on Friday at 17:00 New York and FTMO reopens on Sunday at 18:05. The bar is then 49 hours old. The engine's staleness gate (1.5 × 240 minutes from the close, `src/lib/algorithm/bar-staleness-gate.ts`, the 360-minute threshold in the scan log) refuses it: **no fill.**
- Both paths are read from code and not executed. Today mirroring is off, so the live paper engine fills these entries from the quote (§4).

**Paper record: 4 of the 18 entries (22%), and 1 of 18 exits, fall in the break.**

| Trade | Entry, UTC / New York | Status on FTMO |
|---|---|---|
| Engulfing25, 31 August | 2026-08-31 21:00:09 / 17:00 | nightly: fill at the reopen |
| Engulfing, 31 August | 2026-08-31 21:00:20 / 17:00 | nightly: fill at the reopen |
| ARB25, 3 September | 2026-09-03 21:00:11 / 17:00 | nightly: fill at the reopen |
| ARB, 3 September | 2026-09-03 21:00:15 / 17:00 | nightly: fill at the reopen |
| OutsideBar, exit of 28 August | 2026-08-28 21:00:08 / Friday 17:00 | weekend: the stop could not fill until Sunday 18:05 |

(The two entry events are two distinct market moments, each shared by a pair of siblings.) Under a fixed-GMT+2 clock the four entries would be outside the break; under the European calendar the same four and the exit are inside.

## 4. Exits: what the break could change, and what would settle it

The 859 exits placed in the pins (the other three are stagnant exits) were located on 4h bars and then on 30-minute bars. 815 land clear of the break. **44 exits touch their level in one of the two M30 bars that straddle the break:**

| M30 bar | Exits | What cannot be told apart |
|---|---|---|
| 18:00 to 18:30 New York (first bar after OANDA's break, mostly Sunday reopen gaps) | 38 | the 5 minutes before FTMO reopens at 18:05 |
| 16:30 to 17:00 New York | 6 | the 10 minutes after FTMO closes at 16:50 |

An exit inside those minutes is not a fill on FTMO as the backtest booked it. A stop would fill at FTMO's first price after 18:05. 38 of the 44 are on the 18:00 bar, 24 of them on a Sunday, so most of the question is a reopen, where the engine fills a gapped stop at the bar's open and FTMO would open 5 minutes later. What would settle it: one-minute or tick prices on those 44 dates. Two of the 44 (12 April 2026, an ARB pair) are inside the Dukascopy ticks already on disk. The other 42 dates are not (the ticks cover 3 March to 3 September 2026). OANDA M1 bars for the 44 dates would settle them. **Nothing was fetched; this needs the operator's yes.**

## 5. The daily-loss reset at midnight in Prague

- FTMO's daily-loss day runs from midnight to midnight Prague time. In normal weeks that is 18:00 New York, inside FTMO's XAU/USD break: FTMO's day boundary and the session boundary are the same event. In the weeks of 8 to 29 March and 25 October to 1 November 2026 (and the matching weeks of other years) they differ: midnight Prague is then 19:00 New York, an hour into the new session.
- **The simulators use a UTC day.** Of the 859 exits placed on M30 bars, 47 (5.5%) fall on a UTC date that is not the Prague date (for example an exit at 23:30 UTC in winter belongs to FTMO's next day). Their daily-loss rule also compares floating equity against the previous day's level, where FTMO compares with the start-of-day balance, and some sources say the higher of balance and equity. Both differences are approximations already listed in the status file. The daily-loss count in the simulators is unverified against this, and 6A's field 6 carries it.

## 6. Not checked

- The weekday of the triple swap, by any FTMO source for XAU/USD.
- Whether FTMO charges the swap on a position opened after 00:00 platform time, or at any other minute (the engine's charge is the 17:00 rollover).
- The autumn clock change, by anything but FTMO's notice.
- The commission's two-sided reading: if the journal's Commissions column is the opening leg only, the commission is 0.0028% a round turn. The 0.0014% row and the 0.0028% row differ by 0.002R.
- The path effect of the swap on sizing and halts (first order only).
