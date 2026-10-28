# Spring 2026 backtest report — reconstructed figures (operator-supplied)

**Provenance.** The original report file is gone. These figures were supplied by the operator on 2026-10-28 (Phase 0 check-in reply), reconstructed from the review done at the time. They are the target for the Phase 1 commit-level reconciliation in `review/01-audit.md`; any mismatch between these and the archived May 2026 run logs / trade JSONLs is flagged there.

| Figure | Reconstructed value |
|---|---|
| In-sample profit factor | 3.64 |
| In-sample mean R | +1.04 over 25 trades |
| Held-out profit factor | 1.15 |
| Held-out mean R | +0.09 over 14 trades |
| Winners at full 3R take-profit | 11 of 14 winners |
| In-sample max drawdown | 1.50% |
| Held-out max drawdown | never reported |

Believed source run (from Phase 0): LLM-trader v2 prompt walk-forward, 6 × 40-day windows ending 2026-04-30 (in-sample) and ending 2025-10-11 (held-out), Haiku 4.5, XAU/USD 4h — commits `2bea3f3`, `8048bc4`, `a119ac9`, `97e3e97`, `a4ada4f`, `0a75744` (2026-05-01/02) and the archived logs/JSONLs under `scripts/archive/2026-06-18/`.
