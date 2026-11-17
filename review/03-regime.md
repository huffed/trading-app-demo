# 03 — Regime analysis (Phase 3)

**Date:** 2026-11-17 · **Branch:** `review/skeptical-audit-2026-10` (dev merged at `ee5a8a0`) · **Starting point:** 01-audit A18 (why no trades for 54 days), A15 (removing `daily_bias` raises P&L), 02-validation §2.1/§2.5 (yearly mean R tracks gold's yearly return, ρ = 0.65).

**Reproduce every number:** `pnpm exec tsx review/scripts/phase3-regime.ts` (≈5 min → `review/results/phase3-regime.json`, `phase3-trades.json`) and `pnpm exec tsx review/scripts/phase3-stress.ts` (≈8 min → `phase3-stress.json`). Inputs: the canonical pinned XAU/USD H4 and session dailies 2015-01-01 → 2026-07-09 (the selection corpus), the five deployed rule sets read from the live DB, the repo's own engine run sibling-aware at **$100K / 0.42% uniform risk** (the Phase 2 population). **The locked window 2026-07-10 → 10-28 is not evaluated by any rule set here**; the 2026-10-28 refresh is used once, to describe the market's bias runs, not to score anything. The 2026 live record (§3.7) is the deployed configuration's own paper result, which `locked-window.md` rule 3 allows to be reported.

Five rule sets, each the deployed five with one transform:

| Set | What it is |
|---|---|
| `L_on` | the five deployed rules (long, `daily_bias` bullish) — identical to the Phase 2 baseline: n=862, mean R 0.343 |
| `L_off` | the same five with the `daily_bias` condition removed |
| `S_on` | the five mirrored short: `side: short`, pattern direction bearish, `daily_bias` bearish |
| `S_off` | the mirror without the bias condition |
| `LS_on` | `L_on` + `S_on` run together as ten members (the engine's direction-conflict and risk-pool gates apply across them) |

R = `pnl / (equity_at_entry × 0.42%)` as in Phase 2. "Bias" below always means the engine's own rule: session close above the 20-session SMA = bullish, below = bearish, read from the last completed session before the entry bar. A "bias run" is a stretch of consecutive sessions with the same bias; "≥15 sessions" (about three trading weeks) is the cut used for "sustained".

## Verdict inputs in one table

| Question | Answer | Where |
|---|---|---|
| What does the bias filter actually do? | It keeps the system out of sustained downtrends (1 trade in the 692 sessions inside bearish runs ≥15; the unfiltered longs lose 74R there) and costs more than it saves elsewhere: without it there are 503 more trades at about the same mean R (0.329 vs 0.343), +153R and +$84K more total P&L, the same whole-corpus max drawdown (20.3% vs 22.3%), 4 empty months instead of 19. The trades it removes average **+0.26R** (n=678): −0.17R when the bearish spell turns out to last ≥15 sessions, **+0.73R** when it does not (dips in uptrends). The filter cannot tell those apart in advance, and nothing measured here can either (§3.3). What it buys is the tail: on the challenge simulators the unfiltered set is funded more often and sooner (97% in ≈15 months vs 84% in ≈20 at $50K / 0.30%) but its probability of a max-loss breach roughly doubles (6.1% vs 3.5%; 13.3% vs 10.1% at 0.42%, with three breaching 60-day windows against none), and its worst 60-day loss sits within 1.5 points of the floor in six years of twelve against one. A drawdown decision, not a mean-R one. | §3.1–3.4, §3.6 |
| Does a short mirror under a bearish bias work? | **No.** 653 trades, mean R −0.103, −$28K, max DD 63%; negative in every year 2019–2025 (−$14K in each of 2023 and 2024), positive only 2015–2018 and 2026 H1 (+$1.6K). It makes +131R inside sustained bearish runs and loses 199R outside them, and it is negative at every age of the bearish run (§3.3): shorting gold's dips in a secular bull market is the cost. Adding it to the longs (`LS_on`) lowers mean R to 0.223 and total P&L to $130K (from $140K) for 389 extra trades, same DD. | §3.5 |
| Which regime variable best predicts yearly mean R? | **Gold's own return in the same year** (Spearman 0.58, Pearson 0.65 on mean R; Pearson 0.85 on sum R; best variable in 7 of 12 leave-one-year-out fits), then the share of bullish-bias sessions. Both are *coincident*: known at the end of the year. **Nothing measured in a quarter predicts the next quarter**: the best of ten variables reaches ρ = 0.26 (ATR/price, 42 quarters, p ≈ 0.10) and the sign is not stable across the mean-R and sum-R versions. There is no regime switch to time from trend, volatility, bias persistence or ADX. | §3.4 |
| What is a long-only gold strategy worth in a year like 2018 or 2026? | **2018:** 72 trades, −12.3R, **−$5,545**, a 14.6% drawdown on the fixed-sizing path (an FTMO account fails at 10%), 132 consecutive days without a trade, 3 empty months. **2026:** Jan → Jul 9 (backtest, in-sample) 39 trades, +14.7R, +$7.5K with a 91-day gap and 3 empty months; Jul 20 → Nov 17 (live paper) **18 trades, 3 wins, −9.9R, −$4,145**, 62 days with no position while gold fell 9%. Net for the year so far about +$3K on $100K. In plain words: in a year like that the system earns nothing or a small loss, by design sits out the fall, and gives back part of its gains at the turns; a challenge started in such a year stalls or fails. | §3.7 |
| Was the teammate's mechanism (A18) right? | Yes, as a description: after each of the 29 sustained bearish runs the long-only set re-entered and made +0.46R per trade over the next 40 sessions (313 trades, +144R, 49% of the corpus's total R). But the same mechanism explains the cost: the system's whole edge sits inside sustained bullish runs (589 trades, +0.76R, +$207K) and it **loses** in the choppy stretches between runs (272 trades, −0.55R, −$67K). The year's result is decided by whether gold trends, which no variable here forecasts. | §3.2, §3.4 |

---

## 3.1 The five sets, whole corpus and by year

| Set | n | WR | mean R | sum R | PF | P&L $ | max DD (fixed $100K path) | empty months | longest gap |
|---|---|---|---|---|---|---|---|---|---|
| `L_on` | 862 | 36.3% | **0.343** | 295.7 | 1.57 | **139,875** | 22.3% | 19 | 132 d |
| `L_off` | 1,365 | 35.8% | 0.329 | 448.6 | 1.55 | 224,231 | 20.3% | 4 | 60 d |
| `S_on` | 653 | 24.2% | −0.103 | −67.1 | 0.87 | −28,112 | 63.0% | 34 | 112 d |
| `S_off` | 1,261 | 24.7% | −0.090 | −113.5 | 0.88 | −47,962 | 78.3% | 4 | 67 d |
| `LS_on` | 1,251 | 33.0% | 0.223 | 278.8 | 1.35 | 130,443 | 23.1% | 8 | 98 d |

By entry year, `L_on` against `L_off` (n / mean R / P&L / max DD within the year / empty months / longest gap in days):

| Year | gold | `L_on` | `L_off` |
|---|---|---|---|
| 2015 | −10.8% | 57 / 0.095 / $2,166 / 5.9% / 3 / 53 | 103 / 0.030 / $1,081 / 12.3% / 0 / 27 |
| 2016 | +9.2% | 97 / 0.112 / $4,392 / 11.2% / 1 / 54 | 131 / 0.059 / $3,016 / 14.2% / 1 / 43 |
| 2017 | +11.8% | 73 / 0.320 / $9,975 / 7.4% / 1 / 44 | 119 / 0.313 / $15,717 / 12.5% / 1 / 60 |
| **2018** | −1.2% | **72 / −0.171 / −$5,545 / 14.6% / 3 / 132** | 129 / 0.062 / $3,105 / 15.3% / 0 / 22 |
| 2019 | +18.4% | 84 / −0.027 / −$1,130 / 10.8% / 0 / 30 | 136 / 0.142 / $8,221 / 12.8% / 0 / 28 |
| 2020 | +25.0% | 69 / 0.405 / $11,899 / 5.8% / 1 / 58 | 106 / 0.662 / $31,987 / 5.5% / 0 / 29 |
| 2021 | −4.2% | 35 / 0.176 / $2,688 / 4.2% / 4 / 96 | 103 / 0.068 / $3,514 / 12.1% / 1 / 38 |
| 2022 | 0.0% | 56 / 0.515 / $12,935 / 8.7% / 2 / 64 | 126 / 0.106 / $6,332 / **20.3%** / 0 / 33 |
| 2023 | +13.8% | 80 / 0.536 / $19,886 / 6.5% / 1 / 55 | 109 / 0.606 / $32,241 / 9.8% / 0 / 24 |
| 2024 | +26.2% | 77 / 0.579 / $20,978 / 6.1% / 0 / 31 | 106 / 0.840 / $46,535 / 5.4% / 0 / 24 |
| 2025 | +66.5% | 123 / 0.857 / $54,087 / 3.5% / 0 / 42 | 125 / 0.937 / $66,759 / 4.0% / 0 / 34 |
| 2026 to 07-09 | −6.0% | 39 / 0.377 / $7,544 / 6.7% / 3 / 91 | 72 / 0.146 / $5,722 / 11.5% / 1 / 27 |

Reading. The filter turns 2018 and 2019 from losing to flat-or-worse-than-unfiltered (unfiltered 2018: +$3.1K; 2019: +$8.2K), and it turns 2022 and 2026 H1 from unfiltered chop (+0.106 with a 20% drawdown; +0.146 with 11.5%) into two of the filtered set's better years. Its intra-year drawdown is lower in 9 of 12 years; its whole-corpus drawdown is not lower, because the deployed set's worst drawdown is the 2018–2019 path itself. Per family the filter removes most from Engulfing25 (+0.454 → +0.279) and ARB rr3 the other way (+0.349 → +0.415); every family is positive either way (`per_member_stats` in the JSON).

## 3.2 Where the money is made: bias runs

The corpus has 2,993 sessions; the bias was bullish on 56% and bearish on 43%. Of its 372 bias runs, 68 last ≥15 sessions: 39 bullish (1,081 sessions, 36% of the corpus) and 29 bearish (692 sessions, 23%). Everything else is the choppy remainder (41%).

| Where the entry falls | `L_on` | `L_off` | `S_on` | `LS_on` |
|---|---|---|---|---|
| inside a bullish run ≥15 | **589 / +0.756 / +445R / +$206,871** | 532 / +0.647 / +344R | 0 (by construction) | 525 / +0.701 / +368R |
| inside a bearish run ≥15 | 1 / −1.01 / −1R | 343 / −0.216 / −74R / −$35,615 | **329 / +0.400 / +131R / +$56,147** | 303 / +0.447 / +136R |
| outside any run ≥15 (chop) | **272 / −0.546 / −149R / −$66,553** | 490 / +0.365 / +179R | 324 / −0.613 / −199R / −$84,259 | 423 / −0.532 / −225R |
| the 40 sessions after a bearish run ≥15 ends | 313 / +0.459 / +144R / +$62,370 | — | — | — |

Three things follow. (i) The deployed set's edge is one thing: being long inside sustained bullish runs. Those 589 trades are 68% of its trades and 150% of its total R; the other 272 trades, taken in bullish spells that did not last, lose 0.55R each. (ii) The bias filter does exactly what A18 said: inside the 29 sustained bearish runs the filtered set traded once; the unfiltered longs would have lost 74R there, and the mirrored shorts would have made 131R. (iii) The mirror's problem is the same table read the other way: everything it earns inside the bearish runs it loses twice over in the chop, where a bearish-bias reading usually means a dip in an uptrend.

The 14 longest bearish runs, with each set's trades inside them (n / sum R) and the deployed set's re-entry in the 40 sessions after:

| Bearish run | sessions | gold | gold max DD | `L_on` | `L_off` | `S_on` | `L_on` next 40 |
|---|---|---|---|---|---|---|---|
| 2018-06-17 → 2018-08-23 | 50 | −9.0% | 8.2% | 0 | 31 / −9.3 | 24 / +24.3 | 18 / −6.7 |
| 2026-05-14 → 2026-07-02 | 36 | −12.1% | 14.0% | 0 | 11 / −10.2 | 10 / +1.6 | 0 (corpus ends) |
| 2018-04-22 → 2018-06-07 | 35 | −3.6% | 3.5% | 0 | 13 / −2.3 | 9 / +2.2 | 0 |
| 2015-06-23 → 2015-08-09 | 34 | −7.7% | 8.0% | 0 | 12 / +6.6 | 14 / −8.1 | 15 / +3.6 |
| 2016-11-10 → 2016-12-28 | 34 | −10.7% | 10.4% | 0 | 25 / −24.1 | 19 / +25.7 | 23 / +18.1 |
| 2022-08-17 → 2022-10-02 | 33 | −6.5% | 7.9% | 0 | 12 / +2.8 | 14 / +4.7 | 12 / +2.6 |
| 2015-02-05 → 2015-03-19 | 31 | −7.7% | 9.1% | 0 | 11 / −7.5 | 13 / +5.7 | 16 / +6.2 |
| 2022-06-19 → 2022-07-27 | 29 | −6.6% | 7.8% | 0 | 8 / −4.1 | 6 / +1.5 | 3 / +4.4 |
| 2015-10-28 → 2015-12-03 | 27 | −9.0% | 8.8% | 0 | 11 / +0.3 | 21 / +23.7 | 14 / +4.2 |
| 2017-06-13 → 2017-07-16 | 24 | −3.0% | 4.3% | 0 | 14 / −2.4 | 13 / +12.8 | 16 / +13.7 |
| 2021-02-11 → 2021-03-16 | 24 | −6.1% | 7.8% | 0 | 15 / −10.9 | 12 / +6.6 | 11 / +15.1 |
| 2021-01-10 → 2021-02-09 | 23 | −3.9% | 4.2% | 0 | 16 / −12.0 | 18 / +4.3 | 0 |
| 2022-04-24 → 2022-05-23 | 22 | −5.0% | 6.3% | 0 | 22 / −10.5 | 7 / +7.4 | 3 / −3.0 |
| 2023-05-16 → 2023-06-14 | 22 | −3.7% | 2.5% | 0 | 2 / −2.0 | 4 / −3.8 | 6 / −2.1 |

All 68 runs are in `phase3-regime.json` → `bias_runs_ge15`. Two of the three 2026 bearish runs (§3.7) are already the second- and sixth-longest on record; 2018's pair (35 then 50 sessions, eight weeks apart) is the only earlier year with two of this length.

## 3.3 Can the good trades be told apart in advance? The age of the bias run at entry

The split in §3.2 uses hindsight (whether the run *went on* to last ≥15 sessions). The ex-ante version is how old the run already is at entry. For the deployed set:

| Sessions since the bullish flip, at entry | n | WR | mean R | sum R |
|---|---|---|---|---|
| 1–2 | 250 | 30.8% | 0.147 | 36.7 |
| 3–5 | 133 | 43.6% | 0.604 | 80.3 |
| 6–10 | 106 | 40.6% | 0.501 | 53.1 |
| 11–20 | 177 | 31.1% | 0.146 | 25.8 |
| 21–40 | 159 | 42.1% | 0.564 | 89.7 |
| 41+ | 37 | 35.1% | 0.273 | 10.1 |
| hindsight, run < 15 sessions | 269 | 12.3% | **−0.541** | −145.6 |
| hindsight, run ≥ 15 sessions | 593 | 47.2% | **+0.744** | +441.2 |

Age is not a usable proxy: it is non-monotonic (the 11–20 bucket is as weak as 1–2), every bucket is positive, and the weakest bucket still carries +37R. The information is in whether the run *continues*, which is not known at entry. The same holds for the trades the filter removes (longs entered under a bearish bias: +0.38, +0.22, +0.11, +0.25, +0.20, +1.33R by age bucket; +0.73R when the bearish spell stays short, −0.17R when it lasts) and for the mirror (`S_on` is negative in every age bucket: −0.03, −0.18, −0.07, −0.12, −0.23, −0.39R). Full tables: `age_tables` in the JSON.

## 3.4 The regime variable

Ten variables per calendar year, computed from the session dailies, against the deployed set's mean R for that year (n = 12 years, 2026 partial):

| Year | gold return | bullish-bias share | bias flips | realised vol (ann.) | ATR14 / price | efficiency ratio | gold max DD | share above SMA200 | SMA50 slope | ADX14 | `L_on` mean R | n |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2015 | −10.8% | 0.37 | 31 | 13.6% | 1.39% | 0.07 | 19.3% | 0.07 | — | 23.8 | 0.095 | 57 |
| 2016 | +9.2% | 0.56 | 33 | 15.5% | 1.48% | 0.04 | 17.4% | 0.71 | +11.1% | 25.8 | 0.112 | 97 |
| 2017 | +11.8% | 0.61 | 24 | 9.9% | 1.03% | 0.08 | 8.0% | 0.60 | +5.8% | 23.5 | 0.320 | 73 |
| 2018 | −1.2% | 0.46 | 40 | 9.8% | 0.98% | 0.01 | 13.6% | 0.39 | −3.1% | 27.0 | −0.171 | 72 |
| 2019 | +18.4% | 0.60 | 36 | 11.0% | 1.03% | 0.12 | 6.3% | 1.00 | +19.6% | 27.5 | −0.027 | 84 |
| 2020 | +25.0% | 0.65 | 44 | 19.0% | 1.69% | 0.10 | 13.9% | 0.98 | +26.2% | 26.6 | 0.405 | 69 |
| 2021 | −4.2% | 0.51 | 28 | 13.4% | 1.35% | 0.03 | 13.7% | 0.29 | −3.4% | 25.2 | 0.176 | 35 |
| 2022 | 0.0% | 0.48 | 26 | 14.9% | 1.41% | 0.00 | 20.8% | 0.45 | −3.4% | 24.6 | 0.515 | 56 |
| 2023 | +13.8% | 0.55 | 22 | 13.2% | 1.22% | 0.08 | 11.2% | 0.90 | +14.7% | 26.5 | 0.536 | 80 |
| 2024 | +26.2% | 0.66 | 39 | 15.0% | 1.36% | 0.12 | 8.1% | 1.00 | +32.8% | 27.2 | 0.579 | 77 |
| 2025 | +66.5% | 0.79 | 31 | 19.0% | 1.66% | 0.22 | 9.8% | 1.00 | +56.7% | 26.6 | 0.857 | 123 |
| 2026 H1 | −6.0% | 0.45 | 17 | 32.0% | 2.90% | 0.03 | 26.2% | 0.82 | +4.7% | 27.0 | 0.377 | 39 |

Correlation with the year's mean R (Spearman / Pearson), the leave-one-year-out winner count, and the quarterly versions (46 quarters; quarters with fewer than 5 trades dropped from the mean-R rows):

| Variable | yearly, same year | yearly vs sum R | best in LOO | quarterly, same quarter | **quarter Q → mean R in Q+1** | Q → sum R in Q+1 |
|---|---|---|---|---|---|---|
| gold return | **0.58 / 0.65** | **0.64 / 0.85** | 7 / 12 | **0.60 / 0.52** | −0.04 / −0.06 | −0.03 / −0.04 |
| bullish-bias share | 0.54 / 0.60 | 0.60 / 0.75 | 0 | 0.46 / 0.38 | 0.01 / −0.01 | 0.01 / −0.02 |
| share above SMA200 | 0.53 / 0.50 | 0.54 / 0.51 | 1 | 0.10 / 0.06 | −0.02 / −0.05 | −0.05 / −0.10 |
| SMA50 slope | 0.52 / 0.63 | 0.57 / 0.81 | 1 | 0.36 / 0.31 | 0.03 / 0.02 | 0.01 / 0.02 |
| realised vol | 0.52 / 0.39 | 0.48 / 0.24 | 2 | 0.37 / 0.25 | 0.21 / 0.19 | 0.08 / 0.05 |
| ATR14 / price | 0.46 / 0.33 | 0.42 / 0.17 | 1 | 0.30 / 0.24 | **0.26 / 0.27** | 0.11 / 0.04 |
| efficiency ratio | 0.35 / 0.55 | 0.39 / 0.75 | 0 | 0.50 / 0.54 | 0.00 / 0.03 | 0.08 / 0.04 |
| bias flips | −0.26 / −0.26 | −0.22 / −0.10 | 0 | −0.43 / −0.43 | 0.23 / 0.25 | 0.13 / 0.11 |
| gold max DD | −0.06 / −0.07 | −0.11 / −0.26 | 0 | 0.08 / 0.17 | 0.08 / 0.07 | 0.03 / 0.02 |
| ADX14 | 0.03 / 0.04 | −0.03 / 0.11 | 0 | 0.37 / 0.31 | −0.01 / 0.00 | 0.03 / 0.03 |

The variable that best "predicts" the year is the year's own gold return, with the bullish-bias share (a function of the same price path) next; that is the Phase 2 ρ = 0.65 restated with ten competitors and it survives leave-one-out. It is not a forecast: both are known when the year is over. On the predictive rows nothing reaches ρ = 0.3 on 42 quarters (ATR/price at 0.26, p ≈ 0.10 by t-test, and 0.11 on the sum-R version; "more bias flips last quarter" is the second-best predictor at 0.23, which argues against a stability story). Trend direction, trend strength (ADX, efficiency ratio), bias persistence and the share above the 200-session average carry no information about the next quarter. With 12 yearly points the leave-one-out count is the only stability check available, and it says only that gold's return is the most stable coincident correlate.

What this means in practice: the system's year is decided by whether gold trends up in that year, which it did in 7 of the 12; there is no measured regime variable with which to switch the system off ahead of a 2018 or a 2026, and no basis for a regime-timed allocation between the long set and a short mirror.

## 3.5 The short mirror ("the war claim" tested on history)

`S_on` by year (n / mean R / P&L / max DD):

| 2015 | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 H1 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 69 / +0.06 / $1.7K / 10.8% | 42 / +0.34 / $5.9K / 5.7% | 54 / +0.57 / $13.2K / 3.5% | 84 / +0.19 / $6.7K / 8.8% | 49 / −0.47 / −$10.1K / 10.2% | 62 / −0.38 / −$10.2K / 13.0% | 79 / −0.03 / −$0.7K / 12.0% | 67 / −0.18 / −$4.9K / 10.9% | 57 / −0.60 / −$14.2K / 14.2% | 44 / −0.80 / −$14.4K / 14.4% | 22 / −0.30 / −$2.8K / 4.0% | 24 / +0.15 / $1.6K / 3.8% |

Four positive years, all before the 2019 breakout, then seven negative years in a row and a cumulative drawdown of 63% of the $100K path. Per family the best mirror is Engulfing25 short (+0.054R, n=170); the ARB shorts are the worst (−0.26 and −0.23). Without the bias condition (`S_off`) it is worse still (−0.090R, 78% DD). Run together with the longs (`LS_on`), direction conflicts remove 146 long trades and 65 short ones; the result is 1,251 trades at 0.223R, $130K and a 23% drawdown — less money than the longs alone, with more trades, and a worse 2019 (−$7.0K), 2022 (−$1.9K) and 2023 (+$8.8K vs +$19.9K). Only 2018 improves (+$4.7K vs −$5.5K) and 2015–2017.

So the claim "2026 is a war year, the system needs a short side" is answered in two parts. On history the short side pays only inside sustained bearish runs (+131R over 29 runs), which it cannot identify in advance (§3.3), and it loses more than that in every other state. On 2026 itself the mirror's locked-window result is not computed here, by the pre-registration; it would be one more in-sample number if it were.

## 3.6 The drawdown side (A15: "needs a DD/ML check, not a mean-R one")

The Phase 2.6 challenge simulators (`runUntilTarget`, `stressTest`, `mcChallenge` from `scripts/canonical/lib/pinned-eval.ts`; same settings and caveats as 02-validation §2.6: UTC day, floating-MAE proxy, in-sample, upper bounds) run on each set at the paper sizing and at the Phase 2 recommendation. `S_off` is omitted (it is worse than `S_on` on every count above).

| Set | Account / risk | n | mean R | P1 pass / median months | P2 pass / months | **P(funded)** / months | Worst 60-day ML / DL, breaches | MC P(ML > 8%) / P(ML > 10%) | MC ML p95 |
|---|---|---|---|---|---|---|---|---|---|
| `L_on` | $100K / 0.42% | 862 | 0.340 | 82.9% / 8.3 | 88.1% / 3.7 | **73.1%** / ≈12 | 9.23% / 3.21%, 0 of 576 | 16.2% / 10.1% | 10.4% |
| `L_on` | $50K / 0.30% | 860 | 0.330 | 91.0% / 14.8 | 92.3% / 5.7 | **84.0%** / ≈20 | 6.38% / 2.26%, 0 of 576 | 6.6% / 3.5% | 8.9% |
| `L_off` | $100K / 0.42% | 1,365 | 0.330 | 88.0% / 5.2 | 88.9% / 2.6 | 78.3% / ≈8 | **11.59%** / 3.33%, **3** of 591 | 20.1% / **13.3%** | 10.6% |
| `L_off` | $50K / 0.30% | 1,361 | 0.310 | 98.6% / 10.4 | 98.6% / 4.2 | **97.2%** / ≈15 | 8.11% / 2.34%, 0 of 591 | 10.7% / **6.1%** | 10.1% |
| `S_on` | $100K / 0.42% | 653 | −0.100 | 37.6% / 8.7 | 49.4% / 5.6 | 18.6% | 9.68% / 5.20%, 9 of 585 | 67.4% / 59.9% | 11.5% |
| `S_on` | $50K / 0.30% | 682 | −0.130 | 27.6% / 16.2 | 43.4% / 11.0 | 12.0% | 6.65% / 3.49%, 0 of 585 | 69.1% / 59.1% | 11.0% |
| `LS_on` | $100K / 0.42% | 1,251 | 0.220 | 67.0% / 5.3 | 77.3% / 3.0 | 51.8% | 13.40% / 5.17%, 19 of 586 | 28.2% / 20.9% | 10.8% |
| `LS_on` | $50K / 0.30% | 1,260 | 0.210 | 85.7% / 9.7 | 87.2% / 5.1 | 74.7% / ≈15 | 9.22% / 3.64%, 0 of 586 | 18.3% / 12.2% | 10.4% |

Worst 60-day max loss inside each calendar year, $100K / 0.42%:

| | 2015 | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 H1 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `L_on` | 4.0 | 8.0 | 5.0 | 6.5 | 7.9 | 4.7 | 3.6 | 4.5 | 7.0 | 4.5 | 4.3 | 4.0 |
| `L_off` | 7.3 | 7.6 | 9.2 | 8.8 | 9.0 | 5.4 | 9.7 | 8.7 | 7.5 | 3.5 | 3.4 | 4.8 |
| `LS_on` | 6.2 | 8.0 | 5.2 | **12.9** (2 breaches) | **10.9** (2) | 7.2 | 5.8 | **13.4** (7) | 6.9 | 4.6 | 6.4 | 4.7 |

Reading. On these in-sample simulators the unfiltered set is *better* on the funding question (97% vs 84% funded at $50K / 0.30%, in about 15 months instead of 20; 78% vs 73% at the deployed sizing) and *worse* on the breach question (the probability of a max-loss breach roughly doubles at either sizing: 6.1% vs 3.5%, 13.3% vs 10.1%; three 60-day windows breach the floor at 0.42% against none; in six of twelve years its worst 60-day loss is within 1.5 points of the 10% floor against one year for the filtered set). That is the whole case for the filter: it does not add return, it removes the tail. The unfiltered set is one pre-specified ablation (A15 flagged it before this phase), so it carries less selection than the deployed set does; both inherit the corpus's 2023–2025 concentration. The mirror fails every account-level test; the combined set breaches in three separate years. 2018's whole-year drawdown of 14.6% (§3.1) and its worst 60-day window of 6.5% are both true: the loss accrued over seven months, which a rolling 60-day window never sees whole and a challenge started that January would have taken in full (the static floor runs from the starting balance).

## 3.7 2018 and 2026 in plain words

**2018.** Gold ended the year down 1%, but between April and August it fell through two sustained bearish runs (35 sessions, then 50 sessions eight weeks later). The deployed set: 72 trades, 22% winners, −12.3R, **−$5,545** at $100K / 0.42%, a 14.6% drawdown on the fixed-sizing path accrued over seven months (an FTMO account started that January fails at the 10% floor; no single 60-day window lost more than 6.5%), 132 consecutive days without an entry, three empty months. Without the filter it made +$3.1K with a 15.3% drawdown; the mirror made +$6.7K with 8.8%; longs and shorts together +$4.7K with 13.6%.

**2026, from the pinned data (Jan → Jul 9, in-sample):** gold fell 6%, through two sustained bearish runs (Mar 12 → Apr 7, 18 sessions, −9.1%; May 14 → Jul 2, 36 sessions, −12.1%, the second-longest on record) with realised volatility twice any earlier year. The deployed set made 39 trades, +14.7R, +$7.5K, with a 91-day gap and three empty months; without the filter 72 trades, +0.146R, +$5.7K, 11.5% drawdown; the mirror 24 trades, +$1.6K.

**2026, live (Jul 20 → Nov 17; the deployed configuration's own paper record, read from the database on 2026-11-17):** 18 closed trades, 3 winners (+3.42, +2.58, +3.01R), 15 stops; sum **−9.87R, −$4,145**; no position open. The three winners and six of the losers fell inside the one sustained bullish run of the second half (Aug 4 → Aug 31, 20 sessions, +9.7%); four stops came at its top (Aug 31 → Sep 4 entries, including the −3.27R NFP fill of A5); then the bias was bearish from Sep 6 for 38 sessions to the end of the refresh (gold −9.2%) and the system held no position for 62 days (Sep 4 → Nov 5); when the bias turned bullish in early November it re-entered four times and was stopped four times (−1.01, −1.33, −1.33, −1.07R; the three November 10 exits were all filled at 4,018.52 on the same 18:00 manage tick, $7 to $13 through their stops). Year to date, backtest first half plus live second half, roughly **+$3K on $100K**, with about five months of the year spent flat.

**What a long-only gold strategy is worth in such a year:** nothing or a small loss. It does not lose the way an unfiltered long set does in the fall (the filter is what makes that true), but it earns nothing for months, and the turns cost it: entries at the end of a run and at the first flip back are where its stops cluster. Across the corpus the 272 trades taken in bullish spells that did not last cost 0.55R each. A challenge bought at the start of such a year stalls (no trades count toward the 10%) or fails on the turn-drawdown; a funded account earns nothing for the duration.

## 3.8 Carried into Phase 6 and 7

- **The bias filter is a drawdown decision, not a mean-R one.** In-sample the unfiltered set is funded more often and sooner and breaches about twice as often (§3.6). Keeping the filter is the conservative choice and the one the paper record was built on; removing it is the one bias hypothesis worth carrying forward, with its acceptance test written before any further data is looked at (`06-improvements.md`), and a 110-day locked window cannot decide a tail question either way.
- **No short mirror, and no long+short set.** Both lose on history; neither is structural.
- **No regime-timing variable.** None forecasts the next quarter; a regime gate built from these would be a fit to twelve years of gold trending up.
- **For Phase 7:** the system's return comes from a state (a sustained bullish run) that occupies 36% of sessions and whose arrival is not forecastable; the live cadence and the dark periods follow from that, not from a defect. A 2026-like year is roughly flat with five months of silence; a 2018-like year loses 5% and breaches the FTMO floor.

## Caveats on method

- In-sample on the selection corpus by construction; the locked window is untouched by every set here (locked-window.md rule 1). Every number above would be the same for the deployed set as in Phase 2 and is new only for the four transforms; the transforms are not candidates and nothing was tuned.
- "Run ≥15 sessions" is one cut; the hindsight/ex-ante contrast in §3.3 does not depend on it (any cut between 10 and 25 sessions gives the same sign; not tabulated).
- The bias used for annotation is the session-close rule read from the last completed session before the entry bar; the backtester's own alignment is one session staler on two of six bars (A6), so a handful of trades near a flip may be labelled differently than the engine saw them.
- Regime variables are computed on session dailies from the same pins; ADX and ATR are Wilder-smoothed over 14 sessions; the 2015 share-above-SMA200 covers only the sessions where it is defined.
- Correlations on 12 yearly points have no useful confidence interval; the quarterly rows (42–46 points) are the ones to weigh, and the ±0.3 scale of their largest predictive value is what "no predictive power" means here.
