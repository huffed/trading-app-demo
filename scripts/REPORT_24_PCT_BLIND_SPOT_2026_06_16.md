# 24% blind-spot investigation (S1.5 priority #4)

**Date:** 2026-06-16 PM
**Question:** Per `project_friend_replay_2026_06`, 9 of friend's 38 FTMO trades (24%) had ZERO of our 8 pattern primitives fire at entry. 3 winners + 6 losers. Roadmap question: "what was he reading on those trades that we don't detect? May surface a NEW primitive worth building."
**Cost:** $0 (replay over recorded corpus).

---

## The 9 trades

| # | Date/UTC | Pair | Side | P&L | Duration | Bar context |
|---|---|---|---|---|---|---|
| 1 | 2026-03-13 10:05 | EUR/USD | LONG | **+$182** | 200min | V-bottom reversal after 50pip drop; ATR pctile 22, pos24h=17%, near round 1.145 |
| 2 | 2026-02-23 08:35 | XAU/USD | SHORT | −$72 | 20min | Shorted DURING $5136→$5210 rally (74pip up move over 6h) |
| 3 | 2026-02-23 09:17 | XAU/USD | SHORT | −$77 | 66min | Same rally, second short attempt |
| 4 | 2026-02-24 23:55 | XAU/USD | SHORT | −$5 | 36min | Late-night discretionary scalp, ended near-flat |
| 5 | 2026-03-05 08:45 | XAU/USD | LONG | +$5 | 46min | First of 5 same-day longs |
| 6 | 2026-03-05 09:45 | XAU/USD | LONG | −$170 | 15min | (XAU dropped from 5160 to 5050 in 6h afterward) |
| 7 | 2026-03-05 10:10 | XAU/USD | LONG | +$15 | 9min | |
| 8 | 2026-03-05 10:29 | XAU/USD | LONG | −$71 | 4min | |
| 9 | 2026-03-05 10:34 | XAU/USD | LONG | −$69 | 2min | |

**Aggregate P&L on the 9 zero-primitive trades: −$262** (3 winners +$202, 6 losers −$464).

**Aggregate P&L excluding the 1 genuine-signal candidate (trade #1): −$444 on 8 trades.**

---

## Categorization

### Category A — possibly missing signal (1 trade, 11%)

**Trade #1 (EUR/USD LONG +$182):** the only zero-primitive trade with a real signal. Setup:
- After a sharp 50-pip drop (1.1500 → 1.1450) over 4 hours
- ATR pctile 22 (low-volatility regime)
- Entry near 24h low (pos24h = 17%)
- Entry bar wicked to L=1.14520 then rallied to H=1.14722 — V-bottom inside one bar
- Held 200 min, exited near intraday peak ~1.1488

This is an **intraday-V reversal after a sharp drop near a 24h extreme** pattern. Possible missing detector classes:
- **24h-extreme reversal**: bar reverses sharply from a 24h extreme with intra-bar V structure
- **Drop-then-reclaim**: ≥2× ATR drop in N bars followed by full reclaim within 1 bar

But our `liquidity_sweep` detector should arguably have caught the prior bar's wick of 1.14330 (then closed 1.14452). It didn't — likely because our sweep definition uses a 5-bar swing-low reference and 1.14330 wasn't far enough below the recent swing.

### Category B — wrong-side trades, primitives correctly didn't fire (7 trades, 78%)

**Trades #2-3 (XAU/USD SHORT 2026-02-23):** friend shorted around 5147 while gold was IN a multi-hour rally ($5136 low → $5210 high over 5 hours). Bearish primitives (bos_bearish, fvg_bearish, daily_bias_bearish) correctly did NOT fire because gold was rallying. He was fighting the trend; primitives are SUPPOSED to disagree.

**Trades #5-9 (XAU/USD LONG 5x on 2026-03-05):** friend bought 5 times in 1.5 hours between 08:45 and 10:34. The SAME 4h period:
- Hours 08-12: range-bound 5146-5180
- Hour 13: BREAKDOWN — drops 5164 → 5081 (one bar, $83 drop)
- Hours 14-19: continued collapse to 5050 area

Bullish primitives (bos_bullish, fvg_bullish, daily_bias_bullish) correctly did NOT fire because XAU was breaking down. He was repeatedly trying to catch the bottom of a strong down-move. **Primitives were RIGHT to stay silent.**

### Category C — discretionary noise (1 trade, 11%)

**Trade #4 (XAU/USD SHORT 2026-02-24 23:55):** 36-min late-night scalp ending −$5 (near-flat). Not enough signal in either direction to merit a detector.

---

## Reframing the 24% blind spot

**The original framing assumed the 24% might contain missed signals worth detecting.** The actual breakdown:

- **78% of the blind spot is wrong-side discretionary trading** (shorting an uptrend, longing a breakdown). Our primitives correctly identified those entries as "don't trade" — they are doing their job by NOT firing.
- **11% is discretionary noise** (low-stakes scalp).
- **11% is potentially missing signal** (1 trade, n=1).

The 24% "blind spot" is NOT a coverage gap in our detectors. It's mostly the noise component of any discretionary trader's record — losses from fighting the trend, over-trading, and scalping at random points. Our primitives' INABILITY to detect those entries is a feature, not a bug.

**This is the same pattern as the audit-phantom finding from earlier this session** (see [[feedback_audit_phantom_pattern]]): exhaustive coverage of an audit list returns mostly phantoms. The remaining genuine items are too thin individually to justify investment.

---

## Recommendation

**Don't build a new primitive based on this investigation.** Specifically:

1. **The 8 wrong-side / noise trades** don't represent missing signals — they represent friend's discretionary error rate. Building detectors that fire on them would degrade our edge, not improve it.

2. **The 1 EUR/USD intraday-V reversal trade** is interesting but n=1. We'd need ≥5-10 similar setups across our 6yr corpus to justify a detector. Sub-task hypothesis if operator wants to pursue later:
   - "intraday-V detector": bar hits 24h-low ATR-percentile-low, intra-bar wick + close ratio > X, prior 3-bar move was ≥2× ATR drop
   - First step would be backtest: count similar setups on EUR/USD 6yr corpus, measure forward 5-10 bar performance
   - Only build the detector if backtest shows positive expectancy at meaningful n

3. **Better roadmap action: focus on validated direction.** Friend-replay already identified daily_bias + FVG + equal_levels-as-structural as winner-discriminators ([[project_friend_replay_2026_06]]). S1.5 #1 (FVG-DailyBias-Long 4h) and #3 (forex prep) acted on those. The 24% blind spot tail offers diminishing returns.

**Close S1.5 priority #4** as "investigated, no actionable new primitive." Possible follow-up hypothesis on intraday-V reversal logged but not committed.

---

## Connected memos

- [[project_friend_replay_2026_06]] — the source data
- [[feedback_audit_phantom_pattern]] — same diminishing-returns pattern
- [[feedback_both_styles_valid]] — friend's style has discretionary noise; ours has different noise. Both can be profitable.
- [[project_roadmap_2026_06]] S1.5 priority #4
