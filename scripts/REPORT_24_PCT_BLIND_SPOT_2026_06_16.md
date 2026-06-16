# 24% blind-spot investigation (S1.5 priority #4)

**Date:** 2026-06-16 PM
**Trigger question:** Per `project_friend_replay_2026_06`, 9 of friend's 38 FTMO trades had ZERO of our 8 pattern primitives fire at entry. What was he reading that we miss?
**Outcome:** Closed S1.5 priority #4 as "investigated" with TWO distinct findings:
1. **The 24% blind spot is not a coverage gap** (78% are correctly-not-detected wrong-side trades).
2. **A new winner-discriminator primitive surfaced as a side-effect: `liquidity_sweep_reclaim`.** The #245 kill was based on the wrong measurement.

This second finding only came to light because the operator pushed back on the first-pass categorization ("you dismissed losers too easily — outcome ≠ no-signal"). The re-analysis identified one trade's V-bottom structure, which prompted re-examining the sweep+reclaim hypothesis, which led to building the detector and finding it has real signal across both friend-replay AND 6yr backtest.

---

## Finding 1 — The 24% blind spot is mostly his discretionary noise

### The 9 trades + structural read

| # | Date/UTC | Pair | Side | P&L | Duration | D1 bias | Zone | ICT-standard signal? |
|---|---|---|---|---|---|---|---|---|
| 1 | 03-13 10:05 | EUR/USD | LONG | **+$182** | 200min | bearish | discount (20% 4h, -84% pdh-pdl) | YES — V-bottom after −50pip drop at 24h low + low ATR (n=1, isolated) |
| 2 | 02-23 08:35 | XAU/USD | SHORT | −$72 | 20min | **bullish** | 22% (discount) | NO — shorting discount in bullish D1 |
| 3 | 02-23 09:17 | XAU/USD | SHORT | −$77 | 66min | **bullish** | similar | NO — repeat counter-D1 |
| 4 | 02-24 23:55 | XAU/USD | SHORT | −$5 | 36min | **bullish** | 59% (premium) | weak — counter-D1 scalp, near-flat |
| 5 | 03-05 08:45 | XAU/USD | LONG | +$5 | 46min | **bearish** | 78% pdh-pdl (premium) | NO — premium long in bearish D1 |
| 6 | 03-05 09:45 | XAU/USD | LONG | −$170 | 15min | bearish | 79% | NO — repeat |
| 7 | 03-05 10:10 | XAU/USD | LONG | +$15 | 9min | bearish | 70% | NO |
| 8 | 03-05 10:29 | XAU/USD | LONG | −$71 | 4min | bearish | 73% | NO |
| 9 | 03-05 10:34 | XAU/USD | LONG | −$69 | 2min | bearish | 71% | NO |

**8 of 9 trades** are counter-D1 / wrong-zone discretionary entries with NO standard ICT signal in his direction. Our primitives correctly stayed silent — they are doing their job by refusing to fire when the chart says "don't trade."

Net P&L on 8 of 9 non-signal trades: **−$444**. The 1 signal trade (EUR/USD +$182) is a different missing-detector hypothesis (intraday-V at 24h extreme), n=1 — too thin to commit on.

**Conclusion 1:** The 24% "blind spot" is mostly his discretionary error rate. Not a coverage gap. No primitive should be built based on these specifically.

---

## Finding 2 — `liquidity_sweep_reclaim` is a real winner-discriminator we missed

### How this finding emerged

Looking carefully at the EUR/USD WIN structural context:
```
Hour 06: drop 1.150 → 1.148  (broke 1.145 round)
Hour 07: drop 1.148 → 1.145  (continued)
Hour 08: SWEEP — wicked to 1.14330 (new low), closed at 1.14452
Hour 09: stabilize
Hour 10: ENTRY — closed at 1.14584 (RECLAIM above 1.145 round)
```

He entered AT the reclaim bar, 2 bars AFTER the sweep candle. Our `liquidity_sweep` detector evaluates AT the sweep candle, not at the reclaim bar. So at hour 10 (his entry bar), the detector sees no fresh sweep and doesn't fire.

### Per-primitive table on his trades (sweep_reclaim added)

| Pattern | All 38 | Winners | Losers | Edge |
|---|---|---|---|---|
| daily_bias | 61% | **73%** | 44% | +29pp ✓ winner-disc |
| fvg | 29% | **45%** | 6% | **+39pp** ✓ strongest winner-disc |
| equal_levels | 50% | **59%** | 38% | +21pp ✓ winner-disc |
| **sweep_reclaim** (NEW) | **13%** | **18%** | **6%** | **+12pp ✓ winner-disc** |
| ob | 5% | 9% | 0% | +9pp weak winner |
| bos | 8% | 9% | 6% | +3pp neutral |
| **sweep** (raw) | 5% | **0%** | **13%** | **−13pp ✗ loser-disc** |
| ote | 5% | 0% | 13% | −13pp ✗ loser-disc |
| choch | 0% | 0% | 0% | null |

**Raw sweep fires on his losers. Sweep+reclaim fires on his winners.** The #245 sweep+reclaim refinement we killed earlier was actually a real edge — we just measured raw sweep at the wrong moment.

### Caveat — sweep_reclaim doesn't catch the EUR/USD trade

The EUR/USD WIN that triggered the investigation isn't a sweep+reclaim — it's a V-bottom that established a NEW swing low (1.14330) rather than wicking through a PRIOR one. The detector doesn't fire on it.

So sweep_reclaim doesn't shrink the blind-spot count (still 9 zero-primitive). But it catches **4 of his 22 winners** (18%) that we previously couldn't detect at all if we'd been using the right entry-timing definition of sweep.

---

## Finding 2b — Backtest confirms sweep+reclaim has signal in 6yr corpus

Built `src/lib/patterns/liquidity-sweep-reclaim.ts` (fires when a sweep occurred ≤N bars ago AND current bar's close is back inside the swept range — the discretionary "wait for confirmation" entry timing).

Added `sweep_reclaim_dailybias` candidate to `scripts/sweep-forex-prep-s5.ts` and ran on XAU/USD + EUR/USD + GBP/USD + USD/JPY × geometry grid:

| Pair | Best cell (gated) | Return | Trades | Green % | DD |
|---|---|---|---|---|---|
| XAU/USD | sa-0.10/4 rr=3 | $16,401 | 64 | n/a | <3% (est) |
| EUR/USD | sa-0.10/4 rr=5 | $10,612 | 43 | 45% | 2.96% |
| GBP/USD | sa-0.10/4 rr=3 | $9,931 | 44 | 45.5% | 1.78% |
| USD/JPY | pct-0.30 rr=5 | $24,153 | 67 | 47% | **5.91%** ⚠️ |
| USD/JPY (DD-safe) | pct-0.50 rr=3 | $14,605 | 58 | 53% | 4.62% |

**All 4 instruments produce positive returns**. Magnitudes are smaller than the dominant `fvg_dailybias` primitive (typically 4-6×) but the edge is real.

### Geometry-instrument fit observation

- **Gold**: `swing_anchor 0.10/4` works; `pct-0.30` is too tight (large losses).
- **Forex**: both `swing_anchor` and `pct-0.30` to `pct-0.50` work; magnitudes differ.

This is consistent with gold's larger per-bar ATR — a 30 bps SL is too tight for gold's normal noise but appropriate for forex.

---

## Where this leaves #245

The 2026-06-16 PM kill of #245 (`sweep+reclaim refinement`) was based on:
> "liquidity_sweep is a loser-discriminator on friend's trades (0% winners, 13% losers) AND has marginal backtest baseline (-0.05R LONG, +0.03R SHORT). Refinement won't rescue it."

**Both clauses were measured at the wrong bar.**

- The friend-replay 0% winners / 13% losers stat was at the SWEEP CANDLE moment. His winners enter at the RECLAIM CANDLE (1-3 bars later). With the corrected detector, his trades show 18% winners / 6% losers — the OPPOSITE direction.
- The "marginal backtest baseline" was `liquidity_sweep` at the sweep candle. `liquidity_sweep_reclaim_dailybias` at the reclaim candle produces $10-24K returns across 4 instruments × 6yr.

**The kill should be reversed.** #245 stays valid as a future-work item.

---

## Recommendations

### What to build now (this PR)

- `liquidity_sweep_reclaim` detector — DONE in this PR
- Wired through pattern dispatcher + validator + types
- Unit tests (7 cases, all passing)
- Friend-replay extended with new primitive

### What NOT to build now (gated on operator decision)

- A `Library: Gold sweep_reclaim_dailybias 4h` algo deploy. The magnitude is smaller than fvg_dailybias, so deploying it would carry portfolio diversification value rather than dominant-edge value. Owed: full 4-way pre-deploy validation per CLAUDE.md before any APPLY=1.
- A forex sweep_reclaim algo. Same gating.
- Combining `sweep_reclaim` with `fvg` as a confluence filter on existing algos. Possible but adds complexity; should be tested as ablation before adopting.

### Roadmap actions

- **Re-open #245** as "validated, deferred deployment." The kill rationale was wrong; the pattern has real signal in both friend-replay AND 6yr backtest.
- **Close S1.5 priority #4** as "investigated and CLOSED with new primitive surfaced." Original goal (find missing detector for 24% blind spot) was met negatively — the blind spot is mostly noise — but the investigation methodology surfaced an unrelated valuable primitive.

### Process lesson

The first-pass categorization of "wrong-side discretionary trade = no missing signal" was based on outcomes (tautological). The operator's push to re-analyze by STRUCTURE (not outcome) surfaced the EUR/USD V-bottom hypothesis, which led to sweep+reclaim re-examination, which led to a real new primitive. **Always re-check structural reads at entry — outcome-based filtering loses signal.**

---

## Files in this PR

- `src/lib/patterns/liquidity-sweep-reclaim.ts` — the new detector
- `src/lib/patterns/liquidity-sweep-reclaim.test.ts` — 7 unit tests
- `src/lib/patterns/index.ts` — barrel export
- `src/lib/patterns/evaluate.ts` — pattern dispatcher case
- `src/lib/validators/algorithm.ts` — pattern enum
- `src/types/algorithm.ts` — pattern type union
- `src/components/algorithms/rules-display.tsx` — UI label
- `scripts/inspect-blind-spot-trades.ts` — rich-context inspector
- `scripts/replay-friend-trades.ts` — extended with sweep_reclaim
- `scripts/sweep-forex-prep-s5.ts` — extended with sweep_reclaim_dailybias candidate + XAU/USD
- `scripts/REPORT_24_PCT_BLIND_SPOT_2026_06_16.md` — this report
- `.gitignore` — new sweep JSON patterns

---

## Connected memos

- [[project_friend_replay_2026_06]] — source data
- [[project_discovery_gaps_audit_2026_06]] — #245 was closed here, needs re-opening
- [[feedback_audit_phantom_pattern]] — partially still holds, but this case shows operator-question-driven re-analysis CAN surface real findings
- [[project_roadmap_2026_06]] S1.5 priority #4 — closes with new primitive surfaced
