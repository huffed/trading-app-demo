# review/log.md — commands run and what they showed

Convention: UTC timestamps; `ran` = executed, `read` = inspected only. Branch: `review/skeptical-audit-2026-10` (off `dev`).

## Phase 0 — Discovery (read-only)

- 2026-10-28 — `git checkout -b review/skeptical-audit-2026-10` off `dev` (clean working tree). Created `review/`.
- 2026-10-28 — `git log --oneline --since=2026-10-19` → see 00-project-map.md §3 for the list.
- 2026-10-28 — Supabase read-only SQL (via the project's MCP connection; no credentials read by the reviewer): active algorithms + rules JSON; algorithms status counts (variant-count proxy); paper_positions totals; llm_decisions range; activity_log event-type census. Results summarised in 00-project-map.md §2/§6.
- 2026-10-28 — `grep -rn time_filter src` + read `src/lib/algorithm/time-of-day-filter.ts`, `src/lib/scan/per-hour-stats.ts`, `src/lib/scan/entry-deterministic-gates.ts` (step markers). Showed: `time_filter` is a LIVE-ONLY, data-driven per-hour win-rate filter learned from the algo's own closed `paper_positions` (min 5 samples/hour, blocks hours with WR < 45%); no backtest counterpart found by grep (only `entry-deterministic-gates.ts:211`). All 5 active algos have it enabled.
- 2026-10-28 — `head -12 docs/*.md` → the three `docs/` files are April-2026 proposals (status "planning"/"proposal"), pre-dating the current roadmap; treated as historical.
- 2026-10-28 — `ls scripts/canonical/data` → 18 pinned OHLC files (XAU/EUR/GBP/JPY × D/H4/H1/M30, dated 2026-07-09/17/29) + `ticks/` + `ticks-manifest.json` (2026-09-03). Each pinned JSON embeds a manifest (`source: oanda-practice`, `price: "M"` = mid, `from: 2015-01-01`, `sha256`, `fetched_at`).
- 2026-10-28 — WebSearch ×3 (FTMO rules; blog results conflicting) → WebFetch of ftmo.com/en/trading-objectives/ and the FAQ pages for news, weekend holding, consistency, instruments/strategies. Results in 00-project-map.md §4.
- 2026-10-28 — Delegated four read-only Explore agents (code map; strategy spec + LLM contract; change history + spring report + variant count; roadmap/gates/logging/firm docs). Each returned file:line-cited reports; load-bearing claims re-verified first-hand below.
- 2026-10-28 — SQL: `pg_get_constraintdef` for `paper_positions_exit_reason_check` + `activity_log_event_type_check` → exit CHECK allows {stop_loss,take_profit,exit_signal,manual,stagnant_no_excursion,broker_rejected}; code writes `stagnant_exit` (engine-position-mgmt.ts:92-94), `daily_loss_halt`, `portfolio_halt` (flatten.ts) → latent CHECK violations. VPS `journalctl -u quanttrader | grep -c "close update failed"` → 0 since 2026-08-27 (not yet triggered).
- 2026-10-28 — SQL: 14 M1 trades with open/close timestamps, R, fill-past-level; per-hour WR (time_filter exposure: no hour informative yet, hour 21 at 4 samples/0 wins); per-algo WR.
- 2026-10-28 — Read: pair-quality.ts:24-27 (minTrades 8, wrThreshold 0.3), engine.ts:218-246 (always-on post-close eval); e2.22-layer-b-pinned.ts:549,585 (`sharpe_r` = mean(R)/std(R)); pinned-eval.ts:258-290,355 (calendar-day path × 7/5); entry-llm-trader.ts:118-135 (LLM exit honoured); engine.ts/manage.ts/twelve-data.ts (live quotes = Twelve Data /price); markets.ts:410-425 (gross P&L); condition-evaluator.ts:125-145 + evaluate.ts:245-260 (higherTfCloseStamped dropped); pinned-eval.ts:15-24, prop-firm-backtest.ts:430-460, portfolio-backtest.ts:1015-1035 ($10k pool, 0.01-lot floor, 0 → skip); validate-algo.ts:805-818 (default set excludes Deploy:); llm-trader-providers.ts:54-71 (no temperature); .github/workflows (no CI on PR).
- 2026-10-28 — `git log --first-parent dev --since=2026-06-19` → 108 non-PR commits vs 5 PR merges. `git log -- scripts/canonical/preregistration.json` → edits 07-20 (53df836) and 07-21 (3b3423c) after registered_at 2026-07-20T00:00.
- 2026-10-28 — `grep -rin "iran|\bwar\b"` over ROADMAP/CLAUDE/docs/README/memory → no reference to a US/Iran war or 2026-02-28.
- 2026-10-28 — Derived: sd(R) = mean_r/sharpe_r per algo = 1.36–1.60R → SE at n=30 ≈ 0.25–0.29R vs band half-width 0.0765R → P(in band | true mean = baseline) ≈ 21–24%.
- 2026-10-28 — Wrote `review/00-project-map.md`. Committed on the review branch. CHECK-IN: waiting for operator reply before Phase 1.

## Phase 1 — Correctness audit (2026-10-28)

- Safety fix (operator instruction): branch `fix/exit-reason-check-constraint` → draft PR #291. Migration 00053 widens both CHECKs; runtime `EXIT_REASONS`/`ACTIVITY_EVENT_TYPES`; checked flatten write + `error` activity rows; `db-check-contract.test.ts`. `pnpm vitest run` 1,929 pass; `pnpm build` clean; `pnpm lint` 0 errors. Migration NOT applied. (`drift_warn` found afterwards by the Phase 4 reviewer — added in a follow-up commit.)
- `review/inputs/spring-report-reconstructed.md` created from the operator's figures (the file was not in the repo).
- ran `pnpm dlx tsx review/scripts/refresh-gold-pins.ts` (OANDA practice → `review/data/xau-usd-{h4,d,h1}-pinned-2026-10-28.json`, sha-stamped; canonical pins untouched). H4 645 bars to 2026-10-28T13Z, D 107 to 10-26T21Z, H1 2,468 to 10-28T16Z.
- ran `python3 review/scripts/spring_reconcile.py` → exact match on all operator figures; held-out max DD $4,002 (4.0%); re-run spread PF 3.33–6.25.
- ran `python3 review/scripts/data_quality.py` → all files sha OK, no dups/weekend/bad OHLC; overlap identical; 23 DST phase shifts.
- ran `pnpm dlx tsx review/scripts/baseline-two-ways.ts` → reproduces g8-baseline exactly at $10K (843 / 0.2551); $100K: 862 / 0.3430 / sd 1.774; $1M: 862 / 0.3512; 101 signals skipped at $10K (2025: 49/123, 2026: 31/39); account for <5% skipped: $16.6K all-years, $45.6K since 2025-07.
- ran `pnpm dlx tsx review/scripts/intrabar-h1.ts` (after fixing the date-only exit_date lookup) → 864 price exits, 0 same-bar SL+TP, 0 H1 disagreements.
- ran `pnpm dlx tsx review/scripts/costs.ts` → table in 01-audit §6.
- ran `pnpm dlx tsx review/scripts/param-sensitivity.ts` (background, ~5 min) → `review/results/param-sensitivity.{json,log}`.
- ran `pnpm dlx tsx review/scripts/bias-alignment.ts` → 3.76% bars / 5.26% signals differ; mini-sim live-only +0.209 (n=315).
- ran `pnpm dlx tsx review/scripts/paper-replay.ts` → 10 backtest trades in window; 7/14 matched; fill provenance 0/14 entries, 1/14 exits at a bar close; blocker table; live-filter simulation 872→46; live cache vs OANDA 1,961 common / 0 mismatches / 39 zero-volume Friday bars.
- DB: `signal_no_action` reasons by week since 2026-09-04 (ATR gate dominant from 09-21); activity 2026-08-16 20:00 → 08-17 06:00 (scheduler stall 01:30Z; `scan_overdue` daily 08-10 → 08-27); zero-volume bars in the live 4h row (all Friday 21:00 UTC, non-flat OHLC).
- git: `git log -S fetchBatchQuotes` → PR #16 `c172bff` 2026-04-27 (Twelve Data primary at the time), `487d58a` 2026-04-28 reused for the manage tick.
- web: Haiku 4.5 reliable cutoff Feb 2025 / training data Jul 2025 (platform.claude.com docs); FTMO XAUUSD swap not found on official pages.
- ran `pnpm dlx tsx review/scripts/window-stats.ts` → rolling 110-day trade-count/mean-R distributions for the locked-window pre-registration.
- Wrote `review/01-audit.md`.
