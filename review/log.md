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
- Wrote `review/locked-window.md` (pre-registration: 2026-07-10 → 2026-10-28; consistency = trade count in [7, 46] AND mean R > 0; window touched once by the Phase 1 parity replay, mechanics only).

## Phase 2 — Statistical validation (2026-10-28)

- ran `pnpm dlx tsx review/scripts/window-stats.ts` → 569 rolling 110-day windows: trade count p5/p50/p95 = 7/22/46; mean R positive in 66%.
- ran `pnpm dlx tsx review/scripts/phase2-stats.ts` → folds (10/12 years positive; 2018 −0.17, 2019 −0.03; 2025 = 39% of P&L), block-bootstrap CIs (mean R [0.180, 0.507], PF [1.29, 1.90], max DD [16%, 53%] on a fixed-$100K cumulative path), power (166 trades for 80% power; band power 25% at n=30; 2,334 trades for the band), deflated Sharpe grid (DSR 0.87–0.995 at σ_SR=0.044; 0.25–0.91 at 0.06; ≈0 at 0.10; observed cross-algo σ_SR 0.069), independence (ρ1=0.52, top-5% months 51% of P&L, max 25 consecutive losses), demo-vs-backtest noise test (P=19%).
- launched `pnpm dlx tsx review/scripts/phase2-propfirm.ts` in the background (3 capitals × 6 risks; results → `review/results/phase2-propfirm.{json,log}`).
- `review/scripts/phase2.sh` = one-command reproduction of every number in 02-validation.md.
- fix branch: `9f72caf` adds `drift_warn` (4th rejected event type, found by the Phase 4 reviewer); tests 800/800 (scan), build + lint clean; pushed to PR #291.
- prop-firm sweep completed (18 rows, ~15 min) → `review/results/phase2-propfirm.{json,log}`; §2.6 of 02-validation.md filled (MC P(ML>x) values ÷100 vs the first run's display; script fixed for future runs).
- Wrote `review/02-validation.md`. CHECK-IN: Phase 2 go/no-go point — waiting for operator reply.

## Housekeeping before Phase 3 (2026-11-17)

- Operator's go-ahead after the Phase 2 check-in received 2026-11-17 (scope: housekeeping, Phase 3, Phase 6 structural candidates, Phase 7, VERDICT; check-in after Phase 3).
- git: `git merge --no-edit origin/dev` into `review/skeptical-audit-2026-10` → `ee5a8a0` (46 commits from dev, no conflicts; dev had not touched `review/`). A concurrent session rebased the branch by mistake and restored it with `git update-ref` to `ee5a8a0` (same tree); verified with `git reflog`.
- read: `docs/DEBT.md` (D-01 to D-41), `docs/CODE_QUALITY.md` §1–§3.1, `docs/DEV_SETUP.md`, `docs/MODERNISATION.md`, `docs/decisions/0001` to `0011` and `docs/decisions/evidence/oanda-finnhub-trace-2026-11-06.md`. Decisions 0012 to 0014 do not exist on `dev` (0013 is "proposed" in CLAUDE.md; 0014 is on open PR #340).
- `review/scripts/phase2.sh`: `pnpm dlx tsx` → `pnpm exec tsx` (the lockfile's tsx; DEBT D-39).
- ran `bash review/scripts/phase2.sh` → baseline two ways and 2.1–2.5/2.7 reproduce every number in `02-validation.md` exactly (n=843/0.2551 at $10K; n=862/0.3430/sd 1.774 at $100K; folds, CIs, power, DSR grid, independence, noise test all identical). `phase2-propfirm.ts` failed to parse: the 2026-10-28 patch left a `//` comment inside a one-line object literal (line 43), so the committed script never ran as committed; the committed JSON carries the pre-patch ×100 MC values (e.g. `mc_p_ml_gt10: 992` = 9.92%). Fixed (block comment) and re-run with `window-stats.ts` (log below).
- Debt the operator assigned to the audit: D-31 and D-32 → Phase 6 parity list; D-01, D-04, D-25, D-26, D-27, D-33, D-36 → VERDICT "before any real account".
- Noted for the audit's PR: CI's "target rules on files added in this PR" job lints every added `*.ts` outside `scripts/archive` and `scripts/ad-hoc` with `eslint.config.strict.mjs`, and lint-staged holds files new in a commit to the same config; the 20 `review/scripts/*.ts` committed on 2026-10-28 predate the hooks and would fail that job at PR time (console output, long functions). The three Phase 3 scripts are strict-clean. To settle with the `make parity`/`make validate` PR after Phase 6.
- prop-firm sweep re-run after the fix (18 rows, ≈15 min) → every row of 02-validation §2.6 reproduces (e.g. $50K/0.42%: 83.2%/8.7 mo, 88.5%/3.8, funded 73.6%, worst 60-day ML 9.03%, MC P(ML>10%) 9.9%; $50K/0.30%: 91.0/14.8, 92.3/5.7, 84.0%, 6.38%, 3.5%); `phase2-propfirm.json` now carries the MC percentages un-scaled. `window-stats.ts` → 569 windows, count p5/p50/p95 = 7/22/46, mean R positive in 66%: unchanged.
- DB (read-only): deployed paper positions since 2026-07-20 → 18 closed, 3 wins, sum −9.87R, −$4,145, 0 open; the four November entries (OB 11-05, Engulfing25 + Engulfing 11-06, OB 11-09) all stopped; the three 11-10 exits filled at 4,018.52 on the same 18:00 manage tick. `signal_no_action` reasons by week from 2026-10-26: ATR gate 1,531/992/1,040, conditions-not-met 918/1,405/1,370, capped 0/29/92, cooldown 0/16/48 (trading resumed in the week of 11-02).

## Phase 3 — Regime analysis (2026-11-17)

- wrote `review/scripts/lib/phase3-lib.ts`, `review/scripts/phase3-regime.ts`, `review/scripts/phase3-stress.ts` (held to `eslint.config.strict.mjs` as new files; prettier applied by the commit hook).
- ran `pnpm exec tsx review/scripts/phase3-regime.ts` (≈5 min; three runs, the last after the strict-lint rewrite, all identical) → `review/results/phase3-regime.json`, `phase3-trades.csv` (5,392 annotated trades). L_on = Phase 2 baseline exactly (862 / 0.343). L_off 1,365 / 0.329 / $224K / DD 20.3%; S_on 653 / −0.103 / −$28K / DD 63%; S_off 1,261 / −0.090; LS_on 1,251 / 0.223 / $130K. Bias runs: 68 of 372 ≥15 sessions (29 bearish = 692 sessions, 39 bullish = 1,081); L_on 1 trade inside bearish runs, 589 / +0.756 inside bullish runs, 272 / −0.546 outside any run; L_off 343 / −0.216 inside bearish runs; S_on 329 / +0.400 inside, 324 / −0.613 outside. Run-age tables: non-monotonic for L_on, negative at every age for S_on, positive at every age for the trades the filter removes. Regime variables: coincident gold return ρ_s 0.58 / ρ 0.65 (sum R 0.85), LOO best 7/12; predictive best |ρ| 0.26 (ATR/price, 42 quarters). 2026 bias runs on the refresh (description only): 03-12→04-07 18 sessions −9.1%, 05-14→07-02 36 −12.1%, 09-06→10-27 38 −9.2%.
- ran `pnpm exec tsx review/scripts/phase3-stress.ts` (≈8 min) → `review/results/phase3-stress.json`: L_on $50K/0.30% funded 84.0% / worst 60-day ML 6.38% / MC P(ML>10%) 3.5%; L_off 97.2% / 8.11% / 6.1%; at $100K/0.42% L_off worst 60-day 11.59% with 3 breaching windows vs L_on 9.23% / 0; S_on funded 12–19%; LS_on breaches in 2018, 2019, 2022.
- Wrote `review/03-regime.md`. CHECK-IN after Phase 3.

## Status for the planner (2026-11-17)

- Wrote `review/status-2026-11-17.md` (commit `9415d6a`). Read-only: git, the database, and PR #291 rebased and checked in a throwaway worktree that was then deleted.

## Operator's answers and the snapshot (2026-11-21)

- **Answers of 2026-11-21 to the six status questions:**
  1. `daily_bias` stays on in the Phase 6 candidate. "Filter off" is pre-registered as the one forward hypothesis, with its acceptance test written now.
  2. The hour filter is switched off by the session under decision 0012, in a later message the operator sends after the window's re-test. It will name the ids, carry a returning clause, expect 5 rows, show the before-values first and write the ledger line. Not in this turn. If a row auto-pauses before the Phase 6 change, the session tells the operator, who authorises clearing `auto_paused` the same way, and the session records it as a parity event.
  3. #291 waits for the verdict, and the fence stays. It is the first engine PR afterwards.
  4. Done by #345 and #350.
  5. Authorised, quoted: "Phase 6 patches are written and tested in a throwaway worktree outside the project and outside /tmp, under /Users/jack.jones/Documents/trading-app/wt/. Run pnpm install --frozen-lockfile in it when you create it, and treat a tool that cannot start as a failure to report, not as a check that was skipped. Only .patch files are committed, under review/patches/, each naming the dev commit it applies to. No branch carrying them is pushed, and the worktree is deleted when the phase ends."
  6. Merge `dev` now (done below).
- **Constraints of 2026-11-21, until the operator says the host window is over:** no database writes; expect a restart, paused algorithms and test rows in reads. The session's guard hook still has the old 10 s timeout, so commands stay short until the operator restarts the session. Files that must outlive three days live outside `/tmp`.
- **FTMO's XAU/USD costs as the operator read them** (symbols page, Metals CFD tab, 2026-11-18 about 15:45 UTC; data to check, not settled):
  - swap long −58.41 and swap short −4.2, in points, contract size 100;
  - spread 0.39 at that moment;
  - commission 0.0014% of volume, per side or round turn not stated;
  - leverage 1:50, and 1:15 on Swing;
  - hours Monday to Friday, 01:05 to 23:50 platform time, shown as GMT+2;
  - the triple-swap day is not on the page; FTMO's swap article says Wednesday for most instruments (unverified).
- **Merged `origin/dev` (`ea75c40`) into the branch:** merge commit `6b834d2`, pushed. It brought #338, #344, #345, #346, #347, #348, #349, #350 and #351. Nothing under `review/` changed.
- **Snapshot.** The database read at 18:48 UTC showed the five deployed rows `active` (`updated_at` 18:45 UTC, which is the scan's own `last_scanned_at` write; this line first called it the re-test's un-pause, corrected 2026-11-25: the window of 21 and 22 November did not run), no other active algorithm, no algorithm or paper position created since 20 November, and no open position. Then:
  - `pnpm exec tsx review/scripts/snapshot-rules.ts` → `review/inputs/deployed-rules-2026-11-21.json`, taken 18:50:53 UTC. It holds the nine rows the review scripts read: the five deployed rows (active) and the four harness-source rows (draft), each with a sha-256 of its rules. The script refuses unless exactly the five deployed rows are active.
  - `review/scripts/lib/harness.ts` reads rules from the snapshot by default (`lib/rules-snapshot.ts`, which re-checks each hash on load); `QT_REVIEW_RULES=live` reads the database instead.
- **typecheck and lint at the merge:** `make typecheck` had the 4 errors the other session measured, all in `review/`. `make lint` had 9 errors, all in `review/`, and 166 warnings (budget 166). Fixed without restructuring:
  - casts through `unknown` (`_debug-cache.ts:9`, `_debug-sunday.ts:7`, `paper-replay.ts:162`);
  - a `Map<string, string>` type (`paper-replay.ts:50`);
  - unused imports removed (`costs.ts`, `intrabar-h1.ts`, `paper-replay.ts`);
  - `const` for two never-reassigned bindings (`costs.ts:45`, `intrabar-h1.ts:48`);
  - typed declarations instead of object-literal assertions (`baseline-two-ways.ts:66-67`, `bias-alignment.ts:59`, `lib/harness.ts` `withDailyBias`).
  
  After the fixes, `make typecheck` exits 0 and `make lint` exits 0 (0 errors, 166 warnings). No line moved in any file a report cites by line, except `lib/harness.ts`, which no report cites by line.
- **Read for the FTMO items** (web search, 2026-11-21; FTMO's trading-update notices, not yet checked against the platform):
  - FTMO's MetaTrader server time follows the US daylight-saving calendar. It was GMT+3 until 3 November 2025 and GMT+2 after it, and moved to GMT+3 on Sunday 8 March 2026; the 2023 and 2024 changes match the US dates too. FTMO's notices: https://ftmo.com/en/blog/trading-updates/trading-update-02-nov-2023/, https://ftmo.com/en/blog/trading-updates/trading-update-6-mar-2025/, https://ftmo.com/en/blog/trading-updates/trading-update-26-oct-2023/.
  - If that holds, 01:05 to 23:50 platform time is 18:05 to 16:50 New York time all year. The nightly break is then 20:50 to 22:05 UTC in US summer time and 21:50 to 23:05 UTC in winter **(inferred)**.
  - Max Daily Loss resets at midnight Prague time, not server time (same notices).
  - FTMO's swap article puts the triple charge on the Wednesday-to-Thursday night: https://ftmo.com/en/blog/what-is-a-swap-and-for-whom-is-it-important/.
- **Leads for the nightly-break list** (read from `review/results/phase3-trades.csv`, not yet analysed):
  - The backtest's 862 deployed-set entries are stamped on the New York-aligned 4h grid: 01, 05, 09, 13, 17 and 21 UTC in US summer time, and 02, 06, 10, 14, 18 and 22 UTC in winter. One slot a day therefore sits at 17:00 New York, which is inside FTMO's break if the platform follows US daylight saving. Which slot it is depends on whether `entry_date` is the signal bar's or the fill bar's timestamp; to be checked in the backtester.
  - Backtest exits carry a date only, so placing an exit inside the break needs intrabar data.
  - Four of the 18 live entries opened at 21:00 UTC. That was 17:00 New York in September **(inferred; the dates are to be checked)**.
- **Re-run from the snapshot** (18:57 to 19:29 UTC, with the Supabase URL pointed at a closed local port, so any database read would have failed):
  - `bash review/scripts/phase2.sh`: exit 0.
  - `pnpm exec tsx review/scripts/phase3-regime.ts`: exit 0.
  - `pnpm exec tsx review/scripts/phase3-stress.ts`: exit 0.
  - Each regenerated file was compared with the committed one, parsed, ignoring `generated_at` and the runtime fields `ms` and `seconds`. All seven are identical: `baseline-two-ways.json`, `phase2-stats.json`, `phase2-propfirm.json`, `window-stats.json`, `phase3-regime.json`, `phase3-stress.json`, and `phase3-trades.csv` as text.
  - The rewritten files were restored to their committed text, because they differed only in formatting and timestamps.
  - No number moved. The runs were not slowed noticeably: load average about 5, and prop-firm rows took 40 to 63 s against 39 to 60 s on 28 October.
- **For the planner.** The three "First" steps are done, and the rules every review number rests on are now a committed file. Not done in this turn: the window re-reads (they wait for the operator's word), the FTMO items, Phase 6A and the `time_filter` statement (it waits for the operator's authorisation). One lead for the FTMO items: if FTMO's platform clock follows US daylight saving, as its notices say, one 4h bar close a day falls at 17:00 New York, inside FTMO's break, so some backtest and live entries could not have been filled there. It is counted properly in the next step.

## 2026-11-25 — status, the hour-filter switch, and the FTMO items started

- Wrote `review/status-2026-11-25.md` (commit `e8bbbc4`): the session's restart, the live paper record, the auto-pause distances, `notify.log`, what is left. No row auto-paused; no trade opened or closed since 10 November.
- **Hour filter switched off (decision 0012), 17:30:00 UTC.** The operator's message of 2026-11-25 authorised it. Before-values read 17:29:53: the five deployed rows `active`, mirroring off, `time_filter` `{"enabled": true, "min_wr_pct": 45, "min_samples": 5}`. One `update … jsonb_set(rules, '{time_filter,enabled}', 'false') … returning`, ids named; expected 5 rows, returned 5; the md5 of every row's rules without `time_filter` is the same before and after. The 17:30 scan ran on all five afterwards and logged no other event type. Ledger row: `docs/decisions/deploys.md`, on this branch only until the audit's next PR.
- **Parity note.** The live rows now differ from the snapshot of 2026-11-21 in this one field (snapshot: `enabled: true`). The review harness keeps reading the snapshot. A trade the filter would have blocked before 17:30 UTC on 25 November could not exist (it blocked no hour), so no result changes.
