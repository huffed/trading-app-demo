# Phase E2 Sweep Pre-Registration Lock

**Sweep ID:** `phase-e2-2026-06-24`
**Registered at:** 2026-06-24T15:00:00Z
**Status:** ACTIVE — sweep in progress (no candidates promoted yet)

This document is the **immutable pre-registration** for the Phase E2
re-search launched 2026-06-24 after F + F2 + H.4b empirical work
confirmed the v3 survivor fails F2 robustness gates. The binding artifact
is the code state at commit time (referenced below); this markdown is
the operator-readable summary.

Per `[[feedback_no_presupposed_features]]`, this sweep enumerates
features as discoverable axes — no signal feature is hardcoded as a
required base condition. Per `[[feedback_gold_only_demo_stage]]`, the
universe enumerates all 4 instruments but acceptance-packet filtering
restricts deploy candidates to gold-only until ≥1 stable gold demo
player exists.

---

## Universe

| Axis | Cardinality | Detail |
|---|---|---|
| Instruments | 4 | XAU/USD, EUR/USD, GBP/USD, USD/JPY |
| Timeframes | 3 | 30m, 1h, 4h |
| Patterns | 17 | 14 from original spec + 3 added by H.4c (inside_bar, outside_bar, doji) |
| Directions | 2 (per pattern, with exemptions) | long + short for 14 patterns; long-only for ote + doji; 4h-only for asian_range_break |
| **Layer A cells** | **368** | enumerated by `src/lib/algo-search/enumerate.ts:enumerateLayerACandidates()` |
| Layer B variants per cell | 96 | 4 rr × 3 lb × 2 risk × 2 regime_filter × 2 adx_filter (`src/lib/algo-search/layer-b-enumerate.ts`) |

## Data (per H.0 extension)

| Cache | Bars | Span | Earliest |
|---|---|---|---|
| XAU/USD 4h | 19979 | 10.5 years | 2015-12-31 |
| XAU/USD 1h | 39524 | 6.46 years | 2020-01-01 |
| Other instruments | (varies) | (legacy cache; not extended in H.0) | — |

## Methodology lock

| Artifact | Commit hash | Date |
|---|---|---|
| `algo-search.spec.md` v3 (criteria 1-10) | `187aa9a` | 2026-06-23 (H.7 last touch) |
| `criteria.ts` (SEARCH_LAYER_A_CRITERIA + DEFLATED_CRITERIA) | `0850f5e` | 2026-06-24 (F2 + H.4-methodology-revision shipped) |
| `enumerate.ts` (universe definition) | `0850f5e` | 2026-06-24 (H.4c added inside_bar + outside_bar + doji) |
| `layer-b-enumerate.ts` (96-variant grid) | unchanged from G.5 | 2026-06-23 |

Modifying ANY of those files between sweep launch and acceptance packet
constitutes a re-registration — would invalidate post-hoc-locked
discipline.

## Bonferroni denominator

`Layer A cells × statistical tests per cell = 368 × 1 = 368`

`Family alpha 0.05 ÷ 368 = 0.0001359 per-test`

Validators compute this automatically via `enumerateLayerACandidates().length`; do not hardcode.

## OOS cutoff

`2025-06-18` — 12-month held-out per `[[feedback_oos_cutoff_sweet_spot]]`.

## Acceptance criteria (locked from criteria.ts)

### Per-candidate (criteria 1-7; floor)

| # | Criterion | Threshold |
|---|---|---|
| 1 | total_return | > 0 |
| 2 | total_trades | ≥ 30 |
| 3 | max_static_dd_pct | ≤ 10 (FTMO) |
| 4 | max_daily_dd_pct | ≤ 5 (FTMO) |
| 5 | mean_r_ci_lower (95% block bootstrap) | > 0 |
| 6 | min_oos_held_out_trades | ≥ 10 |
| 7 | max_oos_r_delta_pct | ≤ 50 (absolute) |

### Deflated (criteria 8-10; ship-readiness)

| # | Criterion | Threshold |
|---|---|---|
| 8 | DSR (Bailey/López de Prado deflated Sharpe) | ≥ 0.95 |
| 9 | PBO (CSCV probability of backtest overfitting) | < 0.5 |
| 10 | purged k-fold consistency | ≥ 4/5 (= 0.8 pass ratio) |

### Robustness gates (F2; locked in robustness-* driver scripts)

| Sub-gate | Threshold |
|---|---|
| F2.1 multi-cut OOS | ≥3/4 cuts pass per-candidate AND ≥2/4 cuts rank top-3 by Sharpe |
| F2.2 pattern leave-N-out | ≥3 non-survivor patterns also pass at survivor's cell |
| F2.3 bootstrap-bars | survivor in top-3 in ≥6/10 block-bootstrap seeds (block_size=24) |
| F2.4 alt-objective | survivor top-3 under ≥2/3 alternatives (Calmar / trimmed mean R / recovery factor) |
| **Aggregate** | **≥3/4 sub-gates PASS** |

## Post-sweep workflow

1. **E2.4** — Phase F deflation (`revalidate-candidates.ts` → DSR + PBO + k-fold) on each per-candidate-passer (criteria 1-7)
2. **E2.5** — Phase F2 robustness audit (`robustness-aggregate.ts` → 4 sub-gates) on each F-survivor (criteria 8-10)
3. **H.4b proper** (stepwise feature addition; PENDING BUILD) on each F+F2-survivor — augments with top-K features as binary axes; re-deflates against augmented family
4. **G.6 re-stamp** — operator decision, ONLY for candidates that pass un-augmented F+F2 AND/OR stepwise-augmented F+F2

## Scope filter at acceptance packet

Per `[[feedback_gold_only_demo_stage]]`, the sweep enumerates ALL 4 instruments but any forex candidate (EUR/USD, GBP/USD, USD/JPY) that survives F + F2 will be **FILED for future** + NOT proposed for demo deploy until ≥1 stable gold demo player exists (≥30 demo trades + measured live R within in-sample CI).

This is a SCOPE decision, not a signal-feature pre-supposition — gold-only is the operator's risk-management boundary while the demo period validates the pipeline.

## Lineage

| Date | Event | Reference |
|---|---|---|
| 2026-06-24 LATE | Phase E2 spec filed in ROADMAP.md after operator approved 3 items | ROADMAP.md Phase E2 section |
| 2026-06-24 LATE | Pre-reg locked via this markdown + git commit of underlying spec/criteria/enumerate files | commits `187aa9a` + `0850f5e` |
| 2026-06-24 LATE | E2.1 smoke-test confirmed driver picks up extended cache + 368-cell universe + H.4c patterns | `MODE=list pnpm dlx tsx scripts/canonical/algo-search.ts` |
| 2026-06-24 LATE | E2.2 pre-reg lock filed (this document) | this file |
| (pending) | E2.3 sweep launch | `MODE=full pnpm dlx tsx scripts/canonical/algo-search.ts` (~49hr async) |

**End of pre-registration lock.** Modifying this document after sweep launch constitutes a forensic-archive event — copy to `phase-e2-sweep-lock.archive.md` first.
