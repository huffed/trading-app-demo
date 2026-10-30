---
name: parity-check
description: Run the live-vs-backtest parity replay (`make parity`) and the golden-file comparison (`make backtest`), and report both. Use when asked whether live paper trades match what the backtester would have done, or whether the engine's trades changed.
allowed-tools: Bash(make backtest *) Bash(make parity *) Bash(pnpm exec vitest run tests/golden *)
---

Run, in this order, and report each result verbatim with its exit code:

```bash
make backtest     # golden file: the engine's trades on the pinned slice; MATCH or the added/missing entries
make parity       # live paper positions vs the backtester on the same bars
```

**Today `make parity` is a stub that exits 2:** the replay script (`paper-replay.ts`) is on the audit branch `review/skeptical-audit-2026-10` and is wired here when it lands on `dev` (`docs/DEBT.md` D-02). Say so; do not improvise a parity check from other scripts.

**Reading `make backtest`:** `golden: MATCH` means no trade changed. `DIFFERENT` lists new or missing entries per run; "same entries, different prices/P&L/reasons" means a field changed, and `pnpm exec vitest run tests/golden` gives the per-field diff. A difference is never fixed by regenerating the file; it is explained in the PR or the code is wrong (`docs/DEV_SETUP.md` §14).

Known parity gaps that are not bugs to fix here (they are the audit's and Phase E's): sizing with and without the lot floor, fill price (quote vs bar close), consecutive-loss streak reset, cooldown clock, day key, ATR formula, R-multiple formula (`docs/CODE_QUALITY.md` §3.2, `docs/DEBT.md` D-02).
