# OTE-Long 4h DD reduction (S1.5 priority #5)

**Date:** 2026-06-16 PM
**Trigger:** `Library: Gold OTE-Long 4h` (deployed paper 2026-06-16 PM, id `8cf42a49`) had 6yr peak-to-trough DD of 11.59% (per OTE standalone validation PR #257) — over the FTMO 10% cap. Need a regime gate that drops DD <10% while preserving most of the +0.28R per-trade edge.
**Outcome:** G3 gate applied (`block dxy=usd_down OR mtf=fast_div_bull`). DD 11.59% → 6.68% (-4.91pp). 82% of total R preserved. Per-trade mean R IMPROVES from 0.284 to 0.331.

---

## Methodology

`scripts/regime-decomp-ote-long.ts` runs OTE-Long entries through the 2020→present 4h corpus under each gate candidate, computes peak-to-trough DD + per-year breakdown + cross-instrument check.

Candidates tested:
- G1-G8: single-state filters (block negative / allow positive states)
- G3+G7, G2+G7, G4+G7: layered composites (two filters AND-composed)
- Ungated baseline

Plus forex portability check on EUR/USD, GBP/USD, USD/JPY.

---

## XAU/USD — top 4 DD-passing candidates

| Gate | DD | Worst-yr DD | R-kept | mean_R | Description |
|---|---|---|---|---|---|
| **G3** | **6.68%** | 6.68% | 82% | **0.331** | block usd_down OR fast_div_bull |
| G2 | 7.26% | 7.26% | 84% | 0.333 | block usd_down only |
| G7 | 8.09% | 6.71% | 83% | 0.314 | allow discount only |
| G4 | 9.04% | 6.82% | 80% | 0.313 | block compressed |

Combo gates (G3+G7, etc.) dropped DD further (~6.1%) but lost 18% additional R (62% R-kept vs 82% for G3 solo) — too aggressive.

---

## Per-year detail for G3 (the chosen variant)

| Year | n | $ | Win % | Yr-peak DD % |
|---|---|---|---|---|
| 2020 | 16 | -$318 | 25.0 | 4.82 |
| 2021 | 12 | +$2,145 | 33.3 | 1.85 |
| 2022 | 19 | -$2,194 | 21.1 | **6.68** |
| 2023 | 14 | +$683 | 28.6 | 3.35 |
| 2024 | 24 | +$1,694 | 29.2 | 3.72 |
| 2025 | 19 | +$9,571 | **47.4** | 1.84 |
| 2026 | 42 | +$17,448 | **42.9** | 3.05 |

**Critical observations:**
- 5 of 7 years positive; 2 losing years (2020, 2022) bounded under 7% DD
- Recent dominance: 95% of cumulative R from 2024-2026
- 2025-2026 show structural improvement (win % 47%, 43% — well above 6yr avg 34%)
- Worst-year DD 6.68% — well under FTMO rolling DD limits

---

## Cross-instrument check — OTE-Long is GOLD-ONLY

Same gate candidates tested on EUR/USD, GBP/USD, USD/JPY:

| Pair | Ungated R | Best gated R | Verdict |
|---|---|---|---|
| EUR/USD | -$4,035 | -$2,423 (G1) | Negative on every gate |
| GBP/USD | -$2,188 | +$3,983 (G2 only) | Marginal, gate-sensitive |
| USD/JPY | -$16,859 | -$9,030 (G2) | Negative on every gate |

**OTE primitive doesn't generalize.** Confirms PR #261 finding that OTE-Long is a gold-specific signal. This gate is XAU-only relevant.

Implication for S5: if OTE-Long ever gets a forex watchlist row, the gate should be revisited (and forex deployment as an OTE algo is NOT recommended).

---

## Decision rationale (why G3 over G2 / G7 / G4)

1. **Best DD safety margin** — 6.68% leaves 3.32pp of headroom under the 10% cap. G2 (7.26%) has 2.74pp. Both fine, G3 better.
2. **Proven structure** — same gate Dip-Buyer (LIVE) already uses successfully. Operator has experience with this filter shape.
3. **Per-trade R IMPROVES** — gate is filtering out genuinely-bad entries, not just any entries. mean R goes 0.284 → 0.331 (+16%).
4. **G2 vs G3 difference is marginal** — 3 trades and $781 over 6 years. G3's slightly tighter DD outweighs G2's slightly more R-kept.
5. **G7 is regime-fragile** — 2020 worst yr -$4,994 vs G3's -$318. ICT-pure framing has appeal but real-world resilience is worse.

---

## Caveat — OTE-Long edge is regime-dependent

Per-year: 95% of cumulative R comes from 2024-2026. Older years are flat-to-slightly-negative for every gate variant. **This is a deploy caveat that no gate can fix.** If the regime shifts away from "USD-strong-up, gold-rallying-mixed" conditions, the edge may evaporate.

Mitigation already in place:
- Paper-only deployment (no broker risk)
- 6.68% DD gives room to observe live behavior across regime changes
- Cohort report (PR #186) tracks per-week outcomes — will flag regime decay

This is NOT a reason to delay deploy; it's a reason to monitor closely.

---

## Action taken

1. ✅ G3 gate applied via `scripts/apply-ote-long-dd-gate-2026-06-16.ts` (APPLY=1)
2. ✅ DB verified — `Library: Gold OTE-Long 4h` now carries `{mode: "block", states: {dxy: ["usd_down"], mtf: ["fast_div_bull"]}, on_unreadable: "allow"}`
3. ✅ live_trading_enabled remains false (paper-only)
4. Scan cron picks up the gate on its next tick — Will see `market_state_gate` blocks in activity_log when usd_down or fast_div_bull states are present

---

## Files in this PR

- `scripts/regime-decomp-ote-long.ts` — the gate-search infrastructure (extended with per-year + cross-instrument + combo candidates)
- `scripts/apply-ote-long-dd-gate-2026-06-16.ts` — paper-only update script (refuses live targets)
- `scripts/REPORT_OTE_DD_REDUCTION_2026_06_16.md` — this report

---

## Connected memos

- [[project_roadmap_2026_06]] S1.5 priority #5 — DONE
- [[project_discovery_v1_findings]] — V1.2 mining originally identified usd_down + fast_div_bull as negative-for-longs (which this gate exploits)
- [[feedback_dd_validation_gate]] — 10% DD cap rationale
- [[feedback_4_way_pre_deploy_validation]] — geometry grid would normally be 1 of 4 validations; we have the geometry sweep from PR #259's sweep-algo-geometry (OTE-Long marginal +5% lift). This pass is gate selection, not geometry.
- [[feedback_iterate_only_validated_baselines]] — live geometry changes need A/B paper variant; this update is paper-only so the rule doesn't bind.
