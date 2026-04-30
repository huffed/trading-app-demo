# Gold (XAU/USD) trading workstream — plan

Status: **proposal** · Drafted 2026-04-30 · Review before implementation

## Why

The active "Forex testing" algorithm is in a 2-4 week observation window — no new forex feature work until live data converges or diverges from the backtest baseline (58.6% WR, 3.46% max DD). That observation window is wall-clock time, not engineering time. Spinning up a parallel gold workstream uses the engineering bandwidth productively without perturbing the forex algorithm.

Gold has been on the user's mental roadmap for a while. It's already in product scope (commodities) and FTMO improved gold leverage (1:30 → 1:50) on 2026-02-01 — moving toward gold trading, not away. The combinatorial-search engine, walk-forward validator, risk calibrator, and pattern library are already built; pointing them at gold is mostly grid expansion, not new infrastructure.

## Goal

Produce a deployable gold algorithm by:

1. Adding research-backed gold-specific templates to the combinatorial search grid.
2. Letting walk-forward rank candidates against gold's actual price corpus.
3. Calibrating the top survivor's sizing to a monthly return target with FTMO-safe caps.
4. Pushing it to the live scan engine alongside the active forex algorithm.

The user explicitly chose maximum-payoff over minimum-effort: "whatever will maximise the profit stats even if its more work."

## Anti-goals

- **Don't perturb the active forex algorithm.** All gold work is additive — new templates, new patterns, new parameter combos. Existing forex templates and combos stay byte-for-byte identical.
- **Don't pure-clone a public gold strategy.** Public strategies are disproportionately ones that have stopped working (selection bias). Use research as a *seed* for the search grid, not as a destination — let walk-forward adjudicate.
- **Don't lock the search to 15m.** The user's intuition (gold needs fast timeframes / short holds) was *partially* validated — multi-timeframe is the actual standard, and H4/D1 trend-following on gold is the most-quantified edge that exists (50-year backtest of 200d SMA filter beat buy-and-hold $100k → $10M). Locking to 15m would skip that.
- **Don't sprawl a clock-bound primitive into forex.** Adding session-time bounds for gold conflicts with `feedback_data_driven_gates`. Carve-out scope: gold-only, validator warnings outside gold, dual-run validation to prove edge differential.

## Validated research (2026-04-30)

### Verdict on the user's claim

**"Gold moves quickly, so 15m timeframes are probably important and probably not long holds" — partially validated.**

What's right:
- 15m IS the dominant intraday timeframe for retail and prop-firm gold scalping (every FTMO published gold case study centres on it).
- Most published gold strategies hold minutes to hours, not days.

What's wrong / nuanced:
- The actual playbook is **multi-timeframe**: D1/H4 for bias → 15m for setup → M5/M1 for trigger. Pure-15m without higher-TF context is a misread.
- H4/D1 trend-following on gold is the single most-quantified edge: 200-day SMA filter system, 50 years of data, $100k → $10M (1971-2021).
- Spread drag on 15m gold is severe: 8-20 pip spread on 30-pip targets eats 27-67% of gross.

### Top six gold strategies by evidence quality

| Strategy | Primary TF | SL/TP | Hold | Source |
|---|---|---|---|---|
| NY Killzone sweep + FVG | 15m setup, M5 entry | 0.4% / 0.8% | 1-3h | innercircletrader.net, fxnx.com |
| Asian Range London Breakout | 15m | 0.5% / 1.0% | 2-6h | newyorkcityservers.com |
| Silver Bullet (10:00-11:00 EST) | M5/M15 | sweep-anchored | 15-60min | fxnx.com |
| News fade NFP/FOMC/CPI | 15m | engulfing-anchored | 30min-2h | brightfunded.com, fxnx.com |
| H4 trend pullback to EMA-21 | 4h | 0.8% / 2.0% | 2-7 days | litefinance.org, opofinance.com |
| 200-day SMA filter | 1d | trail SMA | weeks-months | quantifiedstrategies.com |

### FTMO gold rules (verified 2026-04-30)

- Leverage improved 2026-02-01: XAUUSD/XAUEUR/XAUAUD Standard 1:30 → **1:50**, Swing 1:9 → **1:15**.
- News rule applies to XAUUSD (Fed rate, NFP, CPI etc.). 2 min before/after window. **Live accounts only, not Evaluation. Swing accounts exempt.**
- No max lot, no position limits, no special restrictions. The "prop firms restricting gold" narrative was about other firms.

## Plan: 3 PRs

Each PR is independently mergeable into `dev`.

### PR-1: Foundation primitives (`feat/gold-primitives`)

Three new pattern detectors:

- **`gold_session_window`** — fires when bar timestamp is in a configured UTC window. Three named presets: `ny_killzone` (07:00-11:00 EST), `london_open` (00:00-04:00 EST), `asian_session` (17:00-00:00 EST). Scoped name signals gold-specific intent; condition validator emits a warning if used outside gold algorithms.
- **`asian_range_break`** — computes Asian session high/low (00:00-07:00 GMT) and fires BOS-style on a directional break of that range. Combines the session-anchored reference level with structural break detection.
- **`post_news_window`** — fires X-Y minutes after a high-impact economic release (default 5-30 min). Distinct from the existing `economic-calendar.ts` veto (which BLOCKS trading 2 min ± news); this PRIMITIVE is positive-signal — enables fade strategies that wait for the spike to settle.

Plus:
- Verify or add `SMA200` to indicator-registry.
- **Dual-run validator** helper: scores any template's walk-forward with vs without the session filter. Produces measured before/after numbers per template — so the data-driven-gates carve-out is justified by edge differential, not assertion.
- Synthetic-data tests for all three pattern detectors.

Estimated diff: ~600-800 lines across pattern detectors, validator schemas, evaluator dispatch, indicator-registry entries, dual-run helper, and tests.

### PR-2: Gold templates + grid + leverage (`feat/gold-templates`)

Six new templates added to `combinatorial-search/grid.ts`:

| Template | TF | Conditions | Logic | SL/TP |
|---|---|---|---|---|
| `gold_killzone_sweep` | 15m | `ny_killzone` + `liquidity_sweep` + `fvg` + `bos` (daily_bias-aligned) | `all` | 0.4% / 0.8% |
| `gold_silver_bullet` | M5/M15 | tighter killzone (10-11 EST) + `liquidity_sweep` + `fvg` retest | `all` | sweep-anchored |
| `gold_asian_breakout` | 15m | `asian_range_break` + `momentum` | `all` | 0.5% / 1.0% |
| `gold_h4_trend_pullback` | 4h | `daily_bias(20)` + (`pin_bar` OR `engulfing`) + RSI threshold | n_of_m=2 of 3 | 0.8% / 2.0% |
| `gold_d1_sma_trend_filter` | 1d | `SMA200` price-above (long) / -below (short) | `all` | trail SMA |
| `gold_news_fade` | 15m | `post_news_window` + engulfing reversal | `all` | reactionary anchor |

Grid additions to `PARAMETER_GRID`:
- `{15m, 0.3%, 0.9%}`
- `{15m, 0.5%, 1.5%}`
- `{4h, 0.8%, 2.0%}`
- `{1d, 1.5%, 4.5%}`

Leverage updates:
- `defaultLeverage('commodity')` 30 → **50** (matches FTMO's actual cap).
- `assembleRules.leverage` 30 → 50 conditional on gold candidates.

Exit tightening (15m candidates only):
- `stagnant_exit.max_bars: 16` (= 4 hours max hold) instead of 48.
- `stagnant_exit.min_pnl_r: -0.3` instead of -0.5 (cut faster on a fast-moving instrument).

**Forex templates and combos UNTOUCHED.** Zero perturbation to the active forex algorithm.

Estimated diff: ~400-500 lines across the grid file plus a few markets-catalog touches.

### PR-3: Run + analyze + deploy

After PR-1 and PR-2 merge:

1. Hit `POST /api/admin/combinatorial-search` with `{capital: 100000, monthly_target_pct: 10, prefer_symbols: ["XAU/USD"]}`.
2. Walk-forward ranks all gold candidates (existing + 6 new templates × 4-5 parameter combos = ~25-30 evaluated).
3. Top survivor → calibrate sizing via `calibrate.ts` to the monthly target with FTMO-safe caps.
4. Walk-forward validate the calibrated rules against full gold history.
5. Push to the live scan engine on the existing FTMO MT5 broker connection alongside the active forex algorithm. Capital allocation TBD at deploy time.

Likely surfaces gaps that earn a PR-4 (round-number reversion as a primitive, VWAP-based gold setups, multi-TF confluence templates extended to 15m gold). That's iterative — won't define scope until PR-3 results are in.

## The `feedback_data_driven_gates` carve-out

Adding `gold_session_window` is a clock-bound primitive, which conflicts with the rule "no clock filters; measure underlying signal directly." The carve-out is justified because gold killzone literature is unusually concrete:

- FTMO's published gold case studies (91.67% WR surgical scalping, 40% WR / 2.59 R:R both centred on killzone hours).
- ICT community evidence across innercircletrader.net, fxnx.com, dailypriceaction.com.
- Independent observation: gold's institutional flow concentrates in NY Killzone (07-11 EST) and London open windows.

Handling:
- **Scoped naming:** `gold_session_window`, not generic `session_window`. Condition validator emits a warning when used outside a gold algorithm.
- **Dual-run validation:** PR-1's validator scores any template using the primitive with vs without the filter. The numerical edge differential is captured in code comments — measured, not asserted.
- **Spirit of the rule honoured:** the rule is "data adjudicates, not narrative." This is data adjudicating — the dual-run produces the evidence.

If the dual-run shows the session filter doesn't actually move walk-forward results, the templates lose the filter and we keep the rule pure.

## Migration / rollout

- All three PRs merge into `dev`.
- Each PR independently mergeable — can ship PR-1 with no consumer (just primitives + tests).
- PR-2 depends on PR-1 (uses the primitives).
- PR-3 is operational, not code: run the search, calibrate, deploy.
- No DB migrations. No schema changes (rules are JSONB).
- No changes to forex algorithm or its watchlist.

## Open questions

1. ~~**Capital allocation when gold deploys live.** Run gold at full $100K alongside the forex algo (shared capital pool, with the divergence kill switch + position-size sanity gate as floors)? Or open a second FTMO broker connection / fresh challenge for gold? Recommend: same broker connection, shared capital — the position-size sanity gate (30× notional) and FTMO 5% daily loss limit already cap exposure.~~ **Resolved 2026-04-30:** shared $100K pool on the existing FTMO MetaApi broker connection. Operator confirmed. Both algos compete for the same FTMO 5% DLL budget — that's the design intent (no algo can blow the account on its own).

2. **Should the news fade template be live-only?** `post_news_window` requires a real news calendar (Finnhub via existing `economic-calendar.ts`). In backtest, we'd need to replay the same news data on historical bars. If that's not built, the template is live-only and skips backtest scoring. Recommend: surface it as live-only initially, add backtest news-replay as PR-4 work if it becomes the top live performer.

3. **Tighter `min_pnl_r` for 15m candidates: -0.3 vs -0.4?** Research showed gold 15m moves resolve fast — -0.3R cuts 4-bar losers earlier. But spread drag could trip -0.3R on noise alone. Walk-forward will tell us; -0.3 is the starting hypothesis.

4. **Round-number reversion ($50/$100 levels)** — surfaced in research as softer evidence. Skipped from PR-2 to keep scope tight. Add as PR-4 if PR-3 results show ceiling on the existing six templates.

5. **VWAP-based templates** — surfaced in research. Skipped same reason. PR-4 candidate.

## What's documented elsewhere

- `project_gold_trading.md` (auto-memory) — durable plan record for future conversations.
- `project_funded_trading.md` (auto-memory) — FTMO instrument-specific rules section added 2026-04-30 (gold leverage 1:50, news rule).
- `project_current_state.md` (auto-memory) — operator status updated to note parallel gold workstream.
- `MEMORY.md` (auto-memory index) — entry added pointing at `project_gold_trading.md`.

## Open question for you

Before PR-1 work starts:
- Three new primitives as scoped above ✓ / cuts or additions?
- The data-driven-gates carve-out approach (scoped naming + dual-run validation) ✓ / different handling preferred?
- Capital allocation answer for question 1 above (recommend: same broker, shared capital).
