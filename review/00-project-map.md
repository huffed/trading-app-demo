# 00 — Project map (Phase 0, read-only)

**Date:** 2026-10-28 · **Branch:** `review/skeptical-audit-2026-10` (off `dev` @ `3ee22e2`, 2026-10-19) · **Reviewer stance:** no edge until proven.

**How to read the tags.** `[V]` = verified by me first-hand (I ran the query / read the lines). `[A]` = read and cited by one of four read-only explorer agents I delegated to, spot-checked but not independently re-read line by line. `(derived)` = my arithmetic from `[V]` inputs. Nothing in this document is a finding yet; findings with severity, reproduction and fix land in `01-audit.md`.

**What was run vs read.** Read: repo at HEAD, git history, ROADMAP/CLAUDE/README/specs, archived May logs. Ran (read-only): `pnpm vitest run` (1,918 tests pass), read-only SQL against the project's Supabase through its MCP connection (no credentials handled by me), `journalctl`/log tails over ssh on the production VPS, and web fetches of ftmo.com. **Not touched:** any broker/trading account, any `.env*` file, any write to the DB or the VPS. See `review/log.md`.

---

## 0. The premise, corrected

The brief describes "an algorithmic gold system that uses an LLM in its decision loop, currently running on a demo account". The repo and the live database say something narrower:

| Brief says | Repo/DB says |
|---|---|
| LLM in the decision loop | **No LLM call is reachable from the production scan today.** The LLM-trader path exists in code and is switched on only by `rules.llm_trader.enabled`; none of the 5 active algorithms has that key `[V SQL]`. The only `llm_decisions` rows are 36 from 2026-06-11 → 06-19 `[V SQL]`. The three algos that had it enabled are `status='archived'` `[V SQL]`. The path was vetoed 2026-06-29 and re-filed as a pre-registered trigger (E2.26) that was evaluated 2026-10-19 and **not met** (ROADMAP:1185) `[V]`. |
| Running on a demo account | **Paper-only since 2026-07-20.** All 5 active rows have `live_trading_enabled=false` `[V SQL]`; the FTMO demo (MetaApi MT5) that was mirrored 2026-06-16 → ~07-17 expired. Paper fills are simulated by the engine (see §2.6). The only broker-mirrored trades ever were 1 order on 2026-06-16 `[V SQL activity_log]`. |
| Prop firm "FTMO or similar" | **FTMO, 2-Step Challenge, Swing account intended** (ROADMAP:91-93, prop_firm block in rules) `[V]`. Account size for the first real challenge is stated as $10K in one place and "re-derive at purchase" in another (§5). |

So the object under audit is: **five deterministic, long-only XAU/USD 4h rules algorithms, paper-trading on a VPS, whose in-sample baseline came from a pinned-data harness, with a dormant LLM path that the roadmap intends to restore later.** The LLM-leakage questions in the brief (Phase 1.3/1.4) apply to that dormant path and its archived May 2026 validation, not to the live trades.

---

## 1. Structure and entry points

### 1.1 Stack and hosting
- Next.js 16 / React 19 / TypeScript 5, pnpm; Supabase (Postgres + RLS; service-role admin client for crons); Vitest.
- **Production host:** Hetzner VPS `quanttrader-prod`, systemd service + crontab (UTC), since 2026-08-27 (scripts/README.md:349-373) `[V ssh]`. CLAUDE.md still describes the Mac cron stack `[V]`.
- **Crons on the VPS** (crontab read 2026-10-19 `[V]`): scan `*/15`, manage `*/5`, heartbeat `*/5`, oanda-positioning `*/20`, prune daily, cohort-report weekly, alpha-decay 6-hourly, broker-health 6-hourly, reconcile `*/30`, m1-band-check daily 21:30. **Not installed:** quarterly-research-cycle, walk-forward-opt, validate-algo-monthly (README lists them) `[V]`.
- **Monitoring:** GitHub Actions `dead-man.yml` every 30 min (3 Supabase RPC freshness checks + broker-API probe + ntfy push). It paged correctly through the 2026-10-13 → 19 egress lockout; nobody acted on the pages for 6 days (ROADMAP E2.34) `[V]`.
- **CI:** none. The only workflows are `dead-man.yml` and a stale one-shot reminder; **no tests, lint or build run on push or PR** `[V]`. Since 2026-06-19: 5 PR merges vs 108 commits pushed straight to `dev` `[V git]`.

### 1.2 Backtesters (which one is trusted)
| Engine / script | Role | Data | Fills | Notes |
|---|---|---|---|---|
| `src/lib/market-data/portfolio-backtest.ts` `runPortfolioBacktest` | The engine everything else calls | whatever the caller passes | entry at signal bar **close** + slippage (`:987`); exits via `pickBacktestExitPrice` | 6 "fidelity gates" default **off** (`:1195-1205`) `[A]` |
| `src/lib/market-data/prop-firm-backtest.ts` | shared primitives | — | `pickBacktestExitPrice` (`:467-538`): gap-open through stop → fill at **open**; intrabar stop → fill at **stop level**; TP at **level**; **stop wins ties** | slippage 0.5 bps per fill, spread 0.4 bps per side ×2, lots **rounded down to 0.01, 0 → skip** (`:436-445`) `[V]` |
| `scripts/canonical/lib/pinned-eval.ts` | sha-verified pinned loaders, `stressTest`, `mcChallenge`, `runUntilTarget` | pinned JSON | — | **`POOL_CAPITAL = 10_000`** (`:20`) `[V]`; 60-day windows stepped 7 days |
| `scripts/canonical/e2.22-layer-b-pinned.ts` | **the de-facto "Deploy methodology v4" harness** and the source of the G.8/M1 baseline (`MODE=algo-stats`) | pinned H4 + session dailies; **rules read live from the DB at run time** | as engine | sibling-aware; risk-pool 4%; portfolio-halt 5%; spread **proxy**; no news events; no `time_filter` (`:500-501`) `[A]` |
| `scripts/canonical/validate-algo.ts` | the script CLAUDE.md calls the **only trusted** verdict path | pinned only | as engine; all gates on | **default set = `Library:%` + `Gold Swing 4h` — the five `Deploy:` rows are not in it** (`:811-815`) `[V]` |
| `scripts/canonical/algo-search.ts`, `algo-search-2026-10.ts` | Layer A/B enumerators + the never-run October round driver | pinned | — | `layer-a` refuses without `PINS_REFRESHED=1` `[A]` |
| Dashboard backtest/validate/inspect callers (6+) | diagnostics | **live `price_cache`** (now capped at 2,000 bars ≈ 1.3 yr) | gates off | documented as untrusted (CLAUDE.md) `[A]` |
| `src/lib/market-data/backtest-engine.ts` | legacy single-ticker engine | — | — | **no callers** (dead code) `[A]` |

**Key parity facts for Phase 1** (all `[V]` unless noted): backtest enters at the signal bar's close; live enters at a **Twelve Data `/price` quote** taken at the first 15-min scan after bar close (or hours later, §2.5), with **no spread/slippage** (`entry-deterministic-gates.ts:72`, `markets.ts pnlInUsd`). Backtest exits use bar high/low with stop-wins-ties and level fills; live exits compare a **single polled quote every 5 min** to SL/TP and record **that quote** as the fill (`exit-trigger.ts:54-72`, `engine-position-mgmt.ts:149`). Backtest sizes on compounding equity with a 0.01-lot floor; paper sizes on fixed `algorithms.capital` ($100k) with no lot floor (`helpers.ts:100-131`) `[A]`.

### 1.3 Demo/live runner
- Scan: `api/cron/scan-active-algorithms` → `scan/engine.ts` → `engine-process-ticker.ts` → `entry.ts` → deterministic gate ladder (`entry-deterministic-gates.ts`) → `entry-conviction.ts` (conditions) → `entry-open.ts`. Portfolio-level DLL halt runs first in the route. Scope: `status='active'` rows of `OPERATOR_USER_ID`.
- Manage: `api/cron/manage-positions` → `scan/manage.ts` → `engine-position-mgmt.ts` (stagnant check **first**, then SL, then TP, on the polled quote).
- Broker layer: MetaApi MT5 primary (`lib/brokers/metaapi*`), cTrader dormant. Broker context is `null` whenever `live_trading_enabled=false`, which also disables the spread gate, the risk-pool halt and the 30× notional sanity gate in paper mode `[A]`.
- Live quotes: Twelve Data `/price` (`fetchBatchQuotes`), falling back silently to the last completed 4h close `[V]`. Bars: OANDA practice (mid, NY-17:00 session alignment, `complete` candles only) → Twelve Data → Yahoo → Alpha Vantage.

### 1.4 LLM modules (dormant)
- `src/lib/scan/llm-trader*.ts`, prompts v1–v5_15m + v2_generic/v2_mtf; Anthropic `claude-haiku-4-5-20251001` (dated snapshot = pinned) with **no temperature set** (API default) and no response caching (`llm-trader-providers.ts:54-71`) `[V]`; Groq `llama-3.3-70b-versatile` (alias, not pinned) as fallback/sentiment `[A]`.
- Two reachable LLM branches exist in the scan code: `rules.llm_trader.enabled` and any `sentiment` entry condition (Groq). **Neither is configured on any active row** `[V SQL]`.
- `LLM_MONTHLY_BUDGET_USD` exists **only in the archived harness** (`scripts/archive/2026-06-18/llm-trader-backtest.ts`); the live path has no spend cap `[A]`, contrary to CLAUDE.md/ROADMAP.
- The code **honours** LLM `exit` and `move_be` decisions (`entry-llm-trader.ts:124-129` → `executeLlmExit`) `[V]`, despite the documented "engine owns exits" doctrine (CLAUDE.md:11,185).
- Archived validation harness: `scripts/archive/2026-06-18/` (372 files incl. May 2026 walk-forward logs and trade JSONLs).

### 1.5 Data pipeline, timeframes, timezones
- Live bars: `prices.ts` provider chain; `price-cache.ts` with DQ.1–DQ.4 write guards; since 2026-10-19 rows capped at 2,000 bars with an in-process copy (E2.34) `[V]`.
- Pinned corpora (`scripts/canonical/data/`, 18 files): OANDA practice, mid, from 2015-01-01, sha256 embedded in each manifest and re-hashed on load. Gold: H4 17,810 bars to **2026-07-09**, D 2,993 to 2026-07-07, H1/M30 to 2026-07-17; forex D/H4/H1/M30 to 2026-07-29 `[V]`. **Gold pins have not been refreshed since July**, so no pinned data covers the live period.
- Tick corpus (Dukascopy, 6 months × 4 instruments, ~79M ticks, gitignored, sha manifest committed) powers a per-hour spread model (E2.33) `[A]`.
- Timeframes in play: 4h primary (all 5 algos), D1 for daily bias/regime/ADX; 30m/1h searched and closed (E2.23).
- **Timezones:** bar dates are UTC ISO; OANDA sessions align to 17:00 New York (4h bars open 01/05/09/13/17/21 UTC in summer). **Every daily-loss day boundary in code is UTC midnight** (`daily-halt.ts:50-51`, `portfolio-halt.ts` via `date.ts:77-82`, backtest `dayKey`) while FTMO resets at **00:00 CE(S)T** (§4). Two code comments contradict each other on this (`daily-halt.ts:13-14` vs `date.ts:73-75`) `[A]`.
- **Daily-bias alignment (the July look-ahead fix site):** live uses `alignCompletedDailyIndex` (strictly-prior UTC date prefix) on start-stamped OANDA D1 with the forming candle dropped → no look-ahead live `[V]`. The backtest re-stamps session dailies to their close instant and intends `alignBarIndex` via `higherTfCloseStamped`, **but `condition-evaluator.ts:134-141` drops that flag**, so the backtest also runs the date-prefix rule on close-stamped bars → the backtest's daily bias is **one session staler than live on 2 of every 6 bars** `[V]`. Not a leak; a parity gap in the opposite direction, and the "exact live parity" claim (ROADMAP:821,880) is false.

### 1.6 Frontend
10 nav pages (dashboard, trades, journal, algorithms, chart, backtest, performance, reports, analytics, settings). Reports has tabs activity / **M1 evidence** / eligibility / cohort / drift / brokers / search. Algorithm detail, validate and `/backtest` pages run **on-demand backtests from the live cache with gates off** `[A]`. Journal/trades/stocks are dormant by design. Single operator; one other account exists with 0 algorithms.

### 1.7 Tests
Vitest, `src/**/*.test.ts` only (scripts/ excluded): 133 files, **1,918 tests, all passing** `[V run]`. Broker layer coverage: one sizing test file `[A]`. No parity/replay test between backtest and live engines exists `[A]`.

---

## 2. The current strategy, precisely

Source of truth: the 5 live `algorithms.rules` JSON pulled 2026-10-28 `[V SQL]`; detector code per `[A]` (explorer B) with the daily-bias alignment re-read by me.

### 2.1 Spec (what a re-implementation must reproduce)
```
Every 15-min scan, each algo independently; inputs: completed OANDA H4 mid bars, completed OANDA D1 mid bars (NY 17:00 sessions, start-stamped).
  i  = last completed H4 bar
  s  = last D1 bar whose UTC date prefix < UTC date prefix of bars[i].date
  signal = pattern(bars, i) bullish  AND  D1.close[s] > SMA20(D1.close[s-19..s])
  gates (§2.4) pass  →  q = Twelve Data /price quote (fallback bars[i].close)
  L   = min(low[i-lb .. i])  (lb+1 bars incl. signal bar)
  SLd = (q − L) + 0.1 × WilderATR14_4h[i]     (q ≤ L → distance 0 → silent skip)
  SL  = q − SLd ;  TP = q + max(rr × SLd, SLd)
  units(oz) = capital × 0.42% / SLd     (capital = algorithms.capital = 100,000, fixed; no lot rounding)
Manage every 5 min (and each scan) with quote q':
  stagnant exit first: bars_open ≥ clamp(round(SLd/ATR14), 6, 48) AND MFE < 0.1R AND last close ≤ −0.5R
  else exit at q' if q' ≤ SL or q' ≥ TP   (recorded fill = q', no costs)
Long only. One position per algo. No signal exits, no trailing, no break-even. Weekend holds allowed; no Friday flatten.
```

### 2.2 Per-algo table `[V SQL]`
| Algo (DB name) | Pattern | RR | SL lookback | Extra filter | Deployed | Risk |
|---|---|---|---|---|---|---|
| ARB+DailyBias 4h \| r085 v1 | `asian_range_break` | 3.0 | 3 | regime_filter (D1 ATR20, 90d, floor 0.3) | 2026-06-29 | 0.42% |
| Engulfing+DailyBias 4h \| r080 v1 | `engulfing` | 3.0 | 6 | adx_filter (D1 ADX14 ≥ 20) | 2026-06-29 | 0.42% |
| ARB25+DailyBias 4h \| r080 v1 | `asian_range_break` | 2.5 | 3 | regime_filter | 2026-06-29 | 0.42% |
| OutsideBar+DailyBias 4h \| rr3_lb3 r066 v2 | `outside_bar` | 3.0 | 3 | — | 2026-07-10 (v2 = manual DB edit lb4→lb3, no script) | 0.42% |
| Engulfing25+DailyBias 4h \| r042 v1 | `engulfing` | 2.5 | 4 | — | 2026-07-20 | 0.42% |

Common to all five: `side: long`, `entry_logic: all`, `daily_bias {ma_period 20, 1d, bullish}`, `stop_loss {swing_anchor, value 0.1, lookback}`, `take_profit {rr_multiple}`, `position_sizing {risk_per_trade 0.42}`, `max_positions 1`, `stagnant_exit {enabled}`, `news_veto {high, 15 before / 30 after}`, `time_filter {enabled, min_wr_pct 45, min_samples 5}`, `prop_firm {DLL 5, max DD 10, target 10, slippage 0.5 bps, spread 0.4 bps, commission 0, daily_loss_halt_pct 80, combined_risk_cap 4, consecutive_loss_daily_halt 2, consistency 0}`, `leverage 50`, `capital 100000`, `portfolio_id` set, `broker_connection_id` set (mirroring off). The r085/r080/r066 name suffixes are **stale** risk tags (all now 0.42). "ARB" = Asian Range Break (not "outside-bar reclaim" as `preregistration.json:3` says).

### 2.3 Detectors `[A]`
- **Engulfing** (`patterns/engulfing.ts:39-69`): prev bearish, cur bullish, `cur.open ≤ prev.close && cur.close ≥ prev.open`; bodies only, inclusive, no size filter.
- **Outside bar** (`patterns/outside-bar.ts:44-49`): `cur.high > prev.high && cur.low < prev.low && cur.close > cur.open`.
- **Asian range break** (`patterns/asian-range-break.ts:44-100`): signal bar opens at UTC hour ≥ 7; range = H/L of earlier bars on the same UTC date that opened before 07:00; bullish when `close > rangeHigh`; fires on every qualifying bar that day. Because OANDA 4h bars open at 01/05/09/… UTC (summer), the effective "Asian" range is 01:00–09:00 UTC, not the documented 00:00–07:00.
- **Daily bias** (`patterns/daily-bias.ts:21-48`): last aligned D1 close vs SMA20 of the last 20 aligned closes (the tested bar is inside its own average); needs ≥ 20 bars; equality = not detected.

### 2.4 Gates, in ladder order, and whether the baseline harness models them `[A]`, cross-checked with the rules `[V]`
| # | Gate | Live rule | Active on the five? | In the G.8 baseline harness? |
|---|---|---|---|---|
| — | Portfolio DLL halt (route) | 5% of portfolio capital, UTC day, realized + unrealized | yes (`portfolio_id` set) | simulated (realized only) |
| — | Pair auto-pause | ≥ 8 closed trades and WR ≤ 30% → ticker paused until manual un-pause (`pair-quality.ts:24-27`) `[V]` | yes | **no** |
| — | Per-algo DLL halt | −5% × 80% of capital, UTC day | yes (unreachable at 0.42%) | yes |
| 0a/0b | Bar granularity / staleness | spacing in [0.75×, 1.5×] TF; stale after 1.5 × TF from bar close (6h for 4h) | yes | live only |
| 1 | Intraday ATR liquidity | ATR14 < 20th pct of last ~200 → block | yes | yes |
| 2 | News veto (Finnhub) | USD high-impact, −15/+30 min wall clock; **fails open** on API error/missing key | yes | **no** |
| 3 | Consecutive-loss halt | 2 losses ≥ 0.25R since UTC midnight → no new entries today | yes | yes (streak never resets at midnight) |
| 3b | Re-entry cooldown | 240 min after a losing exit | yes | multi-algo runs only |
| 3c | session_filter | — | **not set** | — |
| 4 | **time_filter** | wall-clock UTC hour blocked once ≥ 5 of this algo's own closed trades fall in it with WR < 45% (`time-of-day-filter.ts`, `per-hour-stats.ts`) `[V]` | yes | **no** |
| 5/6/9 | Consistency / market-state / DXY | — | not configured | — |
| 7–8 | Side + direction conflict | long only; blocks if a sibling holds a gold short | inactive (all long) | yes |
| 10 | Regime filter | D1 ATR20 pct < 0.3 → block | ARB, ARB25 | yes |
| 11 | ADX filter | D1 ADX14 < 20 → block | Engulfing r080 | yes |
| — | Spread gate (bid/ask) | needs broker context | **not run in paper** | **ATR-ratio proxy** |
| — | Risk-pool halt 4% | needs broker context | **not run in paper** | **simulated** |

Two **live-only, self-modifying** mechanisms stand out for Phase 1/2: the `time_filter` ratchets (an hour blocked at < 45% WR can never accrue the trades that would un-block it; the strategy's own baseline WR is 35.6%, so most informative hours will eventually fall below 45%), and the pair auto-pause has, for a strategy whose true WR is 35.6%, a **~41% chance of pausing a correctly-working algo at its 8th trade** (derived: Binomial(8, 0.356) ≤ 2 wins). Neither exists in the backtest.

### 2.5 Timing: when a signal is acted on
There is **no act-once-per-bar-close throttle on the deterministic path** (it exists only on the LLM path). The last completed 4h bar is re-evaluated by every 15-minute scan until the next bar closes; if any gate blocks the first scan, the entry can fire hours later at whatever the quote is then. The staleness gate only blocks after 6h `[A]`. **Observed live `[V SQL]`:** 11 of 14 entries fired within a minute of a 4h close; 3 fired off-grid (08-10 15:00, 08-14 08:00, 08-19 08:30), and all three off-grid entries are the three winners (n=3 — noted, not interpreted).

### 2.6 What the paper fill actually is `[V]`
Entry and exit prices are Twelve Data `/price` quotes (a different feed from the OANDA bars), no spread, no slippage, no commission; the exit fill is the first 5-minute poll at or beyond the level. Observed on the 14 trades: stops filled on average **$9.19 past the stop level** (11 stops; range $0.87–$49.19), take-profits **$5.65 past the TP level** (3). The baseline harness fills stops at the level with 0.5 bps slippage. ROADMAP:891 and `preregistration.json:58` describe paper fills as "bar close ± modelled friction"; that is not what the code does.

### 2.7 The LLM contract (dormant) `[A]`
The model is shown the bar timestamp, absolute price levels (daily close, 20-day SMA, 14-day range, last 3 4h bars with times and OHLC), DXY proxy, intermarket ratios, open-position details, and a recent-results summary; it returns `enter_long | enter_short | hold | exit | move_be`. Dates and absolute levels in the prompt are exactly the leakage vector Phase 1.3(b) names. The archived harness filters daily bars by `d.date <= bar.date` against stored start-stamped dailies, i.e. the same shape as the July look-ahead; it also has no friction model `[A]`. Those two points decide whether the May 2026 numbers (§3.1) mean anything.

---

## 3. Change history since the "spring report"

### 3.1 What the spring report actually is `[A, spot-checked V]`
**There is no single spring 2026 backtest report in the repo.** `git log --diff-filter=A -- '*.md'` shows the spring-dated markdown is two April plans plus five June-16 reports (now in `scripts/archive/2026-06-18/`), none of which contain the three claims. The closest match to all three is the **LLM-trader walk-forward validation of 2026-05-01/02**, recorded as commit messages (`2bea3f3`, `8048bc4`, `a119ac9`, `97e3e97`, `a4ada4f`, `0a75744`) plus archived run logs and trade JSONLs:

| Claim in the brief | What the archive shows | Status |
|---|---|---|
| In-sample vs held-out collapse | v2 prompt, 6×40-day windows ending 2026-04-30: 25 trades, +$19,592, pooled mean R **+1.045**. Held-out, 6×40-day windows ending 2025-10-11: 14 trades, +$926, mean R **+0.088**. v1 held-out: 11 trades, mean R −0.485. Caveats: held-out window 6 overlaps in-sample window 1; the in-sample window is the prompt-design window; 31–41% of LLM calls failed and failed calls skip the bar; a 2026-05-15 re-run of the in-sample window gave $10.0–13.3K, so the +$19.6K did not reproduce. | **Not fixed.** The path went live anyway (May), was archived (06-18), vetoed (06-29), and is slated for restore-as-is under E2.26. |
| Very high share of winners at full TP | 79–91% of in-sample winners exit at exactly +3.0R; 40% on held-out (others are window-end force-closes). In the deterministic engine it is 100% by construction (no signal exits, no trailing). | Mechanical, not a bug. Nobody measured TP share before/after the July look-ahead fixes. |
| LLM exit ran a different code path in prod vs backtest | In production the LLM "exit" was a TODO that logged and returned; the backtest closed at `bar.close` (`0a75744`, PR #110, 2026-05-02). Fix: `entry-llm-position-actions.ts:129-187` + 5 tests. Five weeks later PR #178 concluded honouring LLM exits costs ~24% of R, which became the "engine owns exits" doctrine, **but the code still honours them** `[V]` and the 24% figure is a sensitivity band on labels that also cover stagnant cuts and force-closes. | Divergence fixed; doctrine unenforced. No replay/parity test. |

A second, deterministic instance of claim 1: the STEP 6 OOS holdback of 2026-06-18 (`1fd0c60`) returned 1 PASS / 6 FAIL (e.g. −148%, −171% held-out vs in-sample), after which the OOS cutoff was **swept over {3,6,9,12,18} months and set to the one that maximised passers**; the code labels this "Data-snooped" (`validate-algo.ts:421`) `[A]`.

### 3.2 Since then (2026-05-02 → 2026-10-19) `[A git]`
333 non-merge commits, 149 PRs; since 2026-06-18 only 5 PRs vs 133 commits. ~46 result-affecting engine/harness fixes, of which the ones that made earlier backtests **optimistic** include: trailing-stop units bug (06-16), end-of-corpus daily bias (06-17), halted walk-forward hiding drawdown (06-17), FVG/sweep/auto-side look-aheads (06-18), seven live gates added to the backtest (06-18, e.g. 122 → 54 trades), i.i.d. → block bootstrap (06-18), augmented DD stored 100× too small (06-29), composer DD proxy 9.66% vs real 28.98% (06-29), **daily_bias current-day leak E2.24.a (07-15, ~44% of 4h return and all intraday passers vanished)**, gap-through-stop fill (07-17), floating ML / de-compounding (07-17, ML 9.03 → 10.08%, return roughly halved), prereg baseline 0.55 → 0.48%/mo (07-20). The deployed portfolio's **expected return has been revised down at every fidelity step**: 1.6–1.7 → 0.96 → 0.55 → 0.48%/mo.

Strategy/rules changes to the deployed algos: risk 0.85 → 0.80 → 0.66 → 0.58 → 0.42%; OutsideBar lb4 → lb3 (manual DB edit, 2026-07-17); Engulfing25 added (07-20); news_veto/time_filter "activated" on ARB rows after deploy with no script (ROADMAP:1253).

### 3.3 Variants tried — the N for Phase 2 `[A]`, DB proxy `[V]`
| Source | Count |
|---|---|
| Documented lower bound of distinct gold configurations evaluated on the same corpus since 2026-04 | **≈ 2,000** (1,930–2,200) |
| Plausible total incl. undocumented random searches and April runs | **≈ 3,300** (3,000–4,000) |
| Repo's own ledger (`algo-search-2026-10.ts:103-120`) | 3,276 (omits June DB-persisted searches; includes the 1,696 cells that never ran) |
| DB rows persisted by the June enumerations | 1,024 `draft` + 30 `archived` + 5 `active` `[V SQL]` |
| Effective independent trials (near-collinear families) | ~100–300 (agent estimate; Phase 2.4 will formalise) |
| OOS/holdout definition changes 2026-06-18 → 07-29 | ≥ 10, and **zero holdout** for the E2.20–E2.24.d selection that produced the live portfolio (ROADMAP:969) |

---

## 4. Target prop firm — rules verified online vs code

Verified 2026-10-28 from ftmo.com/en/trading-objectives and FAQ pages `[V web]` (third-party blogs conflict with each other and were not used):

| Rule | FTMO 2-Step (official) | Code / docs | Match? |
|---|---|---|---|
| Profit target | 10% (Challenge), 5% (Verification) of initial capital | `prop_firm.profit_target 10`; Phase 2 +5% in harness | yes |
| Maximum Daily Loss | **5% of initial capital; limit = balance at 00:00 CE(S)T minus 5%; breach tested on equity** (balance + open P/L ± swaps − commissions) | 5%, but **UTC midnight** boundary everywhere; denominator is fixed `capital`, not the day-start balance; halt at 80% of the limit | **boundary off by 1–2h; reference differs** |
| Maximum Loss | 10% of initial capital, **static** (equity ≥ 90% of initial) | 10% fixed floor in stress/backtest; **no live max-loss halt** (UI gauge only) `[A]` | definition yes; live enforcement missing |
| Minimum trading days | 4 (a day with ≥ 1 position opened, CE(S)T) | console note only; not simulated | n/a for sim; trivially met |
| Time limit | none stated for Challenge/Verification | "no time limit" assumed; stress test still uses 60-day windows | — |
| Consistency rule | **none on the 2-Step** (only 1-Step / Instant: Best Day ≤ 50% / 30%) | `consistency_rule 0` on the five (preset constant 40 exists; CLAUDE.md calls it "FTMO challenge: 40%") | code OK; docs wrong |
| News trading | restricted **only on funded Standard accounts** (2 min before/after listed events); **not during Challenge/Verification; Swing exempt** | self-imposed entry-only veto, USD high-impact, −15/+30 min, fails open | stricter than needed during evaluation; unmodelled in baseline |
| Weekend/overnight | free in Challenge/Verification and on Swing; funded Standard must close before >2h market breaks | no Friday logic; Swing intended | consistent **if Swing** |
| Automation | EAs allowed; "maximum capital allocation" rule applies; 200 open orders / 2,000 positions per day platform limits | — | fine |
| Leverage (metals) | not on the pages fetched; third-party sources give 1:9–1:20 for Swing metals | code assumes 1:50 (`rules.leverage`, `markets.ts:270`), 30 clamp in backtest; ROADMAP says Swing gold 1:9; docs/gold-ws says 1:15 | **unverified; four different numbers in repo**. Immaterial at 0.42% risk (≈ 0.5× notional) |
| Capital allocation cap | $400K per trader (third-party, consistent) | scaling plan assumes up to $400K | consistent |

Account size: ROADMAP:58 says the first real challenge is **$10K**; ROADMAP:332/1183 say "re-derive with run-until-target P(pass)". The paper portfolio runs at $100K; the baseline harness at a **$10K pool** (§1.2) — see §7.

---

## 5. Roadmap, current stage, gates

- **Structure:** Phases F (overfit stats, done) → G (safety net + demo; G.7 demo **current**) → H (methodology, mostly built) → I (optional). E2.x is a punch list of research/ops items; Stage 5.3 = the real FTMO challenge. The roadmap calls itself a "single linear sequence" but G.7 runs alongside E2 research and the branching rules are "superseded in practice" (ROADMAP:51) `[A]`.
- **Current stage (roadmap's words):** Phase G.7 demo, paper-only, accruing M1/G.8 evidence; "the demo IS the work" (ROADMAP:1164-1166). CLAUDE.md's "where we are" is dated 2026-07-17 and stale (4 algos, 0.58%, "preregistration.json currently {}").
- **MILESTONE M1 (ROADMAP:19-26) `[V]`:** (1) 30 portfolio trades; (2) **G.8 PASS = live mean R per trade within ±30% of baseline 0.2551 → band [0.1786, 0.3317]** (`m1-baseline.ts`, `g8-baseline.json`, n=843 in-sample); (3) zero unexplained live-vs-backtest divergences. FAIL → "retire/recompose (Phase H or E2.26)"; E2.26 itself requires an in-band demo, so on a low FAIL it is unreachable `[A]`. No high-side action is defined.
- **Statistical power of the M1 gate (derived from `g8-baseline.json` `[V]`):** per-algo `sharpe_r = mean(R)/sd(R)` implies **sd(R) ≈ 1.36–1.60R**. At n=30, SE ≈ 0.25–0.29R against a band half-width of 0.0765R. **If the strategy performed exactly as backtested, the probability of landing inside the band is ≈ 21–24%**; ≈ 39% false-FAIL low, ≈ 39% false-FAIL high. To show mean R > 0 at 95% one-sided with 80% power needs ≈ 210 trades (≈ 3 years at the backtest's 6 trades/month; longer at the live 4.2/month). Phase 2.3 will formalise this; it already says the roadmap's central gate cannot do what it is for.
- **The "October stage" (all dated 2026-10) `[V]`:**
  | Item | Gate type | Status |
  |---|---|---|
  | E2.26 LLM un-veto trigger | calendar floor (≥ 3 months) **+ metric** (≥ 15 trades inside an "interim band" that is **defined nowhere**) + operator budget ack | evaluated 2026-10-19: **not met** (n=14, mean R below band) |
  | E2.30/E2.31/E2.32 gold-max + forex round (1,696 cells, spec locked 2026-07-29) | **calendar** (2026-10-01) + data precondition (pins refreshed) ; acceptance metrics defined; deployment M1-gated | **never ran**; the quarterly cron was never installed |
  | H.5 quarterly cycle | calendar only | never installed |
  | Search-freeze lift | metric (G.8) or calendar + new data | neither |
  | M1 itself | metric (30 trades); dates (~2026-12 / ~2027-01, stated inconsistently) are cadence estimates | 14/30, last trade 2026-09-04 |
- **Stage 5.3 prerequisites:** G.8 PASS; Swing account re-verification; challenge size re-derived via run-until-target P(pass); ≥ 10 real-fill trades on a live account; alpha-decay Sharpe baselines (done); always-on host + 1 month soak (done); MC P-rule sizing (~0.28%) as the real-challenge input. The MC "months to target" multiplies calendar days by 7/5 as if they were trading days (`pinned-eval.ts:258-290, 355`) `[V]` → the "~20 months median" is ≈ 1.4× too high.
- **Pre-registration (`preregistration.json`) `[A]`:** 6 entries (5 per-algo "post-hoc-locked"/"forward-pre-registered" 2026-07-17/20, 1 portfolio entry registered 2026-07-20T00:00). All lock `min_win_rate 37` while 4 of 5 algos (31.8–34.1%) and the portfolio (35.6%) sit below 37 in-sample. The portfolio entry was edited twice after `registered_at` (commits `53df836` 07-20 12:24 and `3b3423c` 07-21) without bumping the date `[V git]` — before any trade, so it is a hygiene issue, not a results issue. The per-trade baseline 0.2551 is not in the file; the live gate reads hard-coded constants. Nothing in code consumes the portfolio entry.

---

## 6. Demo so far

- **Clock:** evidence clock starts 2026-07-20T00:00Z (paper-only switch + 5th algo). Algos deployed 2026-06-29 (×3), 07-10, 07-20. Broker mirroring (FTMO demo via MetaApi) existed 2026-06-16 → ~07-17 and produced exactly one mirrored order (2026-06-16, Gold Swing 4h short, LLM era) `[V SQL]`.
- **Trades `[V SQL]`:** 14 closed, 0 open, none since **2026-09-04** (54 days of `signal_no_action` on every scan, then the 6-day lockout, then clean scans since 2026-10-19 12:30Z).

| Opened (UTC) | Algo | Exit | Hold | R |
|---|---|---|---|---|
| 08-10 15:00 | OutsideBar | TP | 214h | +3.42 |
| 08-13 13:00 | Engulfing25 | SL | 2.6h | −1.03 |
| 08-13 13:01 | Engulfing r080 | SL | 2.6h | −1.05 |
| 08-14 08:00 | Engulfing25 | TP | 125h | +2.58 |
| 08-18 13:00 | Engulfing r080 | SL | 2.1h | −1.04 |
| 08-19 08:30 | Engulfing r080 | TP | 5.8h | +3.01 |
| 08-21 01:30 | Engulfing25 | SL | 240h | −1.03 |
| 08-21 05:00 | OutsideBar | SL | 184h | −1.14 |
| 08-21 05:00 | Engulfing r080 | SL | 236h | −1.04 |
| 08-31 21:00 | Engulfing25 | SL | 11.4h | −1.09 |
| 08-31 21:00 | Engulfing r080 | SL | 11.4h | −1.09 |
| 09-03 21:00 | ARB25 | SL | 15.6h | −1.10 |
| 09-03 21:00 | ARB | SL | 15.6h | −1.25 |
| 09-04 09:00 | OutsideBar | SL | 3.6h | **−3.27** (stop at 4456.42, filled 4407.23 at the 12:35Z poll; 2026-09-04 was NFP Friday, 12:30Z) |

  Totals: **3 wins / 11 losses (21.4%), net −5.13R, mean −0.366R** (band [0.1786, 0.3317]), **−$2,155 (−2.15% of $100K)**; peak ≈ +$2,472 after 08-19, so ≈ 4.6% drawdown from peak. Two pairs of sibling-identical trades (08-31 Engulfing×2, 09-03 ARB×2) — effective risk per signal 0.84%. Per algo: Engulfing r080 5 trades/1 win, Engulfing25 4/1, OutsideBar 3/1, ARB 1/0, ARB25 1/0.
- **Logging `[A + V]`:** `paper_positions` rows (entry/exit/SL/TP/qty, `initial_stop_loss_price`, `entry_reason` = condition *definitions* + cohort block), `activity_log` (`signal_detected` with per-condition booleans and ATR; `signal_no_action` with gate reason; opens/closes; halts; ticks), `llm_decisions` (LLM path only). **Not logged:** the bars seen at decision time or their provider, the signal bar's date on an opened position, the daily-bias SMA / ATR / swing level behind the SL, quote source/time/bid-ask at fill, slippage, MAE/MFE, a per-position rules snapshot, any persisted M1/G.8 verdict history (the band-check state file lives in `/tmp`). The "fidelity ledger" M1 condition 3 refers to does not exist.
- **Integrity events in the demo window `[V SQL/logs]`:** 297 `scan_overdue` in July and 288 in August (Mac-era outages; 6-day outage Jul 22–28), 0 in September, lockout Oct 13–19 (no inserts possible); 52 "Invalid time value" scan errors Jun 29–Jul 9 (the CHOCH zombie, since fixed); 15 OANDA 520s on Aug 21.
- **Latent live-safety defects found while mapping (to be written up in Phase 1) `[V]`:** the live `paper_positions_exit_reason_check` allows only `stop_loss, take_profit, exit_signal, manual, stagnant_no_excursion, broker_rejected`, while the code writes `stagnant_exit` (`engine-position-mgmt.ts:92-94`), `daily_loss_halt` (`daily-halt.ts:97-101` → `flatten.ts`) and `portfolio_halt` (`portfolio-halt.ts:127`). A stagnant close would fail and, because the stagnant check short-circuits SL/TP, could leave a position unmanageable; a daily-loss or portfolio **halt flatten would fail silently** (unchecked update) while logging a close. No such close has been attempted yet (0 `close update failed` in the VPS journal since 2026-08-27; 0 stagnant/halt exits in the DB), so this is latent, not realised. Three `activity_log` event types the code emits (`dll_warning`, `broker_realized_synced`, `live_order_close_failed`) are also rejected by the CHECK.

---

## 7. Undocumented or contradictory (consolidated)

**Strategy / data (feed into Phase 1)**
1. The baseline harness runs a **$10K pool with a 0.01-lot floor** (`pinned-eval.ts:20`; `prop-firm-backtest.ts:436-445`; `portfolio-backtest.ts:1031-1032`) `[V]`. At 0.42% that is $42 of risk; a stop wider than ~$42/oz sizes to 0 lots and the trade is **skipped**, $21–42 rounds down to 0.01 lot. Gold stop distances in 2025–26 are frequently $50+. Paper sizes off $100K with no floor and takes every signal. Whether the n=843 / 0.2551R baseline is the same trade population as live is therefore unknown until re-run (explorer A's rough bar-level estimate: 57% of 2026 bars have stop distance > $42).
2. Backtest daily bias is one session staler than live on 2/6 bars because `higherTfCloseStamped` is dropped (`condition-evaluator.ts:134-141`) `[V]`; the "exact parity" claims are false.
3. Paper fills: quote-based, no costs, exits at the first poll past the level (observed mean $9 adverse on stops); docs say "bar close ± modelled friction" `[V]`.
4. No bar-close throttle on the deterministic entry path; 3/14 live entries were hours off-grid `[V]`.
5. Live-only `time_filter` (ratcheting) and pair auto-pause (~41% false-pause rate) are absent from the backtest; backtest-only spread proxy and risk-pool cap are absent from paper `[V]`.
6. Day boundary UTC vs FTMO 00:00 CE(S)T; daily loss denominated on fixed capital, not day-start balance `[V]`. No live max-loss halt `[A]`.
7. News veto fails open on API errors; FTMO imposes no news restriction during the evaluation anyway `[V]`.
8. The G.8 statistic is not one statistic: baseline R is net of friction and lot rounding over nominal risk; live R is gross price distance over the initial stop `[A, V for live]`.
9. Live `max_bars` for the stagnant exit is effectively 6 bars (24h) with MFE < 0.1R and ≤ −0.5R; docs quote different constants `[A]`.
10. The ARB "Asian" window is 01–09 UTC in summer, not the documented 00–07 `[A]`.

**Roadmap / governance (feed into Phases 2 and 7)**
11. M1's ±30% band has ≈ 22% power under the null that the strategy works; ±50% vs ±30% stated in different places; M1 date ~2026-12 vs ~2027-01; E2.26's "interim band" undefined; `min_win_rate 37` pre-registered against a 35.6% baseline; prereg edited post-registration without a date bump `[V]`.
12. The deployed set was selected with zero holdout, after ≥ 10 OOS redefinitions and a cutoff chosen to maximise passers `[A]`.
13. The "only trusted" validator never validated the deployed rows; the actual deploy harness is `e2.22-layer-b-pinned.ts` `[V]`.
14. "Engine owns exits" and "`LLM_MONTHLY_BUDGET_USD` is structural" are both untrue of the live code `[V/A]`.
15. The October round never ran; its cron was never installed; the M1 trade window overlaps the round's "fresh OOS" tail `[V/A]`.
16. MC months-to-target double-converts days (×7/5) `[V]`.

**Ops / docs**
17. CLAUDE.md is stale in several load-bearing places (host, portfolio size/risk, prereg contents, latest migration, "Coil-1h + Dip-Buyer are LIVE") `[V]`.
18. No CI on PRs; 108 direct-to-dev commits since June `[V]`.
19. DB CHECK constraints reject exit reasons and event types the code writes (§6) `[V]`.
20. Roadmap lineage footer rule broken since 2026-08-27; E2.23 "READY" vs "CLOSED"; README cron table ≠ installed crontab `[A/V]`.

**External premise**
21. The repo, memory and roadmap contain **no reference** to a US/Iran war or to 2026-02-28 `[V grep]`. The teammate's claim is entirely external; Phase 3 can only test it as "performance before vs after 2026-02-28" plus measurable regime variables, as the brief specifies.

---

## 8. Questions the repo cannot answer (for the operator)

1. **Prop-firm product and size.** Confirm: FTMO **2-Step**, **Swing** account, and the intended first challenge size ($10K per ROADMAP:58, or "re-derive at purchase"). Also confirm whether Swing metals leverage was checked at any point (four different numbers live in the repo; immaterial at current risk, material for any grid/basket idea).
2. **Scope of the LLM audit.** The live loop has no LLM. Phases 1.3, 1.4 and 2.8 (leakage, reproducibility, ablation) can only be run on the dormant path by restoring the archived harness and spending API money (ROADMAP estimates $30–50 for a re-validation). Do you want (a) code-reading-only on the LLM path, or (b) a paid replay, and with what cap?
3. **"Spring report".** No such document exists in the repo; the closest match is the May 1–2 LLM walk-forward (commit messages + archived logs). Was there a report outside the repo (shared doc, email, teammate's notes) I should be matching against? If so, please add it to `review/inputs/`.
4. **Trials outside the repo.** The variant count (§3.3) covers what git and the DB persisted. Were strategies/parameters tried elsewhere (notebooks, spreadsheets, other machines, the Mac-only runs, a teammate's repo)? Any manual SQL/UI rule edits beyond the recorded OutsideBar lb4→lb3 and the ARB news_veto/time_filter activation?
5. **Permissions for Phases 1–2.** To replay and re-run I need to (a) execute repo scripts that themselves load `.env.local` for Supabase/OANDA access (I would not open the file), (b) keep using the read-only Supabase MCP connection and read-only ssh log access on the VPS as I did in Phase 0, and (c) refresh the pinned gold data from OANDA's practice data API (a market-data fetch, not a trading action) so a test window after 2026-07-09 can be locked. Please confirm each, or tell me which to avoid.
6. **Locked test window.** Proposal: lock **2026-07-10 → 2026-10-28 XAU/USD** (the post-pin live period, once refreshed and sha-stamped) as the final untouched window for Phase 6. Alternative: the last 12 months of the existing pins. Which do you prefer, given the first contains the only live-overlap period?
7. **The war claim's source and the teammate's intent.** Is the claim that the *roadmap should pause* (a process decision) or that the *strategy is direction-dependent on a bearish regime* (a testable hypothesis)? Phase 3 will test the second either way.
8. **Twelve Data as the fill feed.** Was it a deliberate choice to fill paper trades on a different feed from the bars (OANDA)? If a Twelve Data credit outage is possible, fills silently fall back to a bar close up to 4h old.

---

## 9. What Phase 0 did not check
- The numerical impact of the $10K-pool lot floor, the daily-bias staleness and the quote-vs-bar fill model (all need re-runs → Phase 1).
- Any statistics module internals (`src/lib/stats/*`), DSR/PBO implementations, bootstrap code (→ Phase 2).
- The archived LLM harness beyond its daily-bar filter and friction (→ Phase 1.3/1.4 if authorised).
- Twelve Data/OANDA/Finnhub quota state and whether `FINNHUB_API_KEY` is set in production (key names only were visible in a VPS env listing earlier in this session, before the audit brief; values never read).
- Broker order path (`metaapi-orders`, reconcile cron) and the `broker_connections` rows beyond provider/capital.
- Frontend component internals, accessibility and performance (→ Phase 5).
- The 38 archived paper positions (pre-July eras) and whether any of the 1,024 draft rows carry persisted verdicts worth mining for Phase 2.4.
