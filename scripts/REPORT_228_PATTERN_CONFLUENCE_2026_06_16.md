# Pattern confluence test — close audit #228 (S1.5 priority #6)

**Date:** 2026-06-16 PM
**Trigger:** Audit issue #228 sub-3 ("pattern confluence/sequences") had been deferred with rationale "composing weak primitives unlikely to surface edge." With #245 sweep+reclaim un-killed in PR #262 and 4 confirmed winner-discriminator primitives now in inventory (daily_bias, fvg, equal_levels, sweep_reclaim), worth testing empirically before closing definitively.
**Outcome:** Two distinct findings: (1) **#228 closes with nuanced verdict** — confluence has signal but doesn't beat the 2-primitive baseline when DD isn't binding. (2) **First S5 multi-instrument deploy** — `Library: USD/JPY FVG-DailyBias-Long 4h` shipped paper-only based on PR #261 + this analysis.

---

## Methodology

Two-stage test:
1. **Friend-replay extension** (`replay-friend-trades.ts`): added confluence-among-winner-discs cross-tab. WR by primitive count + per-pair WR.
2. **Backtest** (`test-confluence-228.ts`): 5 variants × 4 instruments × 6yr corpus.
   - B0 fvg + daily_bias (baseline = current FVG-DailyBias-Long config)
   - B1 fvg + daily_bias + equal_levels (triple — audit #228 main test)
   - B2 fvg + daily_bias + sweep_reclaim (triple, different 3rd)
   - B3 quad (all 4 winner-discs)
   - B4 fvg + equal_levels (pair without daily_bias)

Forex tested with pct-0.30% SL (per PR #261 finding); gold with swing_anchor 0.10/4.

---

## Friend-replay confluence results

WR by count of winner-disc primitives firing in his trade direction:

| # fired | n | Winners | WR |
|---|---|---|---|
| 0 | 10 | 3 | 30% |
| 1 | 6 | 3 | 50% |
| 2 | 16 | 10 | 62.5% |
| 3 | 4 | 4 | **100%** |
| 4 | 2 | 2 | **100%** |

Cumulative ≥k:
- ≥1: 67.9% WR (vs baseline 57.9%)
- ≥2: **72.7% WR** (+15pp)
- ≥3: **100% WR** (small sample n=6)

**Friend-replay shows strong confluence signal.** But sample sizes small (n=38 total trades).

Pair-level (each pair of 2 winner-disc primitives co-firing):
- daily_bias + fvg: **100% WR (7/7)** ← exactly the FVG-DailyBias-Long composition (PR #258 retrospective validation)
- fvg + equal_levels: **100% WR (7/7)**
- daily_bias + equal_levels: 70.6% (12/17)
- daily_bias + sweep_reclaim: 80% (4/5)

---

## Backtest results — confluence is INSTRUMENT-SPECIFIC

B1 (fvg + daily_bias + equal_levels) per pair, vs B0 baseline:

| Pair | B0 (baseline) | B1 (triple) | Verdict |
|---|---|---|---|
| XAU/USD | n=141 / $32K / 4.15% DD | n=27 / +14% mean R | n<30 fails ship-gate |
| EUR/USD | n=238 / $42K / 8.4% DD | n=82 / +3% mean R | ships but marginal |
| GBP/USD | n=236 / $38K / 6.3% DD | n=76 / **−61% mean R** | **HURTS** |
| USD/JPY | n=302 / $108K / 5.25% DD | n=77 / **+76% mean R** | strong on a per-trade basis |

**Same triple-confluence variant helps USD/JPY (+76%), is neutral on EUR/USD (+3%), and HURTS on GBP/USD (-61%).** No universal "confluence makes everything better" rule.

Also notable:
- **B2 (fvg+bias+sweep_reclaim) on GBP/USD**: n=23 / mean R 0.912 / 65% WR / DD 1.25% — exceptional cell but n<30
- **B3 quad**: always too restrictive (n=2-11 per pair)
- **B4 (fvg+eql, no bias)**: 0-30% lower than B0 — daily_bias is load-bearing

---

## #228 closure verdict

**Confluence DOES have signal but is instrument-specific AND doesn't beat the 2-primitive baseline when DD isn't binding.**

Mechanism:
- Triple-confluence variants prune trade count significantly (typically 70-80% fewer trades)
- The per-trade R lift (when present) doesn't compensate for the lost trade volume
- B1's "+76% mean R lift on USD/JPY" sounds dramatic but B0's $108K total beats B1's $48K total ($60K of total return is in the trades B1 prunes out, and B0 was already capturing them within its DD budget)

When IS triple-confluence preferable?
- If DD is binding (B0 near or over 10% cap) → triple-confluence's selectivity buys headroom
- If trade frequency is a problem (operator load) → fewer-but-higher-quality entries
- If risk-per-trade is being scaled up dramatically → higher per-trade R justifies fewer trades

None of these apply to USD/JPY today. B0 has 4.75pp DD headroom; trade frequency is healthy; risk sizing is fine.

**Close #228 with verdict:** "Confluence tested empirically. Real signal but only marginal lift over 2-primitive baselines and instrument-specific. Pruning trade volume below 100/6yr loses more total return than per-trade R lift compensates. Re-test if DD pressure increases or new primitives surface."

---

## Side-effect — first S5 multi-instrument deploy

The confluence test surfaced the BACKTEST B0 numbers on each forex pair (matches PR #261 forex prep findings). USD/JPY's B0 cell is:
- $108,421 total return
- 302 trades / ~50 trades/year — strong frequency
- 51.7% WR
- 5.25% DD (4.75pp headroom under 10% cap)
- Per-year positive every year of 6yr corpus
- Strongest single cell of any tested S5 candidate

Deployed via `scripts/deploy-fvg-dailybias-long-4h-usdjpy.ts` (APPLY=1):
- Algo id: `290ee500-944e-4280-b2e2-3e0c42c6202a`
- Name: `Library: USD/JPY FVG-DailyBias-Long 4h`
- Geometry: percentage 0.30% SL + rr=2 (forex-tuned, per PR #261)
- Status: active, **PAPER-ONLY** (live_trading_enabled=false)
- Watchlist: USD/JPY

**This is the FIRST forex algo in the library.** Library now: 7 active + 1 paused.

---

## Ship-gate calibration (n=22 misreading, see feedback memory)

In session, the operator initially asked about lowering the ship-gate to n=22 (interpreted per-year). Comparator data showed shipped algos run n=58-205 over the 6yr corpus (10-34/year). n=22 per-year would equal n=132 over 6yr — well above current threshold. n=22 over 6yr (~3.7/year) would be well below portfolio norm.

**Decision:** n≥30 over 6yr stays. See `feedback_ship_gate_22_trades.md` (marked SUPERSEDED as anti-regression marker).

---

## Action taken

1. ✅ `replay-friend-trades.ts` extended with winner-disc-primitive confluence cross-tab
2. ✅ `test-confluence-228.ts` written + run on 4 instruments × 5 variants
3. ✅ Empirical verdict documented
4. ✅ `Library: USD/JPY FVG-DailyBias-Long 4h` deployed paper-only via deploy script
5. ✅ Audit #228 sub-3 closed with nuanced verdict

---

## Files in this PR

- `scripts/replay-friend-trades.ts` — extended with confluence cross-tab
- `scripts/test-confluence-228.ts` — new backtest variant tester
- `scripts/deploy-fvg-dailybias-long-4h-usdjpy.ts` — first S5 deploy script
- `scripts/REPORT_228_PATTERN_CONFLUENCE_2026_06_16.md` — this report
- `feedback_ship_gate_22_trades.md` — superseded marker (n stays at 30)

---

## Connected memos

- [[project_roadmap_2026_06]] S1.5 #6 — DONE
- [[project_discovery_gaps_audit_2026_06]] #228 sub-3 — closes empirically
- [[project_friend_replay_2026_06]] — confluence cross-tab data added
- [[feedback_ship_gate_22_trades]] — SUPERSEDED marker
- [[feedback_4_way_pre_deploy_validation]] — USD/JPY deploy carries the 4-way validation from PR #261 forex prep work
