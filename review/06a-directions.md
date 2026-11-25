# 06A — Directions (proposals only, no backtests of new ideas)

**Date:** 2026-11-25 · **Status:** for the operator to choose from. Nothing in this file has been run. Estimates are marked **(est.)** and rest on numbers already in 01 to 03 and 02a. Each direction has the ten fields of the brief, in the same order.

## What every direction has to beat

Start from what is known, with the swap in.

- **The measured edge is small and has a cost it did not have in October.** Mean R is 0.255 with the swap (interval [0.093, 0.418]) and 0.343 without (02a §2). At 2,000–3,300 trials the deflated Sharpe is 0.02–0.03 (σ 0.060) or under 0.01 (σ 0.069). An honest reading is "an unproven small edge, most of it in one bull market".
- **Where it comes from.** All of the profit sits in sustained bullish runs (589 trades, +0.756R), and the 272 trades outside them lose 0.55R each (03 §3.2). Nothing tested forecasts which state comes next (03 §3.4).
- **Costs of the trade's shape.** The mean hold is 4.8 rollovers, and 81% of trades are open over at least one. A short pays about one fourteenth of what a long pays ($0.04 against $0.58 an ounce a night), and one night of long swap (about 0.0156%) costs more than the spread (0.0104%).
- **What a "trade" is worth as evidence.** With the swap, 289 trades (not 166) are needed for 80% power to show mean R above zero (σ 1.74, mean 0.255: (2.487 × 1.74 / 0.255)² = 289; the brief's 166 is the swap-free figure). "Independent" counts sibling entries on one bar as one bet: 557 distinct signals over 138 months, about 4.0 a month (02 §2.5). Then 289 trades is about 72 months, and 166 is about 41 months.
- **The reasoning for all the "months" below:** months = needed trades ÷ independent trades per month. Needed trades = (2.487 × σ / μ)², where μ and σ are the mean and spread of R per trade. A direction that trades ten times a month with a mean of 0.1R and σ 1.0 needs about 619 trades, or 62 months. A direction can only be proven in a year if μ/σ per trade times the square root of its yearly trades is at least 2.5. Most of the directions below cannot reach that. Where they can, field 5 says so.
- **Held-out data.** The locked window (10 July to 28 October 2026) is for the final candidate only. The corpus 2015 to 9 July 2026 has selected the rules, so for a new idea it is in-sample. Two unselected sources exist: the forward record from now, and history before 2015. Pins start on 2015-01-01; **earlier gold H4 history is thought to exist (OANDA to about 2006; unverified, one small call would settle it) and no rule here was ever fitted to it.** It contains the 2008 crash, the 2011 top and the 2012–2015 decline of about 45%, which is exactly the test a long-only system needs. It would need your yes, a new pin with a hash, and one read-only API call per month of data.
- **Trial ledger.** Plausible configurations so far: 3,300 (00-project-map §3.3). Each direction states what it adds. Anything tested counts; "one idea, one test" does not.
- **Prior work that these proposals must not repeat.** The 30-minute and 1-hour gold search (E2.23) found no passers under the operator's bar. The session filter on the deployed set (E2.15 L2) improved the Sharpe by trading less, not by a better edge. Partial exits (June's exit replay and E2.15 L4) subtracted R, and trailing stops were shelved after a units bug in the test. Exit geometry was flat in ±1-step sensitivity (01 A15). The short mirror loses on history (03 §3.5). I have tried to be specific about what is different below.

---

## D1. Placebo entries: is the entry worth anything?

1. **Idea.** The five rules take long entries on chart patterns inside a bullish-bias filter. A random long entry taken at the same rate inside the same filter, with the same stop and target, is the proper comparison. If the patterns cannot beat random entries, they add nothing but noise, and the "edge" is the bias filter plus a bull market.
2. **Mechanism and the other side.** There is no mechanism to argue: it is a null-hypothesis test. If it passes, pattern timing has information (the counterparties are traders fading a breakout or a false break). If it fails, the edge is drift plus a structural stop, and the counterparty is the gold carry.
3. **Evidence for and against.** For testing it: ARB and Engulfing siblings share their entry bar on 35% of trades (02 §2.5); bias-run membership explains 0.76R against −0.55R (03 §3.2), which is a state effect more than an entry effect; 02 §2.4 shows the deflated Sharpe falls below 0.05 with swap. Against: 02's block bootstrap does not test a null of random entry, and I found no random-entry test in 01, 02, 03 or the ROADMAP's refinement battery.
4. **What changes and what it reuses.** Nothing in the engine: one analysis script, using the same harness, pinned data and the same geometry function (`computeSlDistance`). Random entry bars are drawn so the per-month count and the hold-out geometry match. Carries over to any instrument.
5. **Trades per month.** None added. The test uses the 862 trades (557 distinct) already in hand and about 1,000 random draws. It decides, not trades.
6. **FTMO fit.** Not applicable; no trades. (It does use the same cost model and swap.)
7. **Data, pins, cost.** Canonical H4, D and M30 pins, all in the repo. $0. About an hour of computing.
8. **Honest test.** Hypothesis: the deployed set's mean R (with swap) is above the 95th percentile of the mean R of random entries under identical bias, geometry and costs. Acceptance: above the 95th percentile in 2015 to 9 July 2026 and, separately, in the pre-2015 hold-out (if its history exists). Trial ledger: +1 test (the random draws are not rules). Cheapest kill: the random entries' mean with swap is within 0.05R of the deployed set's on the in-sample period alone.
9. **Effort.** Small (one script, no engine change; under a day).
10. **Confidence.** High that it is worth running; the outcome I would bet on is that random entries in a bullish bias with this geometry reach much of the 0.255R (gold rose through 2015–2026, and a stop at a swing low is a wide, trend-following geometry). That is a hypothesis, and this test is designed to be the one that tells me.

## D2. Slower and simpler: a daily trend-following core, as a benchmark

1. **Idea.** A one-rule daily system (hold long gold when its 100-day moving average is rising, sized to a fixed volatility; flat otherwise) is the cheapest trend system there is. If the 4h stack cannot beat it after costs, the stack is complexity around a beta.
2. **Mechanism and the other side.** Trend-following in a commodity with long-horizon buyers (central banks, retail). The other side is the mean-reverting speculator and the hedger who provides liquidity on pullbacks. This is the textbook premium, which is also crowded.
3. **Evidence for and against.** For: yearly mean R correlates 0.58 to 0.65 with gold's yearly return (03 §3.4, 02 §2.5), which is the fingerprint of beta; the edge is sustained bullish runs (03 §3.2). Against: gold's 2015–2026 rise was the whole sample, so any long trend rule looks good; 03's regime variables predict nothing, and a 100-day trend rule is also a lagging one (03 §3.7 shows 2026's whipsaw).
4. **What changes and what it reuses.** A separate, small pipeline on daily bars, using the same pinned data and the same loss rules. It would test as a benchmark and, only if it wins by enough, become a candidate. Carries over to any instrument.
5. **Trades per month.** About 0.5 to 1 **(est.)**; 166 trades would take 14 to 28 years. So it is judged on daily returns against buy-and-hold (about 2,900 daily observations), not trade counts: an information ratio of 0.73 over 11.5 years is the 80% power point for a one-sided test. That bar is above what an overlay is likely to show.
6. **FTMO fit.** Loss rules need sizing that survives a 25% drawdown in gold within weeks; at 10% volatility and a 1% daily loss budget the size is about 0.1 to 0.15 lots per $10K. Swap is full, about 5.7% a year, which roughly consumes a trend rule's edge on held bars. Positions are held through the nightly break and news. Low.
7. **Data, pins, cost.** Daily XAU/USD pins exist back to 2015 (D pin). Pre-2015 history would need a new pin (unverified, above). $0.
8. **Honest test.** Hypothesis: the trend rule, sized to 10% volatility and after a full swap, has a higher Sharpe than buy-and-hold gold scaled to the same volatility. Acceptance: the excess Sharpe, one-sided, at 95%, on 2015 to 9 July 2026 and the pre-2015 hold-out. In-sample N: 20 (a short list of lookbacks, declared before any run). Trial ledger: +20. Cheapest kill: on 2015 to 2026 alone it does not beat volatility-scaled buy-and-hold after swap, which is the likely result.
9. **Effort.** Small (one script); medium (if it becomes a candidate with its own FTMO risk rules).
10. **Confidence.** High that it is a useful benchmark; low that it is a product (full swap on held longs).

## D3. Faster entries under the same daily context, with a short leash

1. **Idea.** Keep the daily context and its bias rule, but enter on 1h bars (pullback or break of a 1h structure) with a smaller stop and a fixed maximum hold of 1 to 3 days. The point is not a better signal but cheaper, shorter exposure to the same state.
2. **Mechanism and the other side.** Entering in the direction of a state, with smaller size of stop, so more of the state's return per dollar of risk. The other side is the 1h momentum trader who fades the pullback.
3. **Evidence for and against.** For: the state is the edge (03 §3.2), and the deployed set holds it for a mean of 4.8 nights, paying 0.088R of swap (02a §2). A shorter hold keeps the state and cuts the swap. Against: E2.23 found no passers at 30m/1h, but with the same pattern catalogue and the same exits; spreads and slippage weigh more on a 0.4% stop (01 A12); and bias-run membership does not identify itself ex-ante (03 §3.3).
4. **What changes and what it reuses.** A variation: the timeframe and the hold limit. Reuses the bias rule, the geometry function and the risk layer. Carries over to instruments with a 1h history.
5. **Trades per month.** About 12 to 20 **(est.)**, all in bullish-bias sessions (56% of sessions, 03 §3.2); independent perhaps 8 to 12. At 166 trades, 14 to 21 months; at the more honest 289, 24 to 36 months, and a 2-R win rate that is not larger than the deployed one would push it beyond that.
6. **FTMO fit.** Stop smaller, so size larger per risk (lot floor helps rather than hurts). A hold limit of 3 days keeps daily loss exposure down. Swap: up to 3 nights, about 0.04R on average. Nightly break: entries on 1h closes fall in the break less often (one hour of six: 16:50 to 18:05 NY covers the 17:00 bar close of the 1h grid only). News: open inside releases, so the calendar rule (D9) matters more.
7. **Data, pins, cost.** H1 pin (2015 to July 2026) exists; M30 exists. $0.
8. **Honest test.** Hypothesis: 1h entries under the same daily bias, 3-day maximum hold, have mean R (with swap) above the 4h set's by at least 0.05R with the same or lower drawdown. Acceptance: a paired difference on the same dates (sibling-free), one-sided 95%, then the pre-2015 hold-out. In-sample: 2015 to 9 July 2026, at most 8 pre-declared cells. Trial ledger: +8 (and it is also an E2.23 re-run, so the prior 0 passers is prior weight). Cheapest kill: in-sample mean R below 0.20 after swap and after 0.4 bps spread per side (the E2.23 cells would already have shown it).
9. **Effort.** Medium (an entry evaluator at 1h, which the backtester supports; a hold-time exit rule, which it does not by default).
10. **Confidence.** Low to medium. It targets a real cost (swap) but the last 1h search said no.

## D4. An intraday system that never pays swap

1. **Idea.** Enter and exit between 18:05 and 16:45 New York time (after the reopen and before the close). One family only: fade the failed break of the London or Asian session range with a small stop, and exit by time if neither is hit. No position is held through the 16:50–18:05 break, a weekend or a swap rollover.
2. **Mechanism and the other side.** Range trading where the break-out participants get stopped: the other side is the trend trader who bought the break and gets squeezed. It only works when the day has no trend, and that is the case 41% of sessions are in (03 §3.2 shows 'chop' at 41%).
3. **Evidence for and against.** For: the deployed set loses 0.55R on trades in chop sessions (03 §3.2); an opposite-sign design is the natural hedge. Costs: zero swap, no break, no weekend gap. Against: the deployed set's chop trades were pattern longs, not faded ranges, so that loss is not evidence that fading works; E2.23 found 0 passers in 30m/1h (patterns only, no session design); the archived 15m RSI-fade short was a manual-like, high-turnover set with mixed results; spreads are wider in Asia hours and at the 18:05 reopen (A12).
4. **What changes and what it reuses.** A new family on 30-minute bars, with session logic (the M30 pins, the `session_filter` gate that already exists in the engine). Reuses the risk layer and the cost model. Carries over to other gold-like, highly liquid, session-driven markets (index CFDs, oil).
5. **Trades per month.** About 20 to 40 **(est.)** (one or two per session). At a small edge (0.06R to 0.1R per trade, σ about 1.0) it needs 620 to 1,700 trades; at 25 a month that is 25 to 68 months. If it shows 0.15R, 275 trades, 11 months. So: can be tested within a year only if the mean R per trade is about 0.15 or more.
6. **FTMO fit.** Best fit of all: no swap, no break, no weekend, small stops, many trades, and daily loss is naturally limited by the number of sessions. Must respect the 5% daily limit with a kill switch at 2%. News: flat 15 minutes before a red event (deterministic calendar rule, D9).
7. **Data, pins, cost.** M30 pin (2015 to July 2026) exists; tick data (Dukascopy) exists for March to September 2026 only, so any spread-by-session model beyond that needs a data decision (you said: not yet, nothing new fetched). $0 for the rest.
8. **Honest test.** Hypothesis: the faded failed-break of the Asian range, exit by 12 hours or stop, has mean R at least 0.10 after a 0.4 bps half-spread and 0.5 bps slippage in-sample, and the same sign in the pre-2015 hold-out. Acceptance: mean R one-sided 95% lower bound above zero (block bootstrap by day) in both. In-sample: 2015 to 9 July 2026 with at most 6 pre-declared cells (two sessions × three filters). Trial ledger: +6. Cheapest kill: in-sample mean R at most 0.05 after 1 bp round-trip costs, or fewer than 2 trades per week.
9. **Effort.** Medium (a session-range detector and a time exit; the engine has session gates; the harness has M30 pins).
10. **Confidence.** Low to medium that it works; high that it is the only direction here that could produce evidence in a year.

## D5. A short system designed on its own

1. **Idea.** Sell gold on a weekly or daily breakdown during dollar/real-yield strength, hold for weeks with a trailing-style exit, and size it at a third of the long's risk. Not the mirror of the longs.
2. **Mechanism and the other side.** Gold falls through fast, event-like deleveraging, and shorts pay almost no swap ($0.04 an ounce), so a weeks-long short costs what a one-night long costs. The other side is the carry-seeking long and dip-buyer.
3. **Evidence for and against.** For: the mirror earns +131R inside the 29 sustained bearish runs (03 §3.2); shorts' swap is fourteen times cheaper (02a, this file). Against: the mirror loses 199R outside those runs and is negative at every age of a run (03 §3.3), negative in 2019 to 2025 (§3.5); the short side is not a mirror, but there is no evidence yet that any detector finds the runs in advance (§3.3); only about 30 to 40 short trades a year exist.
4. **What changes and what it reuses.** A new rule set on daily/weekly bars with its own exits and its own risk budget; reuses the pinned D data, the risk gates and the per-direction logic (the engine allows both directions). Carries over to equity indices and crypto shorts (same deleveraging shape).
5. **Trades per month.** 1 to 2 independent **(est.)**; 166 takes 7 to 14 years. So it cannot be proven by its own trades; it could only be shown to lower the book's drawdown, which is a small-sample claim too.
6. **FTMO fit.** Swap is cheap, so holds are free. Daily loss: shorts are gap-prone on the upside; news risk higher. Nightly break is harmless (short positions held through 1 hour without trading).
7. **Data, pins, cost.** D and H4 pins exist; real-yield and dollar series (FRED) would be free but need pins. $0.
8. **Honest test.** Hypothesis: a weekly breakdown short has a positive mean R at the 95% one-sided level with swap in 2015 to 9 July 2026, and the book's max-loss probability (FTMO simulator) falls by at least 2 points. Acceptance: both, plus the sign holds in the pre-2015 hold-out (2011–2013 is the test a short system deserves). Trial ledger: +10. Cheapest kill: fewer than 60 trades, or negative mean R in 2018 to 2026 at 0.3% risk.
9. **Effort.** Medium (new rule set; no engine fence change beyond pausing the bias gate).
10. **Confidence.** Low. I would not lead with it, but it is the only way to keep the mirror's good part without the bad.

## D6. Exits that know about the swap

1. **Idea.** Keep the same entries and the same 3R target, and change the exit: cap the hold (10 trading days), and add a rule that a trade more than a set R below the target at the Wednesday rollover is closed to avoid the triple night. The question is whether the swap is bought back by the trade's remaining expectation.
2. **Mechanism and the other side.** No new edge: the exit stops paying for exposure that the trade's probability does not justify. The other side is the dealer collecting carry, who is not a counterparty in the signal's sense.
3. **Evidence for and against.** For: 81% of trades pay at least one night and the mean cost is 0.088R, 0.31R at the 95th percentile (02a §2); the longest trades are 158, 102 and 97 days, and they are long trades that took profit in the end; 3R-fixed targets were tested against their neighbours in A15 and were flat, and the June exit replay said partials subtract R and time exits were never tried on this set with a swap charge. Against: trailing stops and partial exits have already been tried and shelved (June, with the units bug; E2.15 L4 not done); the swap is small per trade, so the gain is bounded at about 0.05R to 0.10R **(est.)**.
4. **What changes and what it reuses.** A variation: the exit only. The backtester needs a max-hold option (small; the stagnant exit is close). Reuses entries, sizing, all gates. Carries over to any swap-paying instrument.
5. **Trades per month.** Same trades (4.0 independent a month). The effect on evidence is through the mean: 0.255 to about 0.30 would move the need from 289 to 208 trades **(est.)**, about 52 months. It does not solve the months problem.
6. **FTMO fit.** Good: a hold cap also caps daily-loss exposure and weekend gap risk. Nightly break: no change.
7. **Data, pins, cost.** H4 and M30 pins; $0.
8. **Honest test.** Hypothesis: among exits (3R fixed as is, 10-day cap, 10-day cap plus the Wednesday rule, half-off at 1R with the rest to 3R), the capped one lifts the mean R with swap by at least 0.03R without lowering the win rate below 35 (the operator's floor). Acceptance: that, at the 95% one-sided level on a paired difference (same entries) in 2015 to 9 July 2026, and the same sign in the pre-2015 hold-out. In-sample cells: at most 4 (declared). Trial ledger: +4. Cheapest kill: the cap loses more R than it saves in the 10 worst-held trades' R totals, which the current trade list can show in an hour.
9. **Effort.** Small (exit-rule change in the harness first; then one fenced PR after the verdict).
10. **Confidence.** Medium. It is the cheapest direction that attacks a measured cost (0.088R per trade) without inventing a signal.

## D7. Sizing built for the FTMO loss rules

1. **Idea.** Size each trade by the remaining distance to the account's floors instead of a fixed percentage: smaller near the 10% floor and near the daily limit (the control problem FTMO sets), larger when the target is close and the edge is proven. The rule: risk = min(0.30%, (equity − floor) × k, daily budget left × m), with the daily budget reset at midnight in Prague.
2. **Mechanism and the other side.** None: it changes the variance of the path, not the mean. The "opponent" is the barrier: the account is absorbing at −10% (from the initial balance, not the peak) and at the daily limit.
3. **Evidence for and against.** For: at 0.30% on $50K, 84% funded and P(ML > 10%) 3.5% (02 §2.6); a static 0.30% is a compromise between speed and breach; the simulators' worst 60-day window is 6.4% (02 §2.6); 03's 2018 path drew 14.6% over seven months, so drawdowns arrive slowly, which is what a state-aware rule can slow. Against: with a mean of 0.255R (swap) the whole edge is small, and dynamic sizing of an edge that may be zero only changes how it fails; the simulator uses UTC days and floating equity (02 §2.6, 02a §5), so the rule's inputs are approximations.
4. **What changes and what it reuses.** Not a variation of the rules: sizing only. Reuses the harness, the simulators and the pinned-data rules. Carries over to any prop account.
5. **Trades per month.** Unchanged (4.0 independent). The test is a simulation over the corpus and the bootstrap, which gives many resampled challenges rather than trades.
6. **FTMO fit.** This is the FTMO fit: the daily limit and the 10% floor are the two constraints. Must be checked against Prague-midnight resets and against 47 of 859 exits that fall on a different FTMO day than the UTC day (02a §5). No swap or break effect.
7. **Data, pins, cost.** The existing trade lists and the challenge simulator. $0.
8. **Honest test.** Hypothesis: the state rule raises P(funded within 18 months) at equal P(ML > 10%) in the simulator, judged by pass probability on the resampled challenges (block-bootstrap of trades, with the swap applied), on in-sample data 2015 to 2026. Acceptance: at least +3 points of pass probability at the same breach probability, with the trade list's order unchanged (no look-ahead: the rule sees only equity and time). In-sample cells: at most 6. Trial ledger: +6 (simulation, not configurations of signals). Cheapest kill: the best of 6 improves pass probability by less than 3 points.
9. **Effort.** Small (simulation); medium if it goes to the live engine (fenced, after the verdict).
10. **Confidence.** Medium. The gain is bounded and real only if the edge is real; it protects a challenge from bad luck but does not create an edge.

## D8. Outside the price: rates and dollar as a regime input

1. **Idea.** Ask whether real yields, the dollar and positioning say anything about the next 20 sessions of gold bias, which price-only variables do not (03 §3.4).
2. **Mechanism and the other side.** Gold's price is set by real rates and the dollar more than by its own momentum. The other side is the macro trader who is early, and the systematic trend-follower who reacts late.
3. **Evidence for and against.** For: 03 §3.4's ten variables are all derived from gold itself, so a null there says nothing about outside variables. Against: 42 quarterly points give power only for large effects (ρ above about 0.3); gold's dependence on real yields is well known and crowded; daily yields are revised; the corpus of OANDA positioning is 5 months and COT (weekly) has a publication lag.
4. **What changes and what it reuses.** Data and a feature pipeline; reuses the regime tables of Phase 3. Not a variation. Carries over directly to currencies and indices (same macro drivers).
5. **Trades per month.** Unchanged; the test is on sessions (2,993) not trades. To detect a 10-point lift in the next-20-session bias (the bias is bullish 56% of sessions) needs about 300 independent 20-session windows, so it uses quarter-blocks: 46 windows today, which cannot reach it. A first look would be exploratory only, with the honest note that its power is low.
6. **FTMO fit.** Unchanged (a switch in or out of the existing trades). News timing is better.
7. **Data, pins, cost.** FRED: DFII10 (real yield), DTWEXBGS (dollar), free. CFTC COT weekly, free (lagged Tuesday-to-Friday, dated to the release). OANDA positioning: 7,463 rows in the database from 10 June (5 months) — usable only as a forward sample. New pins with hashes and the release dates as the stamps. $0 (one afternoon of fetching, which needs your yes).
8. **Honest test.** Hypothesis: the sign of the real-yield change over 20 sessions predicts the bullish-bias share of the next 20 sessions with the sign agreed in both halves (2015 to 2020, 2021 to 2026 H1) and at p < 0.05 after a block bootstrap. Acceptance: agreement in sign in both halves and a 95% interval excluding zero in the pooled sample, after adjusting for 5 pre-declared variables. Trial ledger: +5. Cheapest kill: the sign flips between the halves, or |ρ| under 0.2 in both.
9. **Effort.** Small for the analysis; medium if it becomes a switch (new data ingestion and point-in-time handling).
10. **Confidence.** Low to medium. This is the one place where the literature says real information may sit, and I tested none of it.

## D9. What a 2026 model can honestly do: event desk and monitor, forward only

1. **Idea.** Use a language model for two jobs that do not need a backtest of the model on history: read the economic calendar and headlines and give a deterministic veto around named events (no trading decision), and summarise the engine's health each day with a "look at this" list. Nothing places orders. Everything is shadow-logged from today.
2. **Mechanism and the other side.** Not a market mechanism. The gain is fewer bad fills (NFP is the −3.27R fill) and faster detection of a broken feed. The other side for the news veto is the same trader who sells into the announcement.
3. **Evidence for and against.** For: one NFP fill cost 0.16R of the live gap (01 A5) and the feed has a fallback that silently changes the bar grid (this status file, the 2nd-grid scans); daily health checks exist but are human-read. Against: the LLM "spring report" path is unusable evidence (A8, §2.8); the model's training cutoff makes any backtest of it leaked by construction; the operator budget is £150/month (LLM_MONTHLY_BUDGET_USD 25).
4. **What changes and what it reuses.** A scheduled read-only job (its output is a row in the database and a daily push) and the existing calendar veto. Nothing in the fenced engine. Carries over anywhere.
5. **Trades per month.** Not applicable: the unit is the event (about 8 to 12 scheduled high-impact events a month) and the incident. A first evaluation needs about 60 events, 5 to 8 months; the veto's value needs those events to have happened to the trades (a trade rarely sits at an NFP).
6. **FTMO fit.** FTMO allows news trading on Swing (the rules say no gambling on news; check the current text before relying on it). The veto is a safety feature that also helps with the challenge's reputation. No swap effect.
7. **Data, pins, cost.** A cheap calendar (existing `economic-calendar.ts`), headlines from a free source (Finnhub, in the repo already). Cost about £5 to £10 a month at the cheapest model on two calls a day. No pin: there is no history to test on.
8. **Honest test.** Hypothesis: in shadow mode the model's risk flags (entry to not-enter) pick out windows where the next 8 hours of XAU/USD volatility is above its median in at least 65% of flags, against a calendar-only baseline (the same flags from a fixed list of events) of 55%. Acceptance: 60 flags, at a one-sided 90% bound, recorded from the date of the go-ahead; nothing from before it counts. Held-out: forward, always. In-sample: none. Trial ledger: +1. Cheapest kill: after 30 flags, accuracy is no better than the calendar-only baseline.
9. **Effort.** Small (one scheduled job, read-only; plus a daily message). One PR, infrastructure.
10. **Confidence.** Low that it earns money; medium that it finds operational problems early, which is worth the £10 and the hour a month.

## D10. A fill laboratory: measure what trades cost before designing them

1. **Idea.** Log the bid, ask and last price the moment each signal bar closes, again at 18:05 New York (FTMO's reopen) and at the live scan's actual fire, for every signal, whether or not it trades. This settles what FTMO fills (and whether a reopen fill is materially different), what the spread is by hour, and how far the paper fill is from a real one.
2. **Mechanism and the other side.** Not a trading idea: an observation that decides whether the others are feasible. The other side is the broker's spread.
3. **Evidence for and against.** For: fills are unmodelled (04, A11); 85 of 862 entries (9.9%) and 4 of 18 paper entries are at 17:00 New York, inside the FTMO break (02a §3); A12 shows the spread is understated. Against: it produces no profit, and it needs a read-only quote source (Twelve Data and OANDA are reachable; FTMO's would need the MetaApi demo connection, which is a read-only credential question for you).
4. **What changes and what it reuses.** A small read-only script on the VPS cron, writing to a new table (a migration, so fenced) or to a file. Reuses the scan's signal evaluation only if it is logged to the activity log (not the fenced engine). Carries over to every instrument.
5. **Trades per month.** None; it logs about 4 signal moments a month plus the 17:00 check each session (22 a month). Three months gives 66 nightly reopen observations.
6. **FTMO fit.** It is the measurement for the nightly break and the spread field of every other direction.
7. **Data, pins, cost.** Live quotes from existing feeds. $0. FTMO's own quotes would need read-only access to a demo account, which only you can grant.
8. **Honest test.** Hypothesis: the reopen price at 18:05 differs from the 17:00 price by more than one spread in over a third of sessions (so fills at the reopen are materially different). Acceptance: 60 sessions logged; the median absolute gap reported with its interval; a decision table (model as 'fill at reopen' or 'drop the 17:00 slot'). Held-out: forward. Trial ledger: +0. Cheapest kill: the median gap is below a spread after 20 sessions (then model the fill at the last bar's close as now).
9. **Effort.** Small for the logging script; medium with the migration and the fence.
10. **Confidence.** High that it is needed before any FTMO money; it produces no edge.

## D11. Blank sheet: if I started again

1. **Idea.** A long/flat intraday system on 30-minute bars with one entry rule (a pullback to a rising 1h average inside a bullish day), a stop of 1 to 1.5 × M30 ATR, a 1.5R target, at most two trades a day, flat by 16:45 New York, and sized for FTMO's two loss rules. It is D4's cost shape with D3's direction. It has no overnight, no swap, no weekend, and it produces 15 to 30 independent trades a month.
2. **Mechanism and the other side.** Intraday pullback in a directional session: buying what stops out the late momentum trader. The other side is the fade-seller who is right on chop days and wrong in trends (the 41% of sessions in chop are the cost).
3. **Evidence for and against.** For: the swap and the break go away; months-to-evidence falls by about five to six times; sessions with bullish bias carry the system's whole profit (03 §3.2), so an intraday design can be conditioned on the same state. Against: E2.23's zero passers; spread and slippage are a large part of a 1 × ATR stop (A12 says 1.5 bps median round trip; at 0.15% stop = 10% of R); nothing yet says the 30-minute direction within a bullish-bias day is predictable.
4. **What changes and what it reuses.** A new module (about 400 lines): entry, stop, time exit, session gate. It would reuse the pins, harness, risk layer, and fence rules. Nothing from the deployed algorithms. Carries over to any 24-hour market.
5. **Trades per month.** 20 to 30 independent **(est.)**. With 0.1R per trade and σ 1.1 it needs 749 trades, 25 to 37 months; with 0.15R, 333 trades, 11 to 17 months. It can be falsified by one year of forward data only in the second case.
6. **FTMO fit.** Best. Needs a 2% personal daily stop (below the 5% limit), and the 47-day UTC-versus-Prague mismatch is trivial for a day trade.
7. **Data, pins, cost.** M30 pin (2015 to July 2026). Pre-2015 M30 would need a new pin, unverified. $0.
8. **Honest test.** Hypothesis: the M30 pullback rule has mean R at least 0.10 (after 1 bp costs) on 2015 to 2020 and the same sign on 2021 to 2026 H1, and in the pre-2015 hold-out. Acceptance: the lower one-sided 95% bound above zero on each half, with at most 8 declared cells. Trial ledger: +8. Cheapest kill: two cells fail on 2015 to 2020 alone (no second look).
9. **Effort.** Large (a new family, a new data path, plus the FTMO-shaped engine changes; about 3 PRs).
10. **Confidence.** Low that a first version has an edge (the search has closed 30m/1h once); medium that this is the right *shape* (short holds, many trades, FTMO-native) and the only shape with a realistic path to evidence.

---

## Ranking (one line each)

1. **D1 — Placebo entries.** Decides whether the five rules' entries matter at all; cheapest and most informative.
2. **D6 — Swap-aware exits.** Attacks a measured cost with the entries we have; cheap; bounded.
3. **D2 — Daily trend core as the benchmark.** Says whether the stack is alpha or beta; cheap.
4. **D10 — Fill laboratory.** Measurement before trading FTMO; no profit, must precede D3, D4 and D11.
5. **D7 — FTMO-state sizing.** Improves survival; needs an edge to be worth anything.
6. **D4 — Intraday, no-swap fade.** The only direction with a realistic 1-year evidence path; expensive to find.
7. **D11 — Blank sheet.** The right shape; large; D1 and D2 should go first.
8. **D3 — Faster entries, short holds.** Cost-aware variant; E2.23 is prior weight against it.
9. **D8 — Rates and dollar.** Untested information; power is low; ask for data first.
10. **D9 — LLM event desk.** Cheap safety; no profit claim.
11. **D5 — Purpose-built short.** Too few trades to be proven; keep for a small hedge.

**The three to test first:** **D1, D6, D2.** D1 and D2 are the two cheap tests that could end the current system's case: if random entries or a one-rule trend match it after costs, the patterns are noise and the right answer is to stop building on them. D6 then addresses the swap on whatever is left. D10 runs alongside as it costs nothing and everything in the first three needs it at the end.

## What we are doing that I would stop

- **Stop counting a swap-free Sharpe as the headline.** Use the swap-restated one from now on (02a). It is the number an FTMO account will see.
- **Stop running sweeps on the pinned corpus.** 3,300 configurations on one tape, deflated Sharpe under 0.05 at N = 3,300 and σ = 0.060 (02a §2). One declared test per direction, then move.
- **Stop treating five algorithms as five bets.** They share 35% of their entry bars (02 §2.5); the independent count is 557, and after the swap the edge is smaller. Adding siblings adds no evidence.
- **Stop the self-modifying mechanisms (A3: the hour filter and auto-pause) from going live with no manual override.** The hour filter is off as of 17:30 UTC today; the auto-pause is code and needs the Phase 6 change.
- **Stop expecting M1 to be decided by trade counts.** 289 trades at 4.0 a month is about six years; M1's n = 30 can check parity only (02 §2.5, 01 A1).
- **Stop aiming any challenge purchase at the swap-free numbers** (84% funded, 20 months): with the swap they are worse. Phase 7 will restate them.
- **Stop expecting the LLM path to be validated on history.** Forward shadow only.

## What I would have asked for that this brief did not

1. **A benchmark.** "Beat buy-and-hold gold, at the same volatility, after swap" — D2. Nothing in the repo compares the system with that (it is compared with itself).
2. **Permission to fetch the pre-2015 history** (one read-only OANDA pull, pinned and hashed). It is the only unselected data that contains a long bear market. If the series does not exist, that is worth knowing too.
3. **A trial budget.** How many more tests (in configurations) is the operator willing to spend before stopping? I used a count per direction above so a budget can be drawn (about 60 to 70 configurations for all of them together).
4. **Fill measurement on FTMO's quotes** (a read-only demo connection). This decides whether a reopen fill is a tradeable price.
5. **The kill criteria.** What result from D1 and D2 would make the operator stop running the 5-algo system, and with what money at stake. Deciding that before the tests is the honest order.
6. **The challenge timeline the operator is willing to pay for**, in months and pounds (a $50K / 0.30% challenge is 20 months from start to funded in the simulator, before swap). Every evidence estimate depends on it.
7. **What to do about the paper record** (18 trades, −9.9R): keep it as evidence of parity only, which is all it can be, or reset it after the Phase 6 changes.

---

**Method note.** The numbers in this file that are not cited from 01, 02, 02a or 03 are estimates and are marked **(est.)**. Cadences are derived from the 862-trade list and 138 months; months to 166 or 289 are arithmetic on those figures and carry the swap-adjusted mean of 0.255. No backtest of any direction has been run.
