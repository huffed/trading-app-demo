---
name: regime-report
description: Produce the vol-regime distribution and the daily-bias flips from the pinned XAU/USD corpora (`make regime-report`). Use when asked what regime the market is in, how often the bias flipped, or whether a period was low/medium/high volatility. Read-only, pinned data only.
argument-hint: "[h4-bars] [session-days]"
allowed-tools: Bash(make regime-report *)
---

Run:

```bash
make regime-report ARGS="$ARGUMENTS"
```

Defaults when no arguments are given: the last 90 H4 bars and the last 60 session days. The report prints the pinned corpus range and sha prefixes, the vol-regime distribution over the whole pin and over the last N bars (`low_vol` / `medium_vol` / `high_vol` = ATR(14) terciles over 200 bars, the engine's own `src/lib/algorithm/regime-classifier.ts`), the current regime on the last pinned bar, and the daily bias (D1 close vs SMA20, `src/lib/patterns/daily-bias.ts`) with every flip in the window.

Report the table and the flips verbatim. Two cautions to include: the pinned H4 corpus ends on 2026-07-09, so "current" means the last pinned bar, not today; and the regime classifier needs 200 bars of lookback, so the first 200 bars of any slice are unclassified. For the live market the operator looks at the dashboard, not at this report.
