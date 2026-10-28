# 02 — Statistical validation (Phase 2)

**Date:** 2026-10-28 · **Reproduce every number:** `bash review/scripts/phase2.sh` (≈20 min; the prop-firm sweep is the slow part). Inputs: canonical pinned XAU/USD H4 + session dailies 2015-01-01 → 2026-07-09 (the selection corpus; the locked window 2026-07-10 → 10-28 is **not** used here), the five deployed rule sets read from the live DB, the repo's own engine (`runPortfolioBacktest`, sibling-aware as in the deploy harness) and statistics library (`src/lib/stats/*`), and `scripts/canonical/lib/pinned-eval.ts` for the challenge simulators. Portfolio = sibling-aware union at **$100K / 0.42% uniform risk** unless stated (the paper sizing; see 01-audit A2 for why not the $10K harness).

## Verdict inputs in one table

| Question | Answer | Where |
|---|---|---|
| Is the in-sample mean R positive? | Yes: 0.343R, block-bootstrap 95% CI **[0.180, 0.507]** (n=862, 10,000 circular-block resamples). PF 1.57 [1.29, 1.90]; WR 36.3% [31.9, 40.8]. | §2.2 |
| Does it survive the selection it came from? | **No.** Deflated Sharpe at the honest trial counts (2,000–3,300 configurations on this corpus, zero holdout) and the observed within-family Sharpe dispersion (σ_SR 0.069 across the five deployed algos) is **0.25–0.34**; even at the repo's optimistic σ_SR 0.044 it is 0.87–0.90, below the 0.95 convention. Only at N=96 (one Layer-B family) does it pass. | §2.4 |
| Is the sample what it looks like? | No. 35% of trades share their entry bar with a sibling (near-duplicates); lag-1 autocorrelation of R is 0.52 (0.27 on distinct entries); **the top 5% of months carry 51% of all P&L; 2023–2025 carry 68%, 2025 alone 39%**; longest losing streak 25 trades; two losing years (2018, 2019). Yearly mean R correlates **0.65** with gold's yearly return. | §2.1, §2.5 |
| How many trades does a decision need? | 166 trades for 80% power that mean R > 0 (one-sided 95%) at the $100K baseline (219 at the published one) → **40 months at the live cadence (4.2/month), 27 at the backtest's (6.1/month)**. The M1 ±30% band has 25% power at n=30 and would need **2,334 trades**. | §2.3 |
| Is the live result evidence of anything? | No. Live n=14, mean gross R −0.366, bootstrap CI [−1.25, +0.67]. Under the backtest's own distribution of 14-trade windows, **19%** of windows are at least this bad (binomial P(≤3 wins) = 19%). Inside the noise; neither confirms nor refutes. | §2.7 |
| Prop-firm viability | In-sample upper bounds: at the deployed 0.42% on ≥ $50K, **P(pass Phase 1) 83%, P(funded) 74%, median ≈ 12 months, MC P(max loss > 10%) ≈ 10%**; at 0.30%, 84% funded in ≈ 20 months with P(ML > 10%) 3.5%. $10K is dominated (the lot floor skips 70% of recent signals). | §2.6 |
| Does the LLM add value? | Not testable and not needed: it is not in the loop. The deterministic system **is** the no-LLM arm. The only LLM evidence is 14 held-out trades at +0.09R / PF 1.15 / 4% DD from a harness with a look-ahead and no costs (01-audit A8). | §2.8 |

**Reading.** The portfolio has a statistically positive in-sample mean, but that mean was selected from thousands of configurations on the same bars with no holdout, is carried by one regime (the 2023–2025 gold rally), and the live sample cannot distinguish it from zero for another 2–3 years at current cadence. "Might work but the sample can't tell us yet" is the strongest honest statement; "selected noise riding a bull market" is equally consistent with the data.

---

## 2.1 Walk-forward folds
The rules are fixed, so these folds measure **consistency across time**, not out-of-sample performance (the parameters were chosen on this whole corpus; the only true out-of-sample data is the locked window, which this phase does not touch). Calendar-year folds, portfolio at $100K; "anchored" = cumulative from 2015.

| Year | n | WR % | mean R | PF | P&L $ | max DD % (fixed $100K path) | anchored n / mean R |
|---|---|---|---|---|---|---|---|
| 2015 | 57 | 29.8 | +0.095 | 1.13 | 2,166 | 5.9 | 57 / 0.095 |
| 2016 | 97 | 29.9 | +0.112 | 1.15 | 4,392 | **11.2** | 154 / 0.106 |
| 2017 | 73 | 35.6 | +0.320 | 1.48 | 9,975 | 7.4 | 227 / 0.174 |
| 2018 | 72 | 22.2 | **−0.171** | 0.77 | −5,545 | **14.6** | 299 / 0.091 |
| 2019 | 84 | 26.2 | **−0.027** | 0.96 | −1,130 | 10.8 | 383 / 0.065 |
| 2020 | 69 | 37.7 | +0.405 | 1.65 | 11,899 | 5.8 | 452 / 0.117 |
| 2021 | 35 | 31.4 | +0.176 | 1.25 | 2,688 | 4.2 | 487 / 0.121 |
| 2022 | 56 | 41.1 | +0.515 | 1.88 | 12,935 | 8.7 | 543 / 0.162 |
| 2023 | 80 | 41.3 | +0.536 | 1.95 | 19,886 | 6.5 | 623 / 0.210 |
| 2024 | 77 | 42.9 | +0.579 | 2.01 | 20,978 | 6.1 | 700 / 0.251 |
| 2025 | 123 | 50.4 | **+0.857** | 2.84 | 54,087 | 3.5 | 823 / 0.341 |
| 2026 (to 07-09) | 39 | 38.5 | +0.377 | 1.62 | 7,544 | 6.7 | 862 / 0.343 |

10 of 12 folds positive. Through 2021 the anchored mean R was 0.12; the headline 0.34 is produced by 2022–2025. Yearly gold return vs yearly mean R: ρ = 0.65 (gold −10%/−2%/−5% in 2015/2018/2026 ↔ mean R 0.10/−0.17/0.38; +65% in 2025 ↔ 0.86). The fixed-sizing path breached a 10% drawdown in 2016 and 2018 — relevant to §2.6.

## 2.2 Bootstrap confidence intervals
Circular moving-block bootstrap (block = ⌈√n⌉ = 30 trades), 10,000 resamples, trades in exit order:

| Statistic | Point | 95% CI | Note |
|---|---|---|---|
| mean R (nominal, net of engine friction) | 0.343 | [0.180, 0.507] | excludes 0 in-sample |
| win rate | 36.3% | [31.9%, 40.8%] | pre-registration demands ≥37 |
| profit factor | 1.57 | [1.29, 1.90] | |
| max drawdown, cumulative fixed-$100K P&L path, 2015→2026 | 22.3% | [16.2%, 52.8%] | peak-to-trough over 11.5 years, not a challenge metric |
| since 2025-07 (n=97): mean R | 0.653 | [0.180, 1.137] | the live-era regime |
| since 2025-07: win rate | 45.4% | [32.0%, 58.8%] | |

The max-DD interval's upper bound (53%) says the *order* of these trades matters enormously: resequencing the same trades in blocks produces a 2.4× worse drawdown — the serial dependence in §2.5 is real. Statistics that rest on too few trades to mean anything: anything computed on the 14 live trades (§2.7), and the per-algo yearly rows (5–40 trades).

## 2.3 Power
Per-trade R: μ = 0.343, σ = 1.77 (skew +0.59, excess kurtosis 1.38).
- Trades to show mean R > 0 at one-sided 95% with 80% power: **n = ((1.645 + 0.842) · σ/μ)² = 166** ($100K baseline) / 219 (published $10K baseline). At the live cadence since 2026-07-20 (14 trades / 100 days ≈ 4.2/month): **40 months**; at the backtest's 6.1/month: 27 months.
- The M1 gate (mean R within ±30% of baseline at n=30): P(inside | the strategy is exactly as backtested) = 2Φ(0.103/(1.77/√30)) − 1 = **25%**. Trades for that band to have 80% power: ((1.96 + 0.842) · 1.77 / 0.103)² = **2,334**.
- These feed Phase 7 directly: no calendar gate at n=30 can be informative about mean R; what *can* be checked at n=30 is parity (fill model, trade-set match, data), which Phase 1 showed is where the live divergences actually were.

## 2.4 Selection bias — deflated Sharpe
Observed per-trade Sharpe SR = 0.343/1.77 = **0.193** (T = 862). `computeDeflatedSharpe` (Bailey & López de Prado eq. 9, repo implementation) over a grid of trial counts N and trial-Sharpe dispersion σ_SR:

| N trials | σ_SR = 0.044 (ROADMAP's within-Engulfing-family figure) | σ_SR = 0.060 (≈ observed across the 5 deployed algos: 0.069) | σ_SR = 0.100 |
|---|---|---|---|
| 96 (one Layer-B grid) | DSR 0.995 | 0.906 | 0.035 |
| 300 (effective independent trials, low) | 0.980 | 0.729 | 0.001 |
| 2,000 (documented lower bound) | 0.903 | 0.337 | 0.000 |
| 3,300 (plausible total; repo ledger 3,276) | 0.867 | 0.252 | 0.000 |

Expected max Sharpe under the null at N=3,300 is 0.158 (σ 0.044) to 0.215 (σ 0.060) — the observed 0.193 sits between them. Assumption stated: the trial count follows the operator's instruction to use the recorded counts (00-project-map §3.3); the dispersion figure is the weakest link, and the two defensible values (0.044 from the repo, 0.069 observed) bracket a DSR of 0.25–0.87 at the honest N. Under no defensible combination at N ≥ 2,000 does the portfolio clear 0.95.

## 2.5 Trade independence and clustering
- **Duplicates:** 35% of the 862 trades share an entry bar with a sibling (Engulfing/Engulfing25, ARB/ARB25 fire on the same bar). The portfolio's effective number of independent bets is closer to 557 distinct signals.
- **Serial correlation of R:** ρ₁ = 0.52, ρ₂ = 0.24 on all trades; ρ₁ = 0.27, ρ₂ = 0.08 on distinct entry bars. Trade-level (i.i.d.) bootstraps would understate variance — hence block bootstrap throughout (the repo's own 2026-06-18 lesson).
- **Concentration:** 121 months; 58 positive (48%); the top 6 months (5%) carry **51%** of total P&L; 2025 carries 39%; 2023–2025 carry 68%. Longest losing streak: **25 trades**.
- **Regime dependence (preview for Phase 3):** yearly mean R vs yearly gold return ρ = 0.65. The in-sample result is a handful of trending years, not many independent bets.

## 2.6 Prop-firm simulation
Equity-path simulation on the deployed rules, re-run through the engine at each (account size, risk) so the 0.01-lot floor, compounding and the sibling gates act as on a real account; then `runUntilTarget` (no time limit; Phase 1 = +10%, Phase 2 = +5%, both with the static −10% max-loss floor and the −5% daily rule), `stressTest` (worst 60-day window), and `mcChallenge` (10,000 block-resampled challenges, 21-calendar-day blocks). Daily loss uses the harness's UTC-day, floating-MAE proxy. P(funded) = P1 × P2 (independence approximation). Full table: `review/results/phase2-propfirm.json`. **All figures are in-sample on the selection corpus and inherit its 2023–2025 concentration (§2.1, §2.5); treat them as upper bounds.**

| Account | Risk/trade | n (floor-free 862) | mean R | P1 P(pass) / median months | P2 P(pass) / months | **P(funded)** / months to funded | Worst 60-day ML / DL, breaches | MC P(ML > 8%) / P(ML > 10%) | MC ML p95 |
|---|---|---|---|---|---|---|---|---|---|
| $10K (floor binds) | 0.20% | 773 | 0.161 | 100% / 40.0 | 100% / 18.1 | **100% / ≈58** | 3.7% / 1.7%, 0/549 | 3.0% / 0.9% | 6.9% |
| $10K | 0.30% | 821 | 0.213 | 96% / 21.6 | 96% / 8.0 | **93% / ≈30** | 6.7% / 2.0%, 0/565 | 8.1% / 4.0% | 9.3% |
| $10K | **0.42% (deployed)** | 843 | 0.255 | 83% / 10.8 | 90% / 4.5 | **74% / ≈15** | 7.8% / 2.8%, 0/576 | 14.9% / 9.4% | 10.4% |
| $10K | 0.60% | 854 | 0.295 | 80% / 6.0 | 86% / 2.9 | 69% / ≈9 | 11.5% / 4.8%, 2/576 | 23.4% / 15.8% | 10.9% |
| $10K | 0.80% | 856 | 0.305 | 73% / 3.2 | 79% / 2.2 | 58% / ≈5 | 15.9% / 5.5%, 44/576 | 28.2% / 20.1% | 11.5% |
| $10K | 1.00% | 677 | 0.278 | 69% / 3.2 | 81% / 2.0 | 56% / ≈5 | 18.5% / 6.8%, 55/576 | 33.9% / 25.1% | 11.8% |
| $50K (floor irrelevant) | 0.20% | 856 | 0.306 | 100% / 28.7 | 100% / 11.4 | **100% / ≈40** | 4.2% / 1.4%, 0/576 | 1.6% / 0.6% | 6.1% |
| $50K | 0.30% | 860 | 0.328 | 91% / 14.8 | 92% / 5.7 | **84% / ≈20** | 6.4% / 2.3%, 0/576 | 6.6% / 3.5% | 8.9% |
| $50K | **0.42%** | 861 | 0.331 | 83% / 8.7 | 89% / 3.8 | **74% / ≈12.5** | 9.0% / 3.1%, 0/576 | 15.8% / 9.9% | 10.4% |
| $50K | 0.60% | 862 | 0.337 | 80% / 4.8 | 86% / 2.8 | 68% / ≈7.6 | 13.1% / 4.7%, 5/576 | 26.7% / 18.6% | 11.1% |
| $50K | 0.80% | 862 | 0.343 | 71% / 2.8 | 77% / 2.0 | 55% / ≈4.8 | 17.6% / 6.3%, 56/576 | 30.6% / 22.2% | 11.6% |
| $100K | 0.42% | 862 | 0.343 | 83% / 8.2 | 88% / 3.7 | **73% / ≈12** | 9.2% / 3.2%, 0/576 | 16.2% / 10.1% | 10.4% |
| $100K | 0.30% | 862 | 0.338 | 91% / 14.5 | 92% / 5.6 | 84% / ≈20 | 6.6% / 2.3%, 0/576 | 7.9% / 4.1% | 9.4% |

**Trade-off curve (any account ≥ $50K; $100K is identical in shape):** 0.20% → funded with near certainty but in ≈ 3.5 years; 0.30% → 84% / ≈ 20 months, MC P(ML > 10%) 3.5%; 0.42% → 74% / ≈ 12.5 months, P(ML > 10%) 10%; 0.60% → 68% / ≈ 7.6 months, P(ML > 10%) 19%; 0.80% → 55% / ≈ 5 months, P(ML > 10%) 22%. Each step of risk buys speed at the price of breach probability roughly one-for-one in this range; beyond 0.6% the 60-day windows start breaching outright.

**Account size (operator question 1).** $10K is dominated: at 0.42% it skips 70% of *recent-regime* signals through the lot floor (01-audit A2; the "n" column hides this because 2015–2019 stops were tiny in dollars) and still reaches only the same 74% funded probability, more slowly. The smallest account where the floor skips < 5% of recent signals is **≈ $46K**, so **$50K is the floor; $100K changes nothing but the dollar scale**.

**Risk per trade — recommendation.** If the decision to buy a challenge is taken at all (see the verdict table: the edge is not established), size for the breach rule rather than for speed: **0.30% at ≥ $50K** (in-sample 84% to funded, MC P(ML > 10%) 3.5%, worst 60-day window 6.4%) rather than the deployed 0.42% (74%, 10%, 9.0%). Expect the real numbers to be worse than the table: it excludes swap (−0.03 to −0.07R per trade in today's regime, A7), the tick-model spread (−0.01R), the daily-loss boundary mismatch (A16), and above all the regime concentration — in a 2018-like year the fixed-sizing path drew down 14.6% at 0.42% (§2.1), i.e. a challenge started then fails.

**Months unit note.** `mcChallenge` multiplies calendar days by 7/5 (01-audit, 00-project-map §5); its month figures are 1.4× too high and are not used above — `runUntilTarget`'s calendar-day medians are.


## 2.7 Demo vs backtest — is the gap inside the noise?
Live: 14 trades (2026-08-10 → 09-04), mean gross R −0.366, 3 wins; bootstrap 95% CI on the live mean [−1.25, +0.67]. Backtest over the same window (replay, 01-audit A5): 10 trades, mean gross R +0.147, with the gap decomposed as period (−0.20), one NFP fill (−0.16) and trade-set divergence (−0.31; two missed Sunday-open winners, five extra losers).

Noise test: across the 849 contiguous 14-trade windows of the backtest, **19.0%** have mean gross R ≤ −0.366 and ≤ 3 wins (binomial P(≤3 wins | p = 0.363) = 19.2%; backtest 14-window mean R p5/p50/p95 = −1.01 / +0.35 / +1.67). A 1-in-5 draw: the live result neither falsifies the backtest nor supports it. Slippage distribution (01-audit A5): stops filled on average $9.19/oz past the level (11 stops, range $0.87–$49.19), take-profits $5.65/oz past the level (3) — net ≈ 0 excluding the NFP outlier. LLM decision agreement rate: not applicable (no LLM in the loop).

## 2.8 Ablation — with and without the LLM
There is nothing to ablate on the live path: no active algorithm invokes the LLM and the 14 paper trades are purely deterministic. The deterministic portfolio *is* the no-LLM arm. The LLM arm's only evidence is the archived May 2026 validation (01-audit §3, A8): held-out 14 trades, mean R +0.088, PF 1.15, max DD 4.0%, produced by a harness with a forming-session look-ahead, no friction, dates and absolute prices in the prompt, no temperature control and a ±50% re-run spread. **No measurable value can be attributed to the LLM at any confidence**, and its removal already removed the cost, latency and nondeterminism. Restoring it (E2.26) would need the harness fixed and a post-cutoff-only validation before a single paid call.

## Caveats on method
- All of §2.1–2.5 is in-sample on the selection corpus by construction; the locked window is reserved for Phase 6's final candidate.
- The engine's own friction (0.4 bps/side + 0.5 bps/fill) is included; swap and the tick-model spread are not (01-audit A7/A12 quantify them: −0.01 to −0.34R).
- Daily-loss breaches in §2.6 use the harness's UTC-day, floating-MAE proxy, not FTMO's 00:00 CE(S)T balance reference (01-audit A16).
