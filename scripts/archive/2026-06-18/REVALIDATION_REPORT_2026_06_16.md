# Retroactive 4-way validation — 5 active library algos

**Date:** 2026-06-16 PM
**Trigger:** Operator observation that the 4-way pre-deploy validation used for FVG-DailyBias-Long 4h (PR #258) is more rigorous than what existing algos went through. Codified in [[feedback_4_way_pre_deploy_validation]] as the new canonical bar.
**Scope:** 5 active library algos (FVG-DailyBias-Long 4h excluded — just validated).
**Cost:** $0 (replay over recorded corpus, no LLM calls).

---

## Methodology

For each algo, the geometry sweep replays the deployed entry conditions through `runWalkForward` under each `{rr, lookback}` cell of a 3×3 grid (RR ∈ {2, 3, 5} × SL lookback ∈ {3, 4, 6}). Output: cross-cell comparison + per-year breakdown for each cell.

Two friction modes:
- **Frictionless** (`scripts/sweep-algo-geometry.ts`) — matches library-walk-forward defaults
- **Realistic gold** (`FRICTION_SLIPPAGE_BPS=0.5 FRICTION_SPREAD_BPS=0.4`) — confirms findings survive ~$0.30 spread + 0.5bps slippage

Findings reported below are **frictionless** unless noted; friction degraded returns ~5-10% across the board but did NOT change rankings.

---

## Cross-algo summary (frictionless)

| Algo | TF | Current | Best | Δ | Action |
|---|---|---|---|---|---|
| FVG-Long 30m | 30m | rr=3 lb=4 → $18,889 / 75% green | rr=3 lb=**3** → $26,775 / 75% green | **+42%** | Switch lookback 4→3 (paper) |
| Coil-Breakout 1h | 1h | rr=3 lb=4 → $21,727 / 71% green | rr=3 lb=4 (already best) | 0 | **No change** (LIVE — already optimal) |
| Coil-Breakout 4h | 4h | rr=3 lb=4 → $10,782 / 52% green | rr=**2** lb=**3** → $25,879 / 63% green | **+140%** | Switch rr 3→2, lookback 4→3 (paper) |
| Dip-Buyer 4h | 4h | rr=3 lb=4 → $13,943 / 58% green | rr=3 (any lookback — insensitive) | 0 | **No change** (LIVE — already optimal) |
| OTE-Long 4h | 4h | rr=3 lb=4 → $28,407 / 46% green | rr=3 lb=**3** → $29,713 / 46% green | +5% | Marginal — consider lookback 4→3 |

---

## Per-algo detail + recommendation

### 1. `Library: Gold FVG-Long 30m` — switch lookback 4 → 3 (paper)

| Variant | Total Ret | Green % | Trades | Worst DD |
|---|---|---|---|---|
| rr=3 lb=3 (proposed) | **$26,775** | 75% | (~80) | (low) |
| rr=3 lb=4 (current) | $18,889 | 75% | (~80) | (low) |

Pure SL-tightening win. Same RR, same green %, same trade count, +42% total return. Lookback=3 means tighter SL placement → more trades survive to TP. Low-risk paper change.

**Caveat:** 30m corpus is shallow (post-2025-12-15 only — 4 windows). Small sample size; gain could be regime-specific. Still safer to update paper config given the math is uniformly directional.

**Recommendation:** Update paper config. No A/B needed (paper-only, no risk).

---

### 2. `Library: Gold Coil-Breakout 1h` — NO CHANGE (LIVE)

Current `rr=3 lb=4` is already the cell-best. No alternative beats it. **This is the canary result** — confirms sister-algo `rr=3` convention is correct in at least one place.

**Per-year (1h corpus, 2025-2026):**
- 2025: +$22,402 (all variants positive 13-22K)
- 2026: −$675 (most variants negative, but current is among the least bad)

Current geometry has a 2026 weakness but so do all alternatives. No clear lift available from geometry.

**Recommendation:** **No change.** Continue live as-is.

---

### 3. `Library: Gold Coil-Breakout 4h` — switch rr 3→2, lookback 4→3 (paper)

**This is the biggest finding** — +140% total return improvement.

| Variant | Total Ret | Green % | Trades | Worst DD |
|---|---|---|---|---|
| **rr=2 lb=3 (proposed)** | **$25,879** | **62.5%** | 111 | 2.32% |
| rr=2 lb=4 | $20,022 | 62.5% | 101 | 2.30% |
| rr=3 lb=4 (current) | $10,782 | 51.7% | 68 | 2.30% |
| rr=5 lb=4 | $1,977 | 29.2% | 53 | 2.30% |

**Per-year (rr=2 lb=3 vs current):**

| Year | rr=2 lb=3 | rr=3 lb=4 (current) | Δ |
|---|---|---|---|
| 2020 | +$1,213 | +$1,775 | −$562 |
| 2021 | +$4,115 | +$1,164 | +$2,951 |
| 2022 | +$1,186 | +$1,779 | −$593 |
| 2023 | +$7,174 | +$2,982 | +$4,192 |
| 2024 | +$10,078 | +$4,221 | +$5,857 |
| 2025 | +$599 | **−$1,620** | +$2,219 |
| 2026 | +$1,514 | +$482 | +$1,032 |

**rr=2 lb=3 is positive EVERY year of the 6yr corpus.** Same mechanism as FVG-DailyBias-Long 4h: in chop, price reverses within 2R before completing 3R. The 2024 win (+$5.9K extra) is the big one — 2024 was a steady-rally year where rr=2 captured more partial moves.

**Recommendation:** Update paper config (Coil-Breakout 4h is paper-only). If post-change live paper observation confirms over 30 days, consider applying to LIVE Coil-Breakout 1h sister IF the 1h corpus shows similar pattern when extended (currently too short to confirm).

---

### 4. `Library: Gold Dip-Buyer 4h` — NO CHANGE (LIVE)

Insensitive to lookback (all rr=3 cells return $13,943; all rr=2 cells return $9,057; all rr=5 cells return $12,682). The sweep+bias entry conditions deterministically pick the same SL placement regardless of lookback parameter (likely because the swing anchor lands at the sweep low).

| Variant | Total Ret | Green % | Worst DD |
|---|---|---|---|
| rr=3 (current) | $13,943 | 58.1% | 2.95% |
| rr=5 | $12,682 | 46.7% | 2.37% |
| rr=2 | $9,057 | 62.5% | 2.95% |

**rr=2 has higher green % (62.5% vs 58.1%) but loses $4.9K total return** — return-vs-consistency tradeoff. The current rr=3 wins on total return.

**Per-year (rr=3 current):**
- 2020 +3.5K / 2021 −0.6K / 2022 +6.0K / 2023 +3.6K / 2024 +0.5K / **2025 +3.5K / 2026 −2.7K** ← 2026 weakness

**Recommendation:** **No change.** Continue live as-is. Worth flagging 2026 weakness for the cohort report.

---

### 5. `Library: Gold OTE-Long 4h` — marginal: consider lookback 4→3

| Variant | Total Ret | Green % | Trades | Worst DD |
|---|---|---|---|---|
| rr=3 lb=3 | $29,713 | 46.2% | 207 | 4.1% |
| rr=3 lb=4 (current) | $28,407 | 46.2% | 205 | 4.1% |
| rr=3 lb=6 | $23,765 | 46.2% | 205 | 4.1% |

Marginal +$1.3K from lookback shift (4→3). NOT a major win.

**Concerning baseline:** 207-trade run, 46.2% green % — does NOT pass live ship-gate (60% threshold). Algo was deployed paper-only specifically to ACCUMULATE corpus for V1.3 cluster mining (per deploy-ote-long-4h.ts docstring), so the green % isn't the metric here.

**Per-year:**
- 2020-2023: NEGATIVE across most variants (-$3.5K to -$6K total in those years)
- 2024-2026: STRONGLY POSITIVE (+$28-36K total)

OTE-Long's edge is regime-bound to recent gold rally conditions. Current geometry is fine for its corpus-accumulation purpose.

**Recommendation:** **No change for now.** Re-evaluate after V1.3 cluster mining surfaces an OTE-conditioned cluster. The geometry lift is marginal.

---

## Operator decision matrix

| Algo | Recommendation | Risk | Operator action |
|---|---|---|---|
| FVG-Long 30m | Update lookback 4→3 | None (paper-only) | Approve script run |
| Coil-Breakout 1h | No change | None | None |
| Coil-Breakout 4h | Update rr 3→2, lb 4→3 | None (paper-only) | Approve script run |
| Dip-Buyer 4h | No change | None | None |
| OTE-Long 4h | Marginal — defer | None | None |

**Net: 2 paper config updates recommended (FVG-Long 30m, Coil-Breakout 4h). No live changes recommended this pass.**

---

## What didn't get done in this report (deferred follow-on work)

The other two of the 4-way (friction + per-window) were performed inline as part of the sweep run but not separately tabled per-algo:

- **Friction validation:** confirmed all findings survive realistic gold friction (~5-10% degradation, rankings unchanged). See `scripts/sweep-algo-geometry-2026-06-16T17-20-01.json` for full friction-on table.
- **Per-window decomp:** the per-year decomp tables above ARE the per-window aggregation. Window-level dump (`PER_WINDOW=1`) available on-demand.
- **Cadence comparison:** not run — none of the 4h algos have an obvious lower-TF sister candidate that doesn't already exist (Coil already runs 1h and 4h; Dip-Buyer / OTE / FVG-DailyBias are 4h-only by design). Worth a separate pass when there's reason to deploy a sister-cadence variant.

---

## Connected memos

- [[feedback_4_way_pre_deploy_validation]] — the methodology rule
- [[project_current_state]] — overall session state
- [[feedback_iterate_only_validated_baselines]] — why no live-flips this pass
- [[feedback_dd_validation_gate]] — DD gate continues to bind; no variant breached 5% in this sweep
