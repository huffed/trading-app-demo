# CODE_QUALITY — naming, structure and flow

Written 2026-10-28 on `tooling/dev-setup` (off `dev @ 3ee22e2`). Read-only. Every row cites `file:line`; claims were produced by five read-only tracing passes and the load-bearing ones were re-read by hand before inclusion (two agent claims that did not survive re-reading were dropped). Audit findings from `review/skeptical-audit-2026-10` are cited as `audit A#/F#`.

**Tags** (every finding carries one): **safe-rename** — name only, zero behaviour change · **safe-move** — path only, zero behaviour change · **reorder** — changes behaviour (needs a characterisation test first) · **restructure** — split/merge/redesign (Phase E, after the audit verdict).

**Nothing in this document has been applied.** Renames and moves wait until the audit on `review/skeptical-audit-2026-10` has its verdict, because they would invalidate its `file:line` references (brief, "Posture").

**Contents.** §1 Naming (file map, type/function map, conventions, glossary violations) · §2 Structure (tree vs domain, files over 400 lines, tests vs sources, import cycles) · §3 Flow and order of operations (three flows, traced) · §4 Docs-vs-code name drift · §5 Finding index by tag · §6 Not checked.

---

## 1. Naming

### 1.1 How the names mislead, in one paragraph

The directory names describe one cron job (`scan/`), one abstraction (`algorithm/`), one input (`market-data/`) and one report (`cohort/`) rather than the domains the code implements, so a reader cannot find "where halts live" or "where sizing lives" from the tree: halts are in `scan/`, gates in `algorithm/`, four backtesters in `market-data/`, and the auto-pause that can stop trading in `cohort/`. Below that, the same noun is used for different things (`Regime` ×2, `BrokerConnection` ×2, `WalkForwardSummary` ×2, `computeAtr` ×2 with different signatures, `fetchDailyPrices` ×5, `checkConditions` ×2), the glossary in CLAUDE.md is violated at scale (`algo` in 22 exported types and 8 components, `symbol` 265 times outside `lib/brokers`), verbs do not say whether a function reads, writes or computes (`checkNewsVeto` is a network call, `evaluateAndPrune` writes the watchlist, `computeLiveMarketState` persists bars), and the two contracts that matter most for money — exit reasons and activity events — exist in three incompatible versions each (TS union, what the engine writes, what the DB CHECK accepts).

### 1.2 Rename map — files and modules

Target root layout used in the "proposed" column (defined fully in `CONVENTIONS.md`, Phase E): `src/lib/{feed,signals,risk,sizing,execution,persistence,api,reporting,research}/` plus `src/components` for the frontend.

**`src/lib/scan/` (45 files) — the directory name is one cron; it hosts the whole live engine**

| Current | Proposed | Reason | Tag |
|---|---|---|---|
| `scan/` | `execution/` for engine + broker mirror; halts and gates to `risk/`; LLM pipeline to `signals/llm-trader/` | "scan" names one job, not the domain | restructure |
| `scan/engine.ts` (`scanAlgorithm`) | `execution/scan-engine.ts`; drop the back-compat re-exports at `engine.ts:32` | right name, wrong directory | safe-move |
| `scan/engine-process-ticker.ts` (`processTicker`) | `execution/scan-ticker.ts` (`scanTicker`) | "process" says nothing | safe-rename |
| `scan/engine-position-mgmt.ts` | `execution/manage-position.ts` | abbreviation | safe-rename |
| `scan/manage.ts` | `execution/manage-positions-tick.ts` | "manage" alone is ambiguous | safe-rename |
| `scan/exit-trigger.ts` | `signals/exit-trigger.ts` | pure decision (`exit-trigger.ts:1-20`) | safe-move |
| `scan/entry.ts` | `execution/entry/evaluate-entry.ts` | orchestrator; its own header says the siblings do the work | safe-move |
| `scan/entry-deterministic-gates.ts` | `execution/entry/rules-path-gate-ladder.ts` | "deterministic" only means "not LLM" | safe-rename |
| `scan/entry-side-and-direction-gates.ts` | `execution/entry/rules-path-side-ladder.ts` | steps 7–11 of the same ladder | safe-rename |
| `scan/entry-gates.ts` | split: `risk/direction-conflict-gate.ts`, `risk/news-veto-gate.ts`, `signals/live-market-state.ts` | one file, three unrelated things; the name implies "the entry gates", which live in two other files | restructure |
| `scan/entry-conviction.ts` | `signals/entry-conditions.ts` (+ `pickConvictionMultiplier` → `sizing/`) | holds condition evaluation and a JSON snapshotter, not just conviction | restructure |
| `scan/entry-open.ts`, `entry-open-mirror.ts` | `execution/open-position.ts`, `execution/open-position-broker-mirror.ts` | "entry-open" is a prefix family, not a name | safe-rename |
| `scan/entry-cohort.ts` | `persistence/entry-reason-builder.ts` | builds the `entry_reason` JSONB | safe-move |
| `scan/entry-llm-trader.ts`, `entry-llm-enter.ts` | `execution/entry/llm-path.ts`, `llm-enter.ts` | | safe-rename |
| `scan/entry-llm-enter-gates.ts`, `entry-llm-defensive-gates.ts`, `entry-llm-market-state-gate.ts` | `risk/llm-post-decision-gates.ts`, `risk/llm-pre-call-gates.ts`, `risk/market-state-gate-live.ts` | gates, not entry; "defensive" is editorial | safe-rename |
| `scan/entry-llm-position-actions.ts` | `execution/llm-position-actions.ts`; drop the re-export at `:210` | not entry: `move_be` + `exit` | safe-rename |
| `scan/entry-llm-context.ts`, `llm-trader.ts`, `llm-trader-prompts.ts`, `llm-trader-providers.ts` | `signals/llm-trader/{build-context,evaluate,prompts,providers}.ts` | | safe-move |
| `scan/llm-trader-summarisers.ts` | `signals/llm-trader/summarizers.ts` | spelling (§1.4) | safe-rename |
| `scan/llm-trader-reflection.ts` | `signals/llm-trader/recent-outcomes.ts` | "reflection" is a codename | safe-rename |
| `scan/llm-trader-audit.ts` | `persistence/llm-decisions.ts` | writes/backfills `llm_decisions` | safe-move |
| `scan/helpers.ts` | split: `sizing/position-size.ts` (`calculatePositionSize`, `calculateRiskPrices`) + `persistence/activity-log.ts` (`logActivity`) | grab-bag imported by 27 files | restructure |
| `scan/live-execution.ts` | `execution/broker-mirror.ts`; drop the `resolveBrokerContext` re-export | "live" collides with the live scan; it mirrors paper → broker | safe-rename |
| `scan/broker-truth-sync.ts`, `broker-position-sync.ts` | `execution/broker-realized-pnl-sync.ts`, `execution/broker-open-position-sync.ts` | "truth" says nothing | safe-rename |
| `scan/{daily,portfolio,consec-loss,consistency,risk-pool}-halt.ts` | `risk/halts/{daily-loss,portfolio-daily-loss,consecutive-loss,ftmo-consistency,risk-pool}.ts` | consistent naming; `daily-halt` is a daily-**loss** halt | safe-rename |
| `scan/drift-detector.ts` | `risk/win-rate-drift.ts` | "drift" collides with alpha-decay (Sharpe) and `broker_reconciliation_drift`; it watches win rate only | safe-rename |
| `scan/divergence.ts` | `risk/fill-divergence-kill.ts` | paper-vs-broker fill divergence kill switch | safe-rename |
| `scan/flatten.ts` | `execution/flatten-algorithm.ts` | | safe-move |
| `scan/cron-idle.ts` | `api/cron/cron-idle.ts` | cron plumbing | safe-move |
| `scan/pair-quality.ts` (`evaluateAndPrune`) | `risk/pair-auto-pause.ts` (`autoPauseWeakPairs`) | it pauses pairs; the current name hides the write | safe-rename |
| `scan/per-hour-stats.ts` | `risk/hourly-win-rate.ts` | feeds the time-of-day filter | safe-rename |
| `scan/readiness-check.ts` + `readiness-sub-checks.ts` | `research/readiness/{report,checks}.ts` | pre-deploy diagnostic, not live path; "sub-checks" says nothing | restructure |
| `scan/vol-target-live-context.ts` | `sizing/vol-target-live-inputs.ts` | it fetches ATR + R history | safe-rename |

**`src/lib/algorithm/` (24 files + `combinatorial-search/`) — hosts gates, exit geometry, sizing, regime and a grid search**

| Current | Proposed | Reason | Tag |
|---|---|---|---|
| `algorithm/` | dissolve into `risk/gates/`, `risk/exits/`, `sizing/`, `signals/regime/`, `research/` | wrong domain name for everything inside | restructure |
| 11 gate/filter files (`intraday-atr-gate`, `spread-gate`, `bar-staleness-gate`, `bar-granularity-gate`, `live-price-drift-gate`, `re-entry-cooldown`, `time-of-day-filter`, `session-filter-gate`, `dxy-filter`, `positioning-contrarian`, `market-state-gate`) | `risk/gates/<name>-gate.ts` with one suffix | gate/filter used interchangeably | safe-rename |
| `structural-sl.ts`, `trailing-stop.ts`, `stagnant-exit.ts` | `risk/exits/{sl-tp-geometry,trailing-stop,stagnant-exit}.ts` | `structural-sl` also computes TP (`:136`) | safe-rename |
| `conviction-sizing.ts`, `vol-target-sizing.ts` | `sizing/` | | safe-move |
| `regime-classifier.ts`, `regime-routing.ts`, `market-state-features.ts` | `signals/regime/vol-regime.ts`, `risk/regime-routing.ts`, `signals/regime/market-state-buckets.ts` | the classifier is volatility terciles, not structure (`regime-classifier.ts:25`) | safe-rename |
| `rules-post-process.ts` (`clampRules`) | `persistence/rules-normalize.ts` (`normalizeRulesForUpdate`) | does far more than clamp | safe-rename |
| `dual-run-validator.ts` | delete (no importer) or `research/gold-filter-ablation.ts` | "dual run" says nothing; unreachable | restructure |
| `combinatorial-search.ts` + `combinatorial-search/` | `research/grid-search/` | a second "search" beside `algo-search/`; one live importer | restructure |

**`src/lib/market-data/` (41 files) — feed providers, indicators, condition evaluators and four backtesters**

| Current | Proposed | Reason | Tag |
|---|---|---|---|
| `prices.ts` (`fetchDailyPrices`, `getFreshPricesForScan`) | `feed/fetch-bars.ts` (`fetchBars`, `fetchClosedBarsForScan`) | fetches intraday bars too; "daily" is wrong; "fresh"/"get" are vague | safe-rename |
| `price-cache.ts` (`getCachedPrices`, `savePricesToCache`) | `feed/bar-cache.ts` (`readBarCache`, `writeBarCache`); its date-normaliser and DQ.4 filter to `feed/bar-date.ts`, `feed/bar-quality.ts` | caches bars, not prices; three concerns in one file | restructure |
| `oanda.ts`, `twelve-data.ts`, `yahoo-finance.ts`, `alpha-vantage.ts`, `finnhub.ts`, `oanda-positioning.ts`, `economic-calendar.ts`, `news-sentiment.ts`, `sentiment-cache.ts` | `feed/providers/*`, `feed/calendar.ts`, `feed/sentiment-cache.ts`; rename the four provider `fetchDailyPrices` to `fetch<Provider>Bars` | five exports share one name | safe-rename |
| `resample.ts`, `interval.ts`, `parse-bar-date.ts` | `feed/` | | safe-move |
| `types.ts` | split `feed/types.ts` (`PriceBar`, `RealTimeQuote`) + `research/backtest/types.ts` (`BacktestTrade`, `OpenPosition` → `SimOpenPosition`, `PropFirmReport`, `BacktestMetrics`, `BacktestExitReason`) | one `types.ts` mixes feed and backtest | restructure |
| `indicators.ts`, `indicator-registry.ts`, `technical-evaluator.ts`, `condition-evaluator.ts`, `sentiment-evaluator.ts`, `adx-filter.ts`, `regime-filter.ts`, `market-state.ts`, `auto-side.ts` | `signals/` | signal math, not data | safe-move |
| `portfolio-backtest.ts`, `prop-firm-backtest.ts`, `backtest-metrics.ts`, `walk-forward.ts` | `research/backtest/` | backtesters are research | safe-move |
| `prop-firm-backtest.ts` | split `research/backtest/{sim-state,fills,prop-firm-rules,sizing-sim}.ts` | name says prop firm; it hosts the shared fill/close/sizing primitives both engines use (`:89-574`) | restructure |
| `backtest-engine.ts` (`runBacktest`), `backtest-simulation.ts` | delete | no production or script caller (only `scripts/archive/2026-06-18/diag-gold-fvg-dailybias.ts`) | restructure |
| `assert-trade-side.ts` | `research/validate/` | only importer is `validate-algo.ts` | safe-move |

**The evaluator family — seven modules whose names say "evaluate"**

| Module | What it actually does | Proposed |
|---|---|---|
| `patterns/evaluate.ts` (304) | `evaluatePatternCondition`: detector dispatch + direction filter + IFVG state | keep as `signals/patterns/evaluate-pattern-condition.ts` |
| `market-data/condition-evaluator.ts` (205) | mixed technical/pattern dispatch, multi-TF routing; defines `ConditionContext`; exports its own `checkConditions` | merge → `signals/conditions.ts` |
| `conditions/evaluate.ts` (162) | thin wrappers over the above that inject `evaluateTechnical`, plus `normalize` (legacy conditions) and a second `checkConditions` | merge → `signals/conditions.ts` (removes the injection indirection and the duplicate name) |
| `market-data/technical-evaluator.ts` (83) | indicator-vs-threshold with the `value: 0` special cases | merge → `signals/conditions.ts` |
| `market-data/sentiment-evaluator.ts` (50) | pure threshold on a sentiment snapshot | `signals/sentiment-conditions.ts` |
| `signals/evaluate-live.ts` (151) | Alpha Vantage sentiment fetch + Groq narrative → buy/hold | `signals/sentiment-live-signal.ts` (today `signals/` holds only this file, which misnames the whole directory) |
| `combinatorial-search/evaluator.ts` (151) | walk-forward per grid candidate + score | `research/grid-search/score-candidate.ts` |

**Everything else**

| Current | Proposed | Reason | Tag |
|---|---|---|---|
| `patterns/` | `signals/patterns/`; keep `index.ts` only while ≥3 importers (3 today) | | safe-move |
| `patterns/types.ts` vs `*Details` types in detector files | one rule: all detail types in `types.ts` or all beside their detector | split today | restructure |
| `conditions/` (1 file) | delete after the merge | | restructure |
| `features/`, `stats/`, `algo-search/` | `research/features/`, `research/stats/`, `research/search/` | glossary (`algo`) | safe-rename |
| `features/types.ts` | `features/registry.ts` | holds runtime `computeAllFeatures` (`:66-85`) | safe-rename |
| `stats/*-cron.test.ts` ×4 | `scripts/__tests__/` | they test `scripts/*.sh` via `execSync` | safe-move |
| `algo-search/walk-forward-opt.ts` | `research/search/wfo.ts` + the cron entry in `api/` | holds the cron entry point `evaluateAndApplyWfo` (`:399-402`) | restructure |
| `cohort/{cohort-report,cohort-report-diff,engine-activity,drift-summary,m1-evidence,m1-baseline,live-mirror-eligibility,quarterly-cycle}.ts` | `reporting/` | operator read-models for `/reports`; only 2 of 11 files are about cohorts | safe-move |
| `cohort/alpha-decay.ts` | `risk/alpha-decay-pause.ts` | it pauses algorithms | safe-rename |
| `cohort/broker-health.ts`, `broker-spread-sample.ts` | `execution/broker-health.ts`, `feed/spread-sample.ts` | | safe-move |
| `brokers/` | `execution/brokers/`; `brokers/types.ts BrokerConnection` → `BrokerCredentials` (duplicates `src/types/broker.ts:5` with a different shape); fold the 12-line `metaapi-base.ts` into `metaapi.ts` | | restructure |
| `strategies/templates.ts`, `selector.ts`; `validators/trading-profile.ts` | delete | zero importers; CLAUDE.md still cites the selector | restructure |
| `performance/strategy-matrix.ts` (`StrategyMatrixRow`) | `reporting/algorithm-matrix.ts` (`AlgorithmMatrixRow`) | rows are per algorithm — glossary | safe-rename |
| `content/tips.ts`, `tour-steps.ts` | `src/components/onboarding/content/` | UI copy | safe-move |
| `constants/markets.ts` (646) | split `feed/instrument-catalog.ts` + `sizing/lots.ts` (`riskToLots`, `notionalInUsd`, `pnlInUsd`, `clampLotsToConstraints`, `priceDeltaForRule`, `ruleAsPctOfEntry`) + `frontend/quantity-units.ts` | catalog and lot-sizing math in one file | restructure |
| `constants/prop-firm.ts`; `constants/{algorithm,journal,nav}.ts`; `constants/defaults.ts` | `risk/prop-firm-presets.ts`; `frontend/labels/*`, `frontend/nav.ts`; `research/backtest/defaults.ts` | | safe-move |
| `utils/pnl.ts` (353) | split `sizing/pnl.ts` (math) + `frontend/format-money.ts` (formatting + the module-global currency state → explicit parameter) | mixes global state, formatting and P&L math | restructure |
| `utils/analytics.ts`, `equity-curve.ts`; `utils/zod-form.ts`; `utils/date.ts`; `utils.ts` (`cn`); `utils/parse-trade-csv.ts` | `reporting/`; `api/`; `frontend/format-date.ts`; `frontend/cn.ts`; `frontend/trades/` | | safe-move |
| `validators/` | `api/schemas/` | request + rules schemas | safe-move |
| `supabase/` | `persistence/`; `row-mappers.ts` hosts the single `AlgorithmRow` projection | | restructure |
| `ai/client.ts` (`getAIClient`, `AI_MODEL`) | `signals/llm-clients/groq.ts` (`getGroqClient`, `GROQ_MODEL`); `anthropic-client.ts` beside it; `analyze.ts` + `prompts/journal.ts` → `frontend/journal/` | "client.ts" is the Groq client, unnamed | restructure |
| `src/types/algorithm.ts` (794) | `types/algorithm.ts` (entity + Strategy) + `types/rules/{conditions,exits,sizing,prop-firm,regime}.ts` | one file = condition union + 340-line rules type + entity | restructure |
| `src/types/market-state.ts`, `market-state-gate.ts` | `signals/regime/types.ts`, `risk/gates/market-state-gate-types.ts` | | safe-move |
| `env.ts`, `logger.ts`, `api/admin-auth.ts` | keep at `lib/` root / `api/` | infra | — |
| `scripts/canonical/` (62 scripts, flat) | `scripts/{ops,feed,research,reporting}/`: `deploy-*` ×5, `enable-broker-mirror`, `sync-account-capital`, `metaapi-connection-doctor`, `broker-mirror-readiness-check`, `snapshot-broker-health`, `capture-broker-spread`, `sample-forex-spreads`, `build-spread-model` → `ops/`; `fetch-pinned-history`, `fetch-dukascopy-ticks`, `rebuild-price-row-from-pinned`, `repair-price-cache-dupes` → `feed/`; `m1-progress` → `reporting/`; 42 `e2.*`/`verify-*`/`robustness-*`/`stress` one-offs → `research/` or archive | "canonical" is documented as the small reusable library; it holds verdict scripts, broker ops and one-off experiments side by side | restructure |

### 1.3 Rename map — exported types and functions (most important first)

| File:line | Current | Proposed | Reason | Tag |
|---|---|---|---|---|
| `src/types/position.ts:4` | `ExitReason` = `stop_loss`, `take_profit`, `exit_signal`, `manual`, `stagnant_no_excursion` | same name; members = `stop_loss`, `take_profit`, `exit_signal`, `manual`, `stagnant_exit`, `daily_loss_halt`, `portfolio_halt`, `broker_rejected`; derive the DB CHECK from it | the engine writes `stagnant_exit` (`engine-position-mgmt.ts:93`, whose comment claims it matches the union — it does not), `broker_rejected` (`live-execution.ts:262`), `daily_loss_halt`/`portfolio_halt` (`flatten.ts` via the halts); the DB CHECK (`00038:29-36`) has `stagnant_no_excursion` + `broker_rejected` and not `stagnant_exit`; `EXIT_REASON_LABELS` (`constants/algorithm.ts:97`) has 4 of the 8 | restructure (+ migration; draft PR #291 starts it) |
| `src/lib/market-data/types.ts:26` | `BacktestExitReason` = `stop_loss_hit`, `take_profit_hit`, `signal_exit`, `stagnant_exit`, `force_close` | merge into `ExitReason` (+ `force_close`) | two vocabularies for one concept; its comment "mirrors paper_positions.exit_reason" is false | restructure |
| `src/types/activity.ts:1` | `ActivityEventType` (25 members) | regenerate from the migration list; add `alpha_decay_tick` (in the DB CHECK, emitted by `api/cron/alpha-decay/route.ts:41`, absent from the union); type `logActivity(event_type: ActivityEventType)` | `logActivity` takes `string` (`scan/helpers.ts:185`) so the union is unenforced; the code emits `drift_warn` (`engine.ts:260`), `dll_warning` (`daily-halt.ts:182`), `broker_realized_synced` (`broker-truth-sync.ts:81`), `live_order_close_failed` (`flatten.ts:126`) which are in no CHECK; `drift-summary.ts:222` queries `drift_warn`, which cannot exist | restructure |
| `scan/exit-trigger.ts:44` | `checkExitTrigger(): string ∣ null` | `exitReasonFor(): ExitReason ∣ null` | returns an untyped string that flows into the DB column | safe-rename + type |
| 13 sites: `api/cron/scan-active-algorithms/route.ts:30`, `api/cron/reconcile-broker-positions/route.ts:40`, `scan/broker-truth-sync.ts:114`, `algo-search/walk-forward-opt.ts:161`, `algo-search/state.ts:131`, `cohort/alpha-decay.ts:225`, `cohort/m1-evidence.ts:105`, `cohort/drift-summary.ts:96`, `cohort/quarterly-cycle.ts:110`, `cohort/broker-health.ts:124`, `cohort/live-mirror-eligibility.ts:63`, `performance/strategy-matrix.ts:40`, `(dashboard)/algorithms/ftmo-compliance-actions.ts:16` | `AlgoRow` ×13, each a different `Pick` | one exported `AlgorithmRow = Tables<"algorithms">` in `persistence/row-mappers.ts`; `Pick<AlgorithmRow, …>` per site | 13 ad-hoc duplicates of `Algorithm`; glossary | restructure |
| `scan/engine.ts:48` + `scan/engine-process-ticker.ts:19` | `AlgorithmWithWatchlist` ×2, identical, unexported | export once as `AlgorithmForScan` | duplicate interface | safe-move |
| `scan/entry-open.ts:48`, `scan/engine-position-mgmt.ts:29`, `scan/manage.ts:55` | `AlgoContext`, `AlgoForPositionMgmt`, `AlgoForManage` | `AlgorithmEntryView`, `AlgorithmForManage` (fold the third in) | glossary + abbreviation + three projections for two callers | restructure |
| `cohort/live-mirror-eligibility.ts:43`, `cohort/drift-summary.ts:35`, `cohort/engine-activity.ts:21`, `algo-search/criteria.ts:262-277`, `algo-search/per-regime-sweep.ts:118`, `(dashboard)/portfolios/correlation-actions.ts:16`, `cohort/m1-baseline.ts:28`, `cohort/m1-evidence.ts:47` | `AlgoEligibility`, `AlgoDriftStatus`, `AlgoActivity`, `AlgoClassForGate` (+`classifyAlgoForGate`), `AlgoForSweep`, `AlgoSummary`, `M1AlgoBaseline`, `M1AlgoProgress` | `Algorithm…` | glossary: `algo` never in a type | safe-rename |
| `src/app/(dashboard)/algorithms/[algoId]/`; `src/hooks/use-algo-trades.ts:9`; `use-algo-search-state.ts:13`; 8 `components/algorithms/algo-*.tsx`; `api/admin/flatten-algo/` | `[algoId]`; `useAlgoTrades`; `useAlgoSearchState`; `Algo*`; `flatten-algo` | `[algorithmId]`; `useBacktestTrades` (it returns `getBacktestTradesAction` data); `useSearchState`; `Algorithm*`; `flatten-algorithm` | glossary in URLs, hooks, components, routes | safe-rename |
| `scan/helpers.ts:155`; `constants/markets.ts:251,260,330,358,401,425,433,566,630,637`; `prop-firm-backtest.ts:114,373,509,563`; `economic-calendar.ts:65,196`; `utils/pnl.ts:230`; `market-data/types.ts:2`; `utils/analytics.ts:44,255` | `symbol` parameters and fields outside `lib/brokers` (265 occurrences) | `ticker` | glossary: `symbol` is the broker-side name | safe-rename |
| `prices.ts:46`, `oanda.ts:105`, `twelve-data.ts:141`, `yahoo-finance.ts:60`, `alpha-vantage.ts:47` | `fetchDailyPrices` ×5 | `fetchBars`, `fetchOandaBars`, `fetchTwelveDataBars`, `fetchYahooBars`, `fetchAlphaVantageDailyBars` | five identical export names; the first takes an `interval` | safe-rename |
| `price-cache.ts:211` | `_resetPriceCacheRowCopiesForTests` | test-only helper module | a test hook exported from a production module | safe-move |
| `indicator-registry.ts:7,35` | `Cache`, `getValues` | `IndicatorCache`, `indicatorSeries` | say nothing | safe-rename |
| `conditions/evaluate.ts:134`; `:58` + `condition-evaluator.ts:194` | `normalize`; `checkConditions(): boolean` ×2 | `normalizeLegacyConditions`; one `conditionsSatisfied` after the merge | vague; duplicate name | restructure |
| `scan/entry-conviction.ts:101,45` | `checkEntryConditions(): EntryConditionResult`, `snapshotCondition` | `evaluateEntryConditions`, `conditionToJson` | `check*` returns an object; "snapshot" says nothing | safe-rename |
| `scan/entry-gates.ts:37,65,97` | `checkDirectionConflict(): {block…}`, `checkNewsVeto(): {vetoed…}`, `computeLiveMarketState` | `directionConflictGate`, `newsVetoGate` (same `GateVerdict`), `fetchLiveMarketState` | heterogeneous result shapes; "compute" fetches and persists bars | safe-rename |
| `scan/pair-quality.ts:130,154` | `shouldPrune(): PruneDecision`, `evaluateAndPrune` | `pruneDecisionFor`, `autoPauseWeakPairs` | predicate name returning an object; the second hides a write | safe-rename |
| `scan/daily-halt.ts:21,123,152` | `DailyHaltCheck`, `maybeHaltOnDailyLoss`, `maybeWarnOnDailyLoss` | `DailyLossHaltResult`, `haltIfDailyLossBreached`, `warnIfDailyLossNear` | siblings are `*HaltResult`; "maybe" | safe-rename |
| `scan/drift-detector.ts:28,61,197`; `scan/divergence.ts:28,44,79` | `DriftCheckResult`, `detectDrift`, `executeDriftHalt`; `DivergenceCheckResult`, `checkDivergenceKill`, `haltAlgorithmForDivergence` | `WinRateDriftResult`, `evaluateWinRateDrift`, `applyWinRateDriftHalt`; `FillDivergenceResult`, `evaluateFillDivergence`, `disableLiveTradingForFillDivergence` | "halt" sets `live_trading_enabled=false`, it does not halt | safe-rename |
| `scan/broker-truth-sync.ts:44,98`; `scan/broker-position-sync.ts:35,84` | `reconcileBrokerRealizedPnl`, `reconcileOrphanBrokerRealized`, `syncBrokerUnrealizedPnl`, `reconcileMissingBrokerPosition` | `syncRealizedPnlFromBroker`, `syncRealizedPnlForIdleAlgorithms`, `syncUnrealizedPnlFromBroker`, `closePaperPositionFromBrokerHistory` | reconcile/sync used interchangeably | safe-rename |
| `scan/live-execution.ts:175,307`; `scan/entry-open-mirror.ts:59` | `executeLiveEntry`, `executeLiveExit`, `logOpenAndMirror` | `mirrorEntryToBroker`, `mirrorExitToBroker`, `recordOpenAndMirrorToBroker` | "live" is ambiguous; "log" hides a broker order | safe-rename |
| `scan/llm-trader.ts:126` vs `scan/entry-llm-context.ts:86` | `buildLlmTraderContext(): {userMessage, regime}` vs `buildLlmTraderCtx(): LlmTraderContext` | `renderLlmUserMessage`, `buildLlmTraderContext` | near-identical names, inverted meanings | safe-rename |
| `scan/llm-trader.ts:56` vs `algorithm/regime-classifier.ts:26` vs `types/market-state.ts:13` | `Regime` (HH/LH/RANGING), `Regime` (low/medium/high vol), `StructRegime` | `StructureRegime`, `VolRegime` | one name, two meanings | safe-rename |
| `scan/llm-trader-summarisers.ts:32`, `regime-filter.ts:39`, `market-state.ts:71`, `structural-sl.ts:198` | `computeAtr(bars,period,idx): number`, `computeAtr(bars,period): (number∣null)[]`, `atr14`, `dailyAtrFromBars` | `atrSeries` + `atrAt` in `signals/indicators.ts` (Wilder, one formula) | four ATRs; two share a name with different signatures; two formulas used side by side in the backtest | restructure |
| `stats/bootstrap.ts:285`, `algo-search/bayesian-optimization.ts:135`, `algo-search/walk-forward-opt.ts:146` | `sharpeRatio`, `computeSharpe`, `sharpeFromR` | one `sharpeFromR` | three Sharpe implementations | restructure |
| `scan/llm-trader-audit.ts:162` | `backfillClosedTradeOutcomes` | `backfillClosedPositionOutcomes` | reads `paper_positions` — glossary (trade ≠ position) | safe-rename |
| `scan/readiness-sub-checks.ts:54,112,150,166`; `:23` vs `walk-forward.ts:45` | `walkForwardCheck`, `pairQualityCheck`, `sideSymmetryCheck`, `ftmoFitCheck`; `WalkForwardSummary` ×2 (different shapes) | `checkWalkForward`…; readiness one → `ReadinessWalkForwardInput` | suffix vs prefix; duplicate name | safe-rename |
| `readiness-sub-checks.ts:32`, `pair-quality.ts:29`, `types/strategy-stats.ts:27` | `PairStat`, `PairStats`, `PairStatRow` | `PairWinRateInput`, `PairClosedStats`, keep the third | three near-identical names | safe-rename |
| `algorithm/market-state-gate.ts:77,212`; `spread-gate.ts:59,130`; `positioning-contrarian.ts:64,165` | `checkMarketStateGate` / `checkMarketStateGateConfig`; `evaluateSpread` (pure) / `checkBrokerSpread` (I/O); `evaluatePositioningContrarian` (pure) / `evaluatePositioningGate` (I/O) | `*GateVerdict` (pure) / `fetch*GateVerdict` (I/O) | pure vs I/O pairs named inconsistently | safe-rename |
| 8 gate modules (`bar-staleness-gate.ts:82`, `bar-granularity-gate.ts:62`, `live-price-drift-gate.ts:63`, `intraday-atr-gate.ts:78`, `session-filter-gate.ts:38`, `time-of-day-filter.ts:64`, `dxy-filter.ts:72`, `re-entry-cooldown.ts:72`) | `check*` → per-gate result shapes (`block` / `skip` / `vetoed` / `status`) | `*Gate(): GateVerdict` (one shape) | heterogeneous results force every caller to special-case | restructure |
| `algorithm/rules-post-process.ts:33,178` | `clampRules`, `withPropFirmContext` | `normalizeRulesForUpdate`, `applyPropFirmDefaults` | it relaxes RSI, converts decimals, truncates, defaults — not a clamp | safe-rename |
| `combinatorial-search.ts:40-106`, `combinatorial-search/grid.ts:31`, `grid-templates.ts:49` | `SearchInput`, `CandidateResult`, `SearchResult`, `SearchOptions`, `Candidate`, `Template` | `GridSearch*`, `GridCandidate`, `GridTemplate` | collide with `algo-search` `SearchState`/`SearchCandidate`/`SearchCriteria` and `strategies` `StrategyTemplate` | safe-rename |
| `backtest-metrics.ts:3` vs `utils/analytics.ts:76`; `analytics.ts:161` vs `equity-curve.ts:27`; `equity-curve.ts:9` vs `engine-activity.ts:62` | `calculateMetrics` / `computeMetrics`; `computeEquityCurve` ×2; `EquityPoint` ×2 | `backtestMetrics` / `analyticsMetrics`; `equityCurveFromTrades` / `equityCurve`; one `EquityPoint` | duplicate names | safe-rename / restructure |
| `utils/analytics.ts:307` | `normalizePaperPositions(): Trade[]` | `paperPositionsAsTrades` | "normalize" hides a type conversion | safe-rename |
| `utils/pnl.ts:9,14` | `setActiveCurrency` / `getActiveCurrency` (module globals shared across server requests) | explicit `DisplayCurrency` parameter | hidden global state in a lib util | restructure |
| `brokers/types.ts:17` vs `src/types/broker.ts:5`; `brokers/metaapi-base.ts:6`; `strategies/templates.ts:19`; `validators/algorithm.ts:521` vs `types/algorithm.ts:794`; `stats/bootstrap.ts:112` vs `block-bootstrap-bars.ts:24`; `alpha-vantage.ts:12` vs `finnhub.ts:57` | `BrokerConnection` ×2 (13 vs 17 fields); `MetaApiRegion`, `RiskLevel`, `AlgorithmUpdate`, `BlockBootstrapOptions`, `lookupTickerName` ×2 each | `BrokerCredentials`; import from `src/types`; `AlgorithmUpdateInput`; `BlockBootstrapStatOptions` / `BarBlockBootstrapOptions`; `alphaVantageTickerName` / `finnhubTickerName` | same name, two shapes | safe-rename |
| `market-data/types.ts:57` | `OpenPosition` | `SimOpenPosition` | collides with the `PaperPosition`/`BrokerPosition` family | safe-rename |
| `performance/strategy-matrix.ts:17,132`; `types/strategy-stats.ts:37` | `StrategyMatrixRow`, `buildStrategyMatrix`, `StrategyStats` | `AlgorithmMatrixRow`, `buildAlgorithmMatrix`, `AlgorithmConditionStats` | glossary: strategy ≠ algorithm | safe-rename |
| `cohort/alpha-decay.ts:298`; `algo-search/walk-forward-opt.ts:402` | `evaluateAndApplyAlphaDecay`, `evaluateAndApplyWfo` | `runAlphaDecayCron`, `runWfoCron` | "evaluateAndApply" hides a DB write and a pause | safe-rename |
| `features/types.ts:66`; `brokers/ctrader/messages.ts:29`; `ai/client.ts:3,11`; `scan/cron-idle.ts:38`; `scan/engine-process-ticker.ts:41` | `computeAllFeatures` (in a types file), `PT`, `getAIClient`/`AI_MODEL`, `pickHeartbeatUserId`, `processTicker` | move to `registry.ts`; `PAYLOAD_TYPES`; `getGroqClient`/`GROQ_MODEL`; `resolveOperatorUserId`; `scanTicker` | runtime in types; says nothing; unnamed provider; "pick"; "process" | safe-rename |
| `scan/engine.ts:36` `ScanResult`, `scan/readiness-check.ts:54` `ReadinessReport`, `walk-forward.ts:35` `WalkForwardWindow`, `spread-gate.ts:33` `SpreadGateResult` | snake_case fields on types that mirror no DB row | camelCase | §1.4 | safe-rename |
| `supabase/row-mappers.ts:34` | `algorithmFromRow(row) = row as unknown as Algorithm` | keep the name; it is a cast, not a mapper — Zod-validate or rename `castAlgorithmRow` | name over-promises | — |

### 1.4 Conventions found (and the single rule to adopt)

| Convention | Count / examples (grep, `src/lib` + `src/types` + `src/app/api`, non-test) | One rule |
|---|---|---|
| Percent suffix | `_pct` 383, `Pct` 283, `Percent` 18, `_percent` 6 | `_pct` on DB-mirroring fields, `Pct` in TS; delete `Percent`/`_percent` (24 sites) |
| Basis points | `slippage_bps` 18, `slippageBps` 16, `spread_bps` 14, `avgBps` 6, bare `bps` 10 | `Bps`/`_bps`; never a bare `bps` field |
| R-multiple | `rr_multiple` 63, `mean_r` 32, `rMultiple` 24, `perTradeR` 19, `r_multiple` 15, `meanR` 11, `current_r` 8, `mfe_r` 6, `currentPnlR` 5, `RrMultiple` 2 | `…R` for an R-multiple value (`meanR`, `currentR`, `mfeR`); `rrMultiple` for the geometry ratio; DB fields `_r` |
| Timestamps | `_at` 500 (DB), `At` 47, `Iso` 24, `Ts` 17, `Ms` 201, `_ms` 32, `_utc` 57, `Utc` 14; `barDate`/`bar_date`/`barTs`/`currentTs`/`startIso` all mean a bar timestamp | ISO string → `*At`/`*_at`; epoch ms → `*Ms`; hour of day → `*HourUtc`; never `Ts`/`Iso` |
| Field case | `src/types`: 240 snake_case field lines, 2 camel (DB mirrors — consistent); `src/lib`: 2,617 snake vs 1,262 camel with non-DB types using snake (`ScanResult`, `ReadinessReport`, `WalkForwardWindow`, `SpreadGateResult`) beside camel siblings (`PositionSizingResult`) | snake_case only on types that mirror a DB row or JSONB column; everything else camelCase |
| Spelling | `summarise` 42 vs `summarize` 6; `normalise` 18 vs `normalize` 50; `finalize` 9 vs `finalise` 0 | American (`-ize`): the majority outside the LLM summariser cluster |
| Gate / filter / halt vocabulary | files: 9 `*-gate`, 3 `*-filter`, 5 `*-halt`; functions: `check*` 28 (returns an object in 26, boolean in 2), `evaluate*` 19, `has*` 4, `is*` 11, `should*` 1 (object) | `has*`/`is*` boolean only; gates = `*Gate(): GateVerdict`; halts = `*Halt(): HaltResult`; retire `check*` |
| Verb pairs | `calculate*` 5 vs `compute*` 22; `fetch*` vs `get*` (`getCachedPrices` reads the DB, `getFreshPricesForScan` hits the network); `reconcile*` 4 vs `sync*` 1; `build*` 27 | `compute*` pure, `fetch*` I/O, `read*`/`write*` cache, `build*` object construction |
| Logging | `console.*` directly in 14 files (28 calls) in `src/lib` + `src/app/api` vs `logger.*` 33 calls; `prices.ts` uses `console.warn`, `price-cache.ts` `console.warn`, `walk-forward-opt.ts` `console.error` | `logger` only; `no-console` promoted to `error` outside `logger.ts` and `scripts/` |
| Error handling | 142 catch sites in `src` with five different outcomes (empty, log-only, return-fallback, rethrow, other); server actions return `{success:false,error}` 73×; API routes `NextResponse.json({error},{status})` by hand per route | one `ActionResult` helper and one route wrapper; gates raise or return a typed verdict, never a fallback value |
| Feature keys | `f_volume_ratio_20`, `f_volume_z_score_50` (`features/volume.ts:53`) — `f_` + snake inside a camelCase codebase | keep (string keys into xgboost rows) and document |
| File names | all `src` files kebab-case (only `database.types.ts`, generated); `scripts/canonical`: 6 files with dots and roadmap ids (`e2.15-l2-…`, `e27.5-…`) | kebab-case; roadmap id as a dotless prefix |
| Test names | `<subject>.test.ts` beside the subject for 114 files; 19 tests with no same-named subject (§2.3) | `<subject>.test.ts` beside the subject; concern splits as `<subject>.<concern>.test.ts` |
| `SupabaseClient` aliases | four private `type Supa…` aliases (`engine-activity.ts:86`, `live-mirror-eligibility.ts:168`, `strategy-matrix.ts:64`, `chart-markers.ts:9`), three of them `<any,any,any>` | one exported `DbClient` in `persistence/` |

### 1.5 Glossary violations (CLAUDE.md "Domain Glossary" vs code)

| Rule | Violations |
|---|---|
| `algo` only as a local variable | 13 `AlgoRow` + 9 other `Algo*` exported types; route segment `[algoId]`; hooks `useAlgoTrades`, `useAlgoSearchState`; 8 `algo-*.tsx` components; route `/api/admin/flatten-algo`; directory `algo-search/` |
| `symbol` only inside `lib/brokers/*` | 265 occurrences outside it: `constants/markets.ts` (10 exported signatures), `scan/helpers.ts:155`, `prop-firm-backtest.ts`, `economic-calendar.ts:65,196`, `utils/pnl.ts:230`, every feed provider |
| `Strategy` = template, `Algorithm` = instance | `StrategyMatrixRow`/`buildStrategyMatrix`/`StrategyStats` are per-algorithm |
| `trade` = completed round-trip, `position` = live tradable | `backfillClosedTradeOutcomes` reads `paper_positions`; `useAlgoTrades` returns backtest trades; `normalizePaperPositions(): Trade[]` |
| `order` only at the adapter layer | `live-execution.ts:69-100` is the adapter caller and legitimately handles orders — keep, but move it under `execution/` |

---

## 2. Structure

### 2.1 Current tree against the domain

| Directory | Domains it actually contains | Files that belong elsewhere (→ target) | Mixes concerns? |
|---|---|---|---|
| `src/lib/scan` (45 files) | execution + risk + signals + persistence + api + research | halts, drift, divergence, pair-quality, per-hour → **risk**; llm-trader-*, exit-trigger, entry-conviction → **signals**; llm-trader-audit, entry-cohort, `logActivity` → **persistence**; cron-idle → **api**; readiness-* → **research**; `calculatePositionSize`, vol-target-live-context → **sizing** | yes — six domains |
| `src/lib/algorithm` (24 + 7) | risk + sizing + signals + research + persistence | gates/exits → risk; conviction/vol-target → sizing; regime-*/market-state-features → signals; combinatorial-search, dual-run-validator → research; rules-post-process → persistence | yes |
| `src/lib/market-data` (41) | feed + signals + research | indicators/evaluators/adx/regime/market-state/auto-side → signals; six backtest files + assert-trade-side → research | yes — feed providers next to four backtesters |
| `src/lib/patterns` (24) | signals | — | no |
| `src/lib/conditions` (1) | signals | merge into `signals/conditions.ts` | no |
| `src/lib/signals` (1) | signals | holds only the sentiment+Groq signal | misnamed as the signals home |
| `src/lib/cohort` (11) | reporting + risk + execution + feed | alpha-decay → risk; broker-health → execution; broker-spread-sample → feed | yes — reports beside an auto-pause |
| `src/lib/algo-search` (12) | research + api | walk-forward-opt cron entry → api | mostly no |
| `src/lib/stats` (12) | research | the four `*-cron.test.ts` test shell scripts → `scripts/` | no |
| `src/lib/features` (11) | research | — | no |
| `src/lib/brokers` (12) | execution | `types.ts` duplicates `src/types/broker.ts` | no |
| `src/lib/strategies` (2) | dead | delete | — |
| `src/lib/performance`, `content`, `validators`, `supabase`, `api` | reporting, frontend, api, persistence, api | `validators/trading-profile.ts` dead; `content/` → components | no |
| `src/lib/constants` (6) | feed + sizing + risk + frontend + research | `markets.ts` split; prop-firm → risk; labels/nav → frontend; defaults → research | yes — instrument catalog + lot math |
| `src/lib/utils` (7) | sizing + frontend + reporting + api | `pnl.ts` split; analytics/equity-curve → reporting; zod-form → api; parse-trade-csv → frontend | yes — P&L math + display formatting |
| `src/lib/ai` (5) | signals + frontend | journal analyse/prompt → frontend | yes |
| `src/types` (13) | persistence mirrors + signals + api | market-state* → signals; ftmo-compliance, strategy-stats → reporting | yes |
| `src/app/api` (26 routes) | api | `loser-analysis/route.ts` (280 lines) and `reconcile-broker-positions/route.ts` (283) hold domain logic → libs | yes in two routes |
| `src/app/(dashboard)/*/actions.ts` (24 files) | api (server actions) | `paper-trading-actions.ts:114` manual close + broker mirror and `:303` price refresh → execution/feed; backtest/validate/correlation actions run engines → research | yes |
| `scripts/canonical` (62 scripts, flat) | research + broker ops + feed ops + reporting | see §1.2 last row | yes |

### 2.2 Files over 400 lines (non-test, non-generated)

| Path | Lines | What it mixes | Split proposal | Tag |
|---|---|---|---|---|
| `src/lib/market-data/portfolio-backtest.ts` | 1,398 | sim config + timeline + ticker state (126-325); close loop + force close (327-470); seven fidelity gates (492-790); entry attempt (791-1059); summary; runner (1127-1398) | `research/backtest/portfolio/{state,gates,entry,close,run}.ts` | restructure |
| `scripts/canonical/validate-algo.ts` | 1,298 | 25 env vars (92-188); bar loading; stats/gates (426-740); algo + broker loading (745-892); friction classification; demo gate; `main` (complexity 82) | `validate/{config,load,stats,gates,report}.ts` + thin entry | restructure |
| `src/types/algorithm.ts` | 794 | condition union + guards (6-160); SL/TP/sizing/prop-firm/news/regime (161-380); `AlgorithmRules` (381-722); `BacktestResults`; entity; Strategy | `types/rules/*` + `types/algorithm.ts` | restructure |
| `scripts/canonical/e2.22-layer-b-pinned.ts` | 692 | six `MODE=` subcommands sharing loaders | one file per mode | restructure |
| `src/lib/constants/markets.ts` | 646 | catalog (30-245); USD conversion + lots + notional + P&L (251-425); backtest volume constraints (457-515); rule→price deltas (515-566); display units + spread (566-646) | `feed/instrument-catalog.ts`, `sizing/lots.ts`, `sizing/rule-geometry.ts`, `frontend/quantity-units.ts` | restructure |
| `src/lib/market-data/prop-firm-backtest.ts` | 645 | sim state; fills + slippage + exit price; prop-firm enforcement; vol-target sizing (364-485); report | `sim-state.ts`, `fills.ts`, `prop-firm-rules.ts`, `sizing-sim.ts` | restructure |
| `src/lib/algo-search/walk-forward-opt.ts` | 528 | geometry extraction; bar windowing; Sharpe; sweep; proposal; DB load + cron apply (379-528) | `wfo/{geometry,sweep,proposal}.ts` + the apply step in `api/cron/wfo` | restructure |
| `src/lib/validators/algorithm.ts` | 521 | form schema; condition schemas (59-149); prop-firm schema (150-374); rules schema (377-511); update schema | mirror the types split | restructure |
| `src/lib/scan/llm-trader-prompts.ts` | 520 | eight prompt bodies + capability registry + resolver | one file per version + `prompts/index.ts`; text is frozen baseline material — move verbatim, never edit | safe-move |
| `scripts/canonical/lib/pinned-eval.ts` | 497 | pinned loaders; solo stats; stress test; MC challenge; run-until-target; session daily; pearson | `pinned/{load,stats,stress,challenge}.ts` | restructure |
| `scripts/canonical/algo-search.ts` | 472 | env; Supabase inserts; child-process validate runner; four modes | `search/{persist,run-validate,modes}.ts` | restructure |
| `src/lib/algo-search/portfolio-composer.ts` | 458 | WR blend; monthly R; correlation; dollar-pool DD sims (194-258); greedy composer (262-436) | `composer/{series,drawdown,compose}.ts` | restructure |
| `src/components/reports/search-tab.tsx` | 447 | 11 private components | `reports/search/*.tsx` | restructure |
| `scripts/canonical/e2.20-rederivation.ts` | 435 | duplicates `soloStats`/`stressTest`/`dailySeries`/`pearson` from `lib/pinned-eval.ts` (`:129-207` vs `pinned-eval.ts:99-483`) | delete the copies; import | restructure |
| `scripts/canonical/{stepwise-feature-augmentation,feature-veto-validate,revalidate-candidates,robustness-multi-cut}.ts` | 432 / 422 / 448 / 414 | each re-declares `computeMetrics` / `riskDollarsFor` / `loadBars` (`feature-veto-validate.ts:99-227`, `revalidate-candidates.ts:119-163` after the B14 reformat, `robustness-multi-cut.ts:106-220`) | one shared `scripts/canonical/lib/` | restructure |
| `src/app/(dashboard)/algorithms/paper-trading-actions.ts` | 428 | scan trigger; manual close + broker mirror (114-244); price refresh with provider fallback (245-349); stats | `execution/manual-close.ts`, `feed/refresh-position-prices.ts`; thin actions | restructure |
| `scripts/canonical/sample-forex-spreads.ts` | 425 | config; quantiles; broker polling; JSONL + calibration writers | `scripts/ops/spreads/{poll,calibrate}.ts` | restructure |
| `src/lib/market-data/backtest-simulation.ts` | 404 | single-ticker sim loop | dead with `backtest-engine.ts` — delete | restructure |
| `src/lib/market-data/price-cache.ts` | 402 | date normalisation (27-79); DQ.4 filter (80-135); egress row copy (176-214); DB read/write (215-402) | `feed/bar-date.ts`, `feed/bar-quality.ts`, `feed/bar-cache.ts` | restructure |

### 2.3 Tests against the source layout

Rule today (`vitest.config.ts:7`): `src/**/*.test.ts` only. Consequences: 0 component tests (no `.test.tsx`, no DOM environment), 0 of 24 `(dashboard)/*/actions*.ts` tested, 6 of 26 API routes tested (the six `api/cron/*` routes beside their `route.ts`; `cleanup-caches`, `reconcile-broker-positions` and all 11 `admin/*` routes have none), and `scripts/` (46k lines, including every deploy and verdict script) has no tests at all.

In `src/lib/scan` all 44 tests mirror a source name exactly; the "split by concern" problem is the reverse — the **source** was split into 13 `entry-*` files, so a behaviour test for "the entry path" spans 13 files.

Nineteen test files have no same-named subject: 11 `portfolio-backtest-<concern>.test.ts` (2,138 lines) and 2 `prop-firm-backtest-<concern>.test.ts` (rename to `<subject>.<concern>.test.ts`, and move beside the gate modules after the §2.2 split); `features/features.test.ts` (535 lines over eight category files); `algo-search/spec-2026-10-machinery.test.ts`; and four `stats/*-cron.test.ts` that exercise `scripts/*.sh` through `execSync` and belong under `scripts/__tests__/`.

Live-path modules with **no** test at all: `patterns/evaluate.ts` (304), `algorithm/stagnant-exit.ts` (245), `algorithm/structural-sl.ts` (202), `market-data/economic-calendar.ts` (219), `market-data/prices.ts` (185), `market-data/twelve-data.ts` (182), `brokers/metaapi.ts` (273), `utils/pnl.ts` (353), `constants/markets.ts` (646 — `riskToLots`, `pnlInUsd`, `clampLotsToConstraints` untested). The Phase B characterisation tests go here first.

One rule: `<module>.test.ts` beside `<module>.ts`; concern splits as `<module>.<concern>.test.ts`; script tests under `scripts/__tests__/`; `vitest include: ["src/**/*.test.ts", "scripts/**/*.test.ts"]`.

### 2.4 Import cycles — 18 edges in 8 groups, all type-only back-edges

| Cycle | Back-edge | Cut |
|---|---|---|
| `scan/entry.ts:36` → `entry-deterministic-gates.ts` | `entry-deterministic-gates.ts:47` `import type { EntryContext } from "./entry"` | move `EntryContext` to `scan/entry-context.ts` |
| `entry.ts:37` → `entry-llm-trader.ts` → `{entry-llm-context:26, entry-llm-defensive-gates:34, entry-llm-market-state-gate:30, entry-llm-position-actions:26 → entry-llm-enter:22 → entry-llm-enter-gates:44}` | each `import type { EntryContext } from "./entry"` | the same move closes seven back-edges; also drop the runtime re-export `entry-llm-position-actions.ts:210` |
| `llm-trader.ts:32` → `llm-trader-providers.ts`; `llm-trader.ts:40` → `llm-trader-summarisers.ts` | `providers:11`, `summarisers:9` `import type { LlmTraderDecision / LlmTraderContext, Regime }` | `llm-trader-types.ts` |
| `components/algorithms/position-chart-render.tsx:19` → `position-chart-controls` | `controls:5` `import type { ChartPoint, ChartView }` + a re-export at `render:72` | `position-chart-types.ts`; drop the re-export |
| `(dashboard)/chart/actions.ts:8-9` → `chart-markers`, `pattern-scan` (→ `pattern-builders`, `pattern-scan-fvg`) | each imports chart types from `actions.ts:11-110` | `chart/types.ts`; `actions.ts` keeps the two server actions only |
| `algorithm/combinatorial-search.ts:36-38` → `combinatorial-search/{evaluator,universe,grid}` | `evaluator:26`, `universe:10` `import type { SearchInput, CandidateResult }` | `combinatorial-search/types.ts` |
| `combinatorial-search/grid-templates.ts:28` → `grid-templates-gold-indicators` | `gold-indicators:18` `import type { Template }` | `template-types.ts` |

None is a runtime cycle, which is why `import-x/no-cycle` (set to `error`) reports nothing and nothing breaks: `isolatedModules` erases them. They still make the dependency direction unreadable. Tag: **safe-move** (eight type moves).
## 3. Flow and order of operations — what actually happens

Three flows, traced from the code on `dev @ 3ee22e2` (not from the docs). Every hop cites `file:line`. The diagrams show the live engine; §3.2 shows the same bar through the backtester and lists every place the two order the same steps differently. Tags: **reorder** = changing it changes behaviour; **restructure** = needs a code move before it can be fixed cleanly; **safe-move/safe-rename** = can be done with no behaviour change.

### 3.1 Flow 1 — a bar arrives (one scan tick, one algorithm, one ticker)

```mermaid
sequenceDiagram
    autonumber
    participant CW as scan-cron.sh (every 15 min)
    participant R as GET /api/cron/scan-active-algorithms
    participant PH as portfolio-halt
    participant E as engine.scanAlgorithm
    participant DH as daily-halt
    participant TD as Twelve Data /price
    participant PT as processTicker
    participant PL as price layer (rowCopies → price_cache → OANDA → Twelve Data → Yahoo)
    participant MG as manageExistingPosition
    participant G as gate ladder
    participant CE as condition evaluator
    participant OP as openPosition
    participant DB as paper_positions / activity_log

    CW->>R: curl GET + Bearer CRON_SECRET (scan-cron.sh:32)
    R->>DB: SELECT algorithms status='active' [+ OPERATOR_USER_ID] (route.ts:108-116)
    R->>PH: applyPortfolioHalts — only algos with portfolio_id (route.ts:52-88)
    PH->>DB: today's realized + open unrealized per portfolio (portfolio-halt.ts:50-62)
    Note over PH,DB: tripped → flatten(exit_reason='portfolio_halt') + live_trading_enabled=false, once per UTC day
    R->>E: scanAlgorithm(algo), sequentially per algo (route.ts:181-203)
    E->>E: drop auto_paused tickers; 0 left → return with NO events (engine.ts:85-86)
    E->>DB: scan_started (engine.ts:88-92)
    E->>DH: maybeHaltOnDailyLoss (engine.ts:94 → daily-halt.ts:123-140)
    Note over DH,DB: tripped → flatten(exit_reason='daily_loss_halt') + live flag off + RETURN; no fired-today guard; no scan_completed
    E->>DH: maybeWarnOnDailyLoss → dll_warning (rejected by the activity_log CHECK)
    E->>DB: loadOpenPositions — query error ⇒ treated as flat (engine.ts:154-166)
    E->>TD: fetchBatchQuotes(all tickers) BEFORE any bar is loaded (engine.ts:99,170-176)
    TD-->>E: Map or EMPTY on any failure (HTTP-200 error bodies included)
    E->>PT: processTicker (engine.ts:110-125)
    PT->>PL: getFreshPricesForScan(ticker,"full","4h") (engine-process-ticker.ts:60; prices.ts:87-134)
    PL-->>PT: bars; savePricesToCache fire-and-forget on refresh
    PT->>PL: getFreshPricesForScan(ticker,"full","1day") — 26 h margin (engine-process-ticker.ts:133-143)
    PT->>MG: each open position: stagnant → SL → TP → exit conditions at quote ?? last close (engine-position-mgmt.ts:77-94)
    MG->>DB: atomic close claim (status='open' → 'closed') or current_price/unrealized_pnl update
    PT->>PT: computeCappedReason on the in-memory list (engine-process-ticker.ts:85)
    PT->>G: runDeterministicEntryGates (entry.ts:118 → entry-deterministic-gates.ts:67-168)
    G->>G: 0a granularity → 0b staleness → 1 ATR liquidity (:78-130)
    G->>G: 2 news veto (Finnhub, fails open) → 3 consec-loss (DB) → 3b cooldown (DB) (:278-326)
    G->>DB: 4 time_filter per-hour stats (ALL closed rows) → 5 consistency (ALL closed rows) (:211-251)
    G->>G: 7 side = rules.side → direction conflict (DB) → DXY / regime / ADX if configured
    G-->>DB: signal_no_action on the first block
    PT->>CE: checkEntryConditions — daily_bias aligned to the completed D1 by date prefix (entry.ts:126-138)
    PT->>DB: signal_detected — BEFORE sizing and insert (entry.ts:153)
    PT->>OP: openPosition (entry.ts:155-170)
    OP->>OP: regime routing → margin used → SL distance (swing + 0.1 ATR) → TP (entry-open.ts:135-165)
    OP->>OP: calculatePositionSize (pure; no lot floor) → SL/TP prices (entry-open.ts:176-195)
    Note over OP: risk-pool cap SKIPPED when brokerCtx is null, i.e. always in paper mode (entry-open.ts:199-205)
    OP->>DB: INSERT paper_positions — insert error discarded (entry-open.ts:247-268)
    OP->>DB: position_opened; broker mirror only if brokerCtx (entry-open-mirror.ts:59-91)
    E->>DB: scan_completed; last_scanned_at (engine.ts:127-149)
    E->>DB: only if this scan closed something: pair auto-pause + drift detector (engine.ts:142-144)
    R-->>CW: HTTP 200 even when every algo errored (route.ts:186-209)
```

**The manage tick** (every 5 min) is the same `manageExistingPosition` loop without the entry half: `manage.ts:187-258` loads open positions joined to `algorithms.status='active'`, fetches one Twelve Data quote batch per algo, loads 4h bars through the fresh path but **D1 bars through the 7-day-TTL cached path** (`manage.ts:79-97` vs `engine-process-ticker.ts:133-143`), then stagnant → SL → TP per position. A ticker whose bars fail to load is skipped with an `errors[]` entry while the route still returns 200 and writes `manage_tick`, so the dead-man stays green.

**Where every price comes from** (one table the docs never had):

| Price | Source | Code | When it is missing |
|---|---|---|---|
| Signal bars (4h) | in-process row copy (10 min) → `price_cache` (1 h TTL, ≤2,000 bars) → OANDA complete candles → Twelve Data → Yahoo | `prices.ts:87-134,136-185`; `price-cache.ts:215-261` | all fail + no cache → `error` event; providers fail + cache → stale bars, blocked only by the 6 h staleness gate |
| Daily bars (bias, regime, ADX) | scan: fresh path, 26 h margin; manage: 7-day-TTL cache | `engine-process-ticker.ts:133-143`; `manage.ts:79-97` | null → `resampleToDaily(4h bars)` UTC-day aggregates, silently (`entry-conviction.ts:120`, `exit-trigger.ts:90`) |
| Entry fill | Twelve Data `/price` quote taken at algo-scan start | `engine.ts:99`; `entry-deterministic-gates.ts:72` | silent fallback to the last 4h close; nothing records which was used |
| SL/TP trigger | same quote (manage: quote at manage-algo start); point price, never bar high/low | `engine-position-mgmt.ts:77`; `exit-trigger.ts:55-72` | fallback to a close up to 4 h old |
| Exit fill / realized P&L | `exit_price = currentPrice`, `realized_pnl = pnlInUsd(...)` — no spread, slippage or swap | `engine-position-mgmt.ts:145-158`; `markets.ts:401-423` | — |
| Flatten fill | `current_price ?? entry_price` from the last manage write | `flatten.ts:94-103` | never-ticked row closes at entry (0 P&L) |
| News events | Finnhub, 1 h memory cache | `economic-calendar.ts:119-154` | `[]` → veto never fires (fails open) |

**Order-dependency hazards in Flow 1** (file:line, concrete failure, tag):

| # | Where | Hazard | Concrete failure | Tag |
|---|---|---|---|---|
| F1-1 | `engine-position-mgmt.ts:92-94` + `supabase/migrations/00038:25-37` | engine writes `exit_reason='stagnant_exit'`; the DB CHECK allows only `stop_loss, take_profit, exit_signal, manual, stagnant_no_excursion, broker_rejected`; no migration on `dev` adds it | close claim fails → `logger.error`, `{closed:0}`; the stagnant branch short-circuits `checkExitTrigger`, so SL/TP are not evaluated for that position while the stagnant predicate holds; re-fires every 5 min. Latent: no stagnant exit has fired yet (audit A4; fix on draft PR #291) | reorder |
| F1-2 | `flatten.ts:96-113` ← `daily-halt.ts:97-101`, `portfolio-halt.ts:127` | flatten writes `daily_loss_halt` / `portfolio_halt` (also rejected) and never reads the update error | halt logs `position_closed{source:flatten}` and `daily_loss_halt{positions_flattened:N}` while rows stay open; next tick trips again; `scanAlgorithm` returns before `scan_completed` all day → `last_scan_tick()` sees silence → possible false dead-man alert on a loss day | reorder |
| F1-3 | `engine.ts:99` vs `engine-process-ticker.ts:60` | the fill quote is fetched once per algo before bars, before every gate and DB read | `entry_price`, SL/TP geometry and lot size derive from a quote as old as the whole algo scan | reorder |
| F1-4 | `twelve-data.ts:97-109`; `engine.ts:170-176`; `manage.ts:120-124` | quote failure, including an HTTP-200 `{code:429,status:"error"}` body (`parseFloat(undefined)` → NaN → not set), is silent | fills, SL/TP checks and unrealized P&L run on a bar close up to 4 h old; no row or event says so (audit F1) | reorder |
| F1-5 | `exit-trigger.ts:55-72`; `engine-position-mgmt.ts:148` | SL/TP compared against a single point price; `exit_price` is the detection price, not the level | wicks between 5-min polls are missed; realised loss can be far beyond −1R on gaps (the 2026-09-04 −3.27R stop) | reorder |
| F1-6 | `stagnant-exit.ts:168-170` vs `engine-position-mgmt.ts:77` | stagnant `current_r` uses the bar close, SL/TP use the quote | two "current prices" in one decision | reorder |
| F1-7 | `engine.ts:159-165` | `loadOpenPositions` ignores the query error → `[]` | a transient DB error makes the algo look flat → cap check passes → second position on the same ticker (direction conflict only checks other algos) | reorder |
| F1-8 | `engine-process-ticker.ts:104-111`; `entry-open.ts:274-285` | the in-memory placeholder pushed after an open has no `notional_value` | multi-ticker watchlists: `computeMarginUsed` sums `undefined/lev` → `NaN` → `available = NaN` → both margin guards are false → later tickers size unconstrained. Single-ticker algos unaffected | reorder |
| F1-9 | `entry-deterministic-gates.ts` (no bar id); `re-entry-cooldown.ts:105-109` | no act-once-per-bar state; cooldown is loss-only | after a TP close inside a 4h bar the next tick re-evaluates the same closed bar and can re-enter at the quote (audit A10) | reorder |
| F1-10 | `entry.ts:153` → `entry-open.ts:186,211` | `signal_detected` is logged before sizing and insert | sizing `null` or insert failure leaves `signal_detected` with no `position_opened` and no `signal_no_action` | reorder |
| F1-11 | `daily-halt.ts:54-65`, `portfolio-halt.ts:50-62`, `consec-loss-halt.ts:104-113`, `consistency-halt.ts:76-82`, `re-entry-cooldown.ts:85-101`, `entry-gates.ts:56` | every risk gate treats a failed DB read as "no risk" | one DB blip during the ladder disables all account-protection checks for that tick while entries proceed | reorder |
| F1-12 | `prices.ts:120-122` + OANDA open-stamped dailies | the D1 refresh predicate `age(open of last complete daily) > 26 h` is true ~22 h of every 24 h | OANDA D1 is re-fetched on nearly every tick for every algo (5 × 96/day); harmless while OANDA is up, and on fallback a UTC-stamped Twelve Data daily is served in memory to `daily_bias` even though DQ.4 refuses to persist it | reorder |
| F1-13 | `entry-deterministic-gates.ts:216`; `entry-cohort.ts:33` | `time_filter` and the cohort hour use wall-clock `getUTCHours()` at scan time, not the bar's hour | the "bad hour" the filter learns is the cron fire hour (bar close + ≤15 min lag) | reorder |
| F1-14 | `route.ts:181-203` | algos are scanned sequentially inside one request with a Vercel-only `maxDuration` | slow providers push later algos away from the bar close; a timeout drops the rest with no `scan_completed` | restructure |
| F1-15 | `entry.ts:120` + `entry-open.ts:289-293` | `evaluateEntry` discards the resolved side; `openPosition` maps `side:"auto"` to `"long"` | a live auto-side algo with bearish bias would open LONG. Dormant: deployed algos are fixed-side | reorder |

### 3.2 Flow 1′ — the same bar through the backtester, and where the two diverge

```mermaid
sequenceDiagram
    autonumber
    participant L as runPortfolioBacktest timeline (portfolio-backtest.ts:1276)
    participant C as runCloseLoop (:327)
    participant X as pickBacktestExitPrice (prop-firm-backtest.ts:491)
    participant S as closeSimPosition (prop-firm-backtest.ts:89)
    participant P as enforcePropFirm (prop-firm-backtest.ts:248)
    participant E as tryOpenEntry (:791)
    participant K as checkConditions (conditions/evaluate.ts:58)
    participant Z as sizeForBacktest (prop-firm-backtest.ts:369)

    L->>L: dayKey = bar.date.split(/[ T]/)[0]; on change finalizeDay + dailyHalted=false (:1277-1282)
    L->>C: Phase 1 — close loop per active ticker (:1294)
    C->>K: exit_conditions evaluated ONCE per bar (:342-358)
    loop each open position (reverse)
        C->>C: worstAdversePrice; trailing; stagnantFired = checkStagnantExit (:364-397)
        C->>X: gap-open SL → SL at level → TP at level → (signal ‖ stagnant) at close; stop wins ties (:524-537)
        C->>S: closeSimPosition(pos, dayKey, price…) → pnl net of spread×2 + commission; exit_date = dayKey (:120-164)
        S->>S: R-aware streak (never reset across days); dailyPnl[day] (:173-245)
        C->>P: enforcePropFirm → static DD floor, DLL (realized only), kill, entryHaltedToday (:255-301)
    end
    L->>L: Phase 2 — dailyHalted → force-close all at close − slippage (:1299-1316)
    L->>L: FTMO termination (if enabled) → force-close + break (:1323-1339)
    L->>L: portfolio halt (realized-only sibling map) (:1347-1366)
    L->>E: Phase 3 — tryOpenEntry per ticker (:1369-1371)
    E->>E: canEnter: kill / DD / dailyHalted / vetoed / halted / max positions (:837-847)
    E->>E: ATR liquidity → session filter → regime (D1) → ADX (D1) → side (:852-894)
    E->>E: direction conflict → spread ATR-proxy → risk pool (nominal, BEFORE conditions) → cooldown → portfolio-halt block → DXY (:901-958)
    E->>K: entry_conditions — higherTfCloseStamped set here but DROPPED at condition-evaluator.ts:134-141 (:959-972)
    E->>E: market_state_gate AFTER conditions (:976-986)
    E->>E: entryPrice = close ± slippage; SL/TP distances (:987-1014)
    E->>Z: sizeForBacktest(rules, s.equity …) → riskToLots → 0.01-lot floor, 0 → SKIP (:1021-1030; markets.ts:480-488)
    E->>E: margin check on compounding equity; push position (:1031-1057)
```

**Parity — the rows that differ** (full 42-row table in the agent trace; SAME rows omitted here):

| Step | Live | Backtest | Verdict | Tag |
|---|---|---|---|---|
| Bar source | ≤2,000-bar live cache / provider chain | pinned sha-verified 2015→2026 corpus | by design | — |
| Daily-bias alignment | `alignCompletedDailyIndex` on start-stamped OANDA D1 (`patterns/evaluate.ts:251-253`) | same rule on **close-stamped** session bars because `condition-evaluator.ts:134-141` forwards only `{news_events, relevant_currencies}` | one session staler on 2 of 6 bars (audit A6) | reorder |
| Regime / ADX index + order | last fetched D1 bar; order side → conflict → DXY → regime → ADX (`entry-side-and-direction-gates.ts:50-160`) | aligned index; order regime → ADX → side (`:874-894`) | same math, different index and order | reorder |
| News veto | wall-clock Finnhub, fails open (`entry-gates.ts:65-90`) | null when no events passed — `validate-algo.ts` and `e2.22` pass none | live-only in practice | reorder |
| Consec-loss halt | today's UTC closes; **`pnl >= 0` breaks** the streak; 1R from mutable `stop_loss_price` (`consec-loss-halt.ts:100-123`) | streak never reset by `finalizeDay` (`prop-firm-backtest.ts:335-346`); `pnl === 0` neutral; 1R from entry-time `slDistance` (`:215-245`) | duplicated and divergent despite a shared 0.25R constant | reorder |
| Re-entry cooldown | wall-clock from a mid-bar close → up to one extra bar blocked (`re-entry-cooldown.ts:72-147`) | elapsed between consecutive bars = exactly one TF → only the same bar is blocked (`:586-610`) | divergent | reorder |
| time_filter, pair auto-pause, consistency gate, granularity/staleness, 30× sanity, regime routing | live only | absent | LIVE-ONLY | reorder |
| Direction conflict | DB: any other algo's opposite open position (`entry-gates.ts:37-63`) | sibling trade windows, same broker only; **window end is a day key**: `closeSimPosition` writes `exit_date: day` (`prop-firm-backtest.ts:164` ← `portfolio-backtest.ts:414`) while `currentDate` is a full ISO timestamp, so `"…T22:00…" <= "YYYY-MM-DD"` is false and the B.1.18 "inclusive" boundary (`:727,:757`) excludes every bar of the sibling's exit day. The B.1.18 test uses hand-written full-timestamp fixtures (`portfolio-backtest-p1-fixes.test.ts:218-247`) and cannot see it | **new finding, verified**; also hits `hasRiskPoolBreach`. Impact on the deployed long-only baseline is probably nil (no opposite sides; 5 × 0.42 % < the 4 % cap) but unquantified | reorder |
| Spread gate | real bid/ask, mirror only (`entry.ts:146`) | ATR-ratio proxy (`:769-789`) | paper has none | reorder |
| Risk pool | actual `(entry−SL)×qty`, 3 % of per-algo capital, after sizing, mirror only (`entry-open.ts:197-205`) | nominal `capital×risk%`, 4 % of pool capital, before conditions (`:919-924`) | paper has no cap at all | reorder |
| Portfolio / per-algo DLL | realized + unrealized; halt persists as `live_trading_enabled=false` | realized only; auto-resumes next day | divergent | reorder |
| Sizing basis | fixed `algorithms.capital`; **no lot floor**, fractional lots (`helpers.ts:100-132`) | compounding `s.equity`; 0.01-lot floor, below → skip (`:442-445`); broker mirror floors to step then clamps **up** to minVolume (`live-execution.ts:146-151`) | three behaviours (audit A2) | reorder |
| Entry fill | quote at scan time, no friction | signal-bar close + 0.5 bps | audit A5/A11 | reorder |
| Exit order | stagnant → SL → TP → signal (`engine-position-mgmt.ts:86-94`) | gap-SL → SL → TP → (signal ‖ stagnant) (`:524-537`) | stagnant can only pre-empt an SL live; CLAUDE.md's "runs FIRST, preempts SL" is live-only | reorder |
| Exit fill | detection quote past the level; no friction | level ± slippage; gap-open at bar open; spread×2 + commission | divergent | reorder |
| Swap | none | none | both missing (audit A7) | — |
| R-multiple | `(exit−entry)/(entry−initial_SL)`, friction-free (`m1-evidence.ts:94-102`) | baseline `pnl/(equity_at_entry×0.42%)` friction-netted, nominal denominator (`e2.22-layer-b-pinned.ts:507-515`); engine `notional×slDistance/entry` (`:206-208`) | three formulas for one statistic | restructure |
| Day boundary | UTC midnight on `closed_at` (wall clock) | UTC date of the exit bar's **open** (`:1277,:414`) | same zone, different attribution; both differ from FTMO's 00:00 CE(S)T | reorder |
| FTMO static max loss | none in the scan path | `enforcePropFirm` floor + optional termination (`:272-275`, `:1323-1339`) | BACKTEST-ONLY | reorder |
| Exit-reason vocabulary | written: `stop_loss`, `take_profit`, `exit_signal`, `manual`, `stagnant_exit`, `daily_loss_halt`, `portfolio_halt`, `broker_rejected`; the TS union has 5 values, the DB CHECK 6 | `stop_loss_hit`, `take_profit_hit`, `signal_exit`, `stagnant_exit`, `force_close` | two taxonomies, three sources of truth on the live side | restructure |

**Duplicated logic register (the parity root cause):** position sizing (`helpers.ts:38-150` vs `prop-firm-backtest.ts:369-465`, divergent); P&L in USD (`markets.ts:401-423` vs inline `prop-firm-backtest.ts:120-143`); R-multiple ×3; ATR ×2 (`regime-filter.ts:39-66` Wilder vs `market-state.ts:71-80` simple mean, used side by side inside the backtest); consec-loss streak ×2; cooldown duration ×2 (`re-entry-cooldown.ts:34-51` vs `portfolio-backtest.ts:572-581`, different unknown-TF fallback); day key ×6 (`getTodayAnchor` plus three inline `setUTCHours(0,0,0,0)` copies plus two backtest variants); lot conversion ×3 (`entry-open-mirror.ts:18-34`, `live-execution.ts:142-153`, `brokers/sizing.ts:12-23` — round vs floor vs clamp-up); condition-context builders ×4; daily-index alignment ×4 call sites of which 2 ignore the close-stamp flag; the whole per-bar loop ×2 (`portfolio-backtest.ts:1276-1372` vs the dead `backtest-simulation.ts:59-220`). No test asserts any live↔backtest pair is equivalent. Tag: **restructure** (this is the "one engine, two adapters" argument in `MODERNISATION.md`).

**Where the live baseline number came from.** The M1/G.8 band was produced by `scripts/canonical/e2.22-layer-b-pinned.ts MODE=algo-stats`, not by `validate-algo.ts` (the documented "only trusted" path): FTMO termination OFF, news veto OFF, Engulfing25 rules re-enumerated from a search base rather than read from the deployed row (`:457-459`), uniform 0.42 % forced on a $10K `POOL_CAPITAL`, and an R statistic (`pnl/(equity_at_entry×0.42%)`) that is not the one `m1-evidence.ts` computes live. `src/lib/cohort/m1-baseline.ts:64` carries a 2026-07-21 `generated_at`; the on-disk artifact is a 2026-07-30 regeneration with identical numbers.

### 3.3 Flow 2 — startup and initialisation

```mermaid
sequenceDiagram
    autonumber
    participant SD as systemd (VPS)
    participant NX as next start (one node process)
    participant SH as scan-cron.sh
    participant RT as cron route
    participant AU as verifyAdminAuth
    participant AC as createAdminClient (memoised)
    participant DB as Supabase
    participant PC as in-process caches

    SD->>NX: start — next.config.ts is empty; no instrumentation.ts; NOTHING is validated at boot
    Note over NX,PC: rowCopies, memoryCache (bars), calendar cache, sentiment cache, admin client: all empty
    SH->>SH: grep CRON_SECRET from .env.local; exit 1 only if the file/var is missing
    SH->>RT: GET + Bearer (no curl timeout, no lock file)
    RT->>AU: process.env.CRON_SECRET — unset → 500 (fail closed); wrong → 401 (admin-auth.ts:13-26)
    RT->>AC: first call reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY; throws → unhandled 500; else cached for the process lifetime (admin.ts:13-31)
    RT->>DB: algorithms where status='active' [+ user_id = OPERATOR_USER_ID only if the env var is set — unset = UNSCOPED]
    RT->>PC: first bar read warms rowCopies (10-min copy) and memoryCache (1 h); never evicted
    Note over RT: TWELVE_DATA_API_KEY missing → fetchBatchQuotes throws → swallowed → bar-close fills (fail open)
    Note over RT: FINNHUB_API_KEY missing → calendar [] → news veto never fires (fail open)
    Note over RT: src/lib/env.ts (typed, lazy, throws on missing) is imported by NOTHING
```

| Thing | Validated when | Missing / invalid behaviour | Evidence |
|---|---|---|---|
| any env var at boot | never | — | `next.config.ts:1-7`; no `instrumentation.ts` |
| `src/lib/env.ts` typed accessors | would throw on first use | **no importer anywhere** (`grep -rn "lib/env" src scripts` → none); every cron-path module reads `process.env.X` directly | `src/lib/env.ts:17-69` |
| `CRON_SECRET` | per request | 500 `server_misconfigured` (fail closed) | `src/lib/api/admin-auth.ts:13-26` |
| Supabase URL / service key | first `createAdminClient()` | throw outside any try → Next 500 | `admin.ts:13-31`; scan `route.ts:94` |
| `OPERATOR_USER_ID` | per request | silently unscoped in scan + manage ("legacy"); heartbeat, alpha-decay, wfo, reconcile, flatten-algo, evaluate-pairs never scope | scan `route.ts:108-115`; `manage.ts:192-200` |
| `TWELVE_DATA_API_KEY` | per call | throw → swallowed → empty quote map → last 4h close used as the price | `twelve-data.ts:86-89`; `engine.ts:170-176` |
| `FINNHUB_API_KEY` | per call | `console.warn` + `[]` → veto never fires | `economic-calendar.ts:128-132` |
| `OANDA_API_KEY` | per call | falls through the provider chain | `oanda.ts:110-111`; `prices.ts:143-184` |
| `ANTHROPIC_API_KEY` / `GROQ_API_KEY` | per call; clients re-created per call (not memoised) | throw inside an empty `catch {}` → `signal_no_action "LLM call failed"` | `anthropic-client.ts:7-13`; `llm-trader.ts:232-245` |

Tag: **restructure** (one validated config object at the composition root; see `CONVENTIONS.md` once written). Nothing here can be fixed without touching the live path, so it waits for Phase E; Phase B records it.

### 3.4 Flow 3 — the daily reset and the halt path

```mermaid
sequenceDiagram
    autonumber
    participant RT as scan route
    participant PH as portfolio-halt.ts
    participant EN as scanAlgorithm
    participant DH as daily-halt.ts
    participant FL as flatten.ts
    participant GT as gate ladder (per ticker)
    participant DB as Supabase

    Note over RT,DB: there is NO reset job. "Today" is recomputed on every tick as UTC midnight (setUTCHours(0,0,0,0)) — FTMO resets at 00:00 CE(S)T
    RT->>PH: applyPortfolioHalts (route.ts:52-88)
    PH->>DB: paper_positions closed_at ≥ UTC midnight (realized) + open (unrealized) for the portfolio's algos (portfolio-halt.ts:50-62)
    alt tripped (pnl% ≤ −DLL × halt_pct)
        PH->>DB: activity_log 'portfolio_halt' today? — the once-per-day latch IS the log row (:97-111)
        PH->>FL: flattenAlgorithmPositions(algo,'portfolio_halt') per algo
        FL->>DB: UPDATE status='closed', exit_reason='portfolio_halt' — CHECK rejects it; error not read (flatten.ts:109-113)
        FL->>FL: broker closePosition if the row has broker_position_id — ignores live_trading_enabled (flatten.ts:58-68,83-90)
        PH->>DB: algorithms.live_trading_enabled=false; activity_log portfolio_halt per algo (:119-147)
        RT-->>RT: algos stay in the halted set for the rest of the UTC day; cron_idle if all are halted (route.ts:170-178)
    end
    RT->>EN: scanAlgorithm per non-halted algo
    EN->>DH: maybeHaltOnDailyLoss (engine.ts:94 → daily-halt.ts:123-140)
    DH->>DB: same two queries, per algo (daily-halt.ts:54-65)
    alt tripped
        DH->>FL: flatten(algo,'daily_loss_halt') — same CHECK rejection
        DH->>DB: live_trading_enabled=false; activity_log daily_loss_halt
        DH-->>EN: return true → scan returns BEFORE positions are managed and BEFORE scan_completed
        Note over DH: no fired-today guard — re-flattens, re-updates and re-logs every 15 min while today's loss stays past the threshold (only the portfolio path got the E2.25.d latch)
    end
    EN->>DH: maybeWarnOnDailyLoss → 'dll_warning' (rejected by the CHECK → the idempotency lookup never finds it → re-attempted every tick, never persisted)
    EN->>GT: entry ladder per ticker
    GT->>DB: consec-loss: closed_at ≥ UTC midnight, newest 50, R-aware streak → entries only (consec-loss-halt.ts:92-124)
    GT->>DB: cooldown: last close on (algo, ticker); block while elapsed < 1 bar after a loss (re-entry-cooldown.ts:72-147)
    GT->>DB: time_filter: per-hour WR over ALL closed rows (per-hour-stats.ts:58-99)
    GT->>DB: consistency: ALL closed rows, today_net / total_net ≥ pct → entries only (consistency-halt.ts:58-109)
    Note over GT: risk-pool halt lives in entry-open.ts and runs only with brokerCtx — inert in paper mode
```

**Day-boundary definitions (16 sites, all UTC; FTMO is 00:00 CE(S)T on the day-start balance):**

| Site | Boundary |
|---|---|
| `daily-halt.ts:50-52,169-170`; `consec-loss-halt.ts:100-102`; `consistency-halt.ts:72-74` | inline `setUTCHours(0,0,0,0)` copies |
| `utils/date.ts:77-82` `getTodayAnchor` (used by `portfolio-halt.ts:48,101`, `ftmo-compliance-actions.ts:115`) | UTC; its comment says "UTC-anchored matches FTMO's day boundary", which is false |
| `entry-deterministic-gates.ts:216`, `time-of-day-filter.ts:68`, `per-hour-stats.ts:86` | `getUTCHours()` of now / of `opened_at` |
| `llm-trader.ts:109-135` `isBarCloseScan` | UTC wall clock `hour % 4 === 0`, not OANDA's NY-17:00 bar grid |
| `portfolio-backtest.ts:1277-1282,940`; `prop-firm-backtest.ts:182,335-346`; `structural-sl.ts:113-116`; `engine-activity.ts:179`; `price-cache.ts:107`; `economic-calendar.ts:110-112` | `.split(/[ T]/)[0]` / `.slice(0,10)` of the bar **open**; weekend filter Sat or Sun < 20:00 UTC |

**Halt matrix (what each halt decides, persists, does, and how it un-halts):**

| Halt | Decided where | Persisted state | Action | exit_reason / event_type | Un-halt | Idempotent? | Evidence |
|---|---|---|---|---|---|---|---|
| Portfolio DLL (5 %, ×80 %) | route, before any algo | the `portfolio_halt` activity_log row is the latch | flatten all + live flag off + skip algos for the UTC day | `portfolio_halt` (exit_reason rejected by CHECK) | UTC midnight for entries; live flag manual | yes, unless the latch insert fails | `route.ts:52-88`; `portfolio-halt.ts:39-147`; `flatten.ts:41-142` |
| Per-algo DLL | engine, before positions load | nothing but the log row | flatten algo + live flag off + return | `daily_loss_halt` (rejected) | UTC midnight; live flag manual | **no** | `daily-halt.ts:43-140`; `engine.ts:94` |
| DLL warning (40 %) | engine | `dll_warning` row (rejected) | log only | `dll_warning` | — | intended, ineffective | `daily-halt.ts:151-193` |
| Consec-loss (R-aware, 0.25R) | gate step 3 | none | blocks entries | `signal_no_action` | UTC midnight or a win/break-even | n/a | `consec-loss-halt.ts:52,92-124` |
| Re-entry cooldown | step 3b | none | blocks entries | `signal_no_action` | one primary-TF bar after a loss close | n/a | `re-entry-cooldown.ts:49-147` |
| Time-of-day filter | step 4 | none (self-reinforcing) | blocks entries in hours with ≥5 samples and WR < 45 % | `signal_no_action` | only if `window_days` ages samples out (unset = never) | n/a | `time-of-day-filter.ts:52-100`; `per-hour-stats.ts:58-99` |
| Consistency (FTMO 40 %) | step 5 | none | blocks entries | `signal_no_action` | UTC midnight | n/a | `consistency-halt.ts:58-109` |
| Risk pool (combined 3 %) | `openPosition`, after sizing, mirror only | none | refuses entry | `signal_no_action` | immediate | n/a | `entry-open.ts:197-205`; `risk-pool-halt.ts:110-162` |
| Drift halt | post-close analytics, scan path only | live flag off + `drift_halt` | no flatten | `drift_halt` (`drift_warn` rejected) | manual | re-evaluated only on a scan-path close | `engine.ts:231-267`; `drift-detector.ts:197-218` |
| Divergence kill | post-fill, live entry only | live flag off | no flatten | `divergence_halt` | manual | — | `live-execution.ts:164-166`; `divergence.ts:79-101` |
| Max loss 10 % static | **none live**; backtest only | — | — | — | — | — | `prop-firm-backtest.ts:176-181` |

Five writers set `live_trading_enabled=false` (`portfolio-halt.ts:130`, `drift-detector.ts:205`, `divergence.ts:88`, `daily-halt.ts:104`, `alpha-decay.ts:322`); zero code paths set it `true` — only the UI's `updateAlgorithm` can (`validators/algorithm.ts:517`). Tags: F3 latch/idempotency and CHECK items **reorder**; the UTC-vs-CE(S)T boundary **reorder** (changes which trades count toward which day); the six day-key copies **safe-move** into one function once the boundary is decided.

**Self-modifying mechanisms** (the system changing its own configuration or state without an operator):

| # | Mechanism | Trigger | Writes | Reversible | In backtest? | Evidence |
|---|---|---|---|---|---|---|
| S1 | `time_filter` hour ratchet | gate step 4; hour has ≥5 of this algo's closed trades and WR < 45 % | no DB write; blocks the hour, which then accrues no new samples | operator edits rules, or `window_days` (unset = never) | **no** | `time-of-day-filter.ts:52-100`; `per-hour-stats.ts:58-99` |
| S2 | Pair auto-pause | `runPostCloseAnalytics` after a **scan-path** close only (manage-path closes never trigger it); ≥8 trades and WR ≤ 30 % | `algorithm_watchlist.auto_paused=true,…`; `pair_auto_paused` event | UI `resumeWatchlistItem` only; never auto-resumes | no | `engine.ts:142-144,236-246`; `pair-quality.ts:24-27,154-197` |
| S2′ | effect of S2 on a single-ticker algo | ticker filtered at `engine.ts:85` → `tickers.length === 0` → return **before** `scan_started`/`scan_completed`/`last_scanned_at`; no `cron_idle` (route emits it only when `algos.length === 0`) | silence; heartbeat flags `scan_overdue` after 90 min | — | — | `engine.ts:85-92`; heartbeat `route.ts:33` |
| S2″ | `GET /api/admin/evaluate-pairs` | admin call; docstring says "report which pairs **would** be auto-paused" | **mutates** `auto_paused` (calls `evaluateAndPrune`) | — | — | `evaluate-pairs/route.ts:2-3,31` |
| S3 | Drift detector halt / warn | scan-path close; last 25 trades vs `backtest_results` | live flag off + `drift_halt` | manual | no | `drift-detector.ts:61-218`; `engine.ts:247-266` |
| S3′ | — inert | `validate-algo.ts` persists a `GateResults` object with no top-level `win_rate`/`total_return`; the detector reads exactly those → `wrDrop = NaN`, sign-flip never fires; only the `rules.drift.min_live_wr_pct` floor can halt | | | | `validate-algo.ts:220-246,1228-1231`; `drift-detector.ts:72-77,118-119` |
| S4 | Alpha-decay auto-pause | 6-hourly cron | `algorithms.status='paused'`, live flag off, `alpha_decay_pause` | UI status change | n/a | `alpha-decay.ts:298-348` |
| S4′ | — inert | it reads top-level `backtest_results.sharpe_ratio`; validate-algo nests it at `statistical_rigor.sharpe_ratio` → `no_baseline` for every algo (audit F12) | | | | `alpha-decay.ts:176-182,242-244`; `validate-algo.ts:238,290-294` |
| S5 | WFO rules update | monthly cron, `?dry_run=0` only; reads the 2,000-bar capped **live** `price_cache` row, not pinned data | `algorithms.rules = proposed_rules` — no Zod, no `clampRules`, no `algorithm_rule_changes` row; `wfo_rules_updated` event with before/after | rebuild from the event's `before_geometry` | n/a | `walk-forward-opt.ts:380-397,483-507`; `wfo/route.ts:47-51` |
| S6 | Regime routing | every `openPosition` when `rules.regime_routing.enabled` | no rules persisted; entry geometry/sizing differ from the stored rules; `regime_route_switched` event | disable the rule | **no** | `entry-open.ts:135-161`; `regime-routing.ts:53-136` |
| S7 | Validate page "apply cell" | operator click | `algorithms.rules` via `cloneWithAxes` — no Zod, no clampRules, no audit row | re-apply | — | `validate/actions.ts:219-257` |
| S8 | `clampRules` on every UI save | `updateAlgorithm` with `rules` | silently rewrites: exit conditions truncated to 2, RSI 40→45 for long horizons, SL/TP <1 ×100, `news_veto` defaulted on, `daily_loss_halt_pct` 80, TP forced ≥ 3×SL for percentage rules | none (re-applied each save) | n/a | `actions.ts:56-61,96-103`; `rules-post-process.ts:33-139` |
| S9 | `price_cache` write-through from read paths | any read whose tail is older than one bar | upsert merged row (DQ.3/DQ.4 filters, 2,000-bar cap); `rowCopies` written **before** the DB round-trip; DB error only `console.warn` | — | — | `prices.ts:93-97,120-126`; `price-cache.ts:282-402` |

Ratchets: `live_trading_enabled` and `auto_paused` are one-way in code; a blocked hour cannot collect the samples that would clear it; the whole five-algo single-ticker portfolio can go dark through S2 with no activity rows at all (the only external signal is the heartbeat's `scan_overdue`, and the heartbeat wrapper withholds its dead-man ping on `stale_count ≠ 0`). Tags: S2″ **safe-rename** (the route is not a report; rename or make it read-only); S3′/S4′ **restructure** (one persisted `backtest_results` contract — three incompatible TS shapes cast over one JSONB column, `types/algorithm.ts:725-732`, `criteria.ts:58-79`, `GateResults`); the rest **reorder**.

### 3.5 Side effects in surprising places (consolidated)

| Location | What it does | Why it surprises |
|---|---|---|
| `price-cache.ts:215-261` `getCachedPrices` | writes the module-level `rowCopies` map on every DB read | a getter mutates process state that later decides the merge base for writes |
| `savePricesToCache` called from inside read paths at six sites (`prices.ts:96,126`; `engine.ts:189,212`; `entry-gates.ts:109`; `manage.ts:88`) | DB upsert, fire-and-forget, `.catch(() => {})` | every bar read can produce a `price_cache` write; failures are invisible |
| `entry-gates.ts:65-90` `checkNewsVeto` | outbound Finnhub call + env read + cache write | a "check" is a network call that fails open |
| `entry-gates.ts:97-125` `computeLiveMarketState` | fetches 1h bars and persists them | a "compute" writes the cache |
| `entry-deterministic-gates.ts:212` → `per-hour-stats.ts:58-99`; `consistency-halt.ts:76-80` | read ALL closed rows of the algo on every ticker of every tick | unbounded reads inside gates |
| `entry-open.ts:137-161` | logs `regime_route_switched` before sizing/insert | the event claims a switch even if the entry then fails |
| `entry-cohort.ts:60-76` `buildEntryReason` | Zod `parse` can throw | a "build" aborts the ticker after `signal_detected` was logged |
| `pair-quality.ts:156-199` `evaluateAndPrune`; `evaluate-pairs` route | mutate `algorithm_watchlist` | "evaluate" permanently removes a ticker from scanning |
| `drift-detector.ts:197-219` `executeDriftHalt` | raw `activity_log` insert without error check | bypasses `logActivity` |
| `flatten.ts:46-68` | re-reads broker credentials independently of `resolveBrokerContext` | will call the broker with the live flag OFF if a row carries `broker_position_id` |
| `helpers.ts:180-210` `logActivity` | swallows every insert error (console only) | the four CHECK-rejected event types vanish on every emission |
| `calculatePositionSize` (`helpers.ts:38-150`) | pure | the one function on this path that is what its name says |

Tag: **safe-rename** for the misnamed ones (check/compute/evaluate that write), **restructure** for moving I/O to the edges.

### 3.6 Module-level and process-level state

| State | File:line | Lifetime | Reset by |
|---|---|---|---|
| `cached` service-role Supabase client | `supabase/admin.ts:13` | process | never |
| `rowCopies: Map` — price_cache row copies, up to 2,000 bars each, never deleted | `market-data/price-cache.ts:198` | process | `_resetPriceCacheRowCopiesForTests()` |
| `memoryCache: Map` — provider bars (1 h) | `market-data/prices.ts:27` | process | never |
| `memoryCache: Map` — Finnhub events (1 h) | `market-data/economic-calendar.ts:108` | process | never |
| `cache: Map` — Alpha Vantage sentiment (1 h) | `market-data/news-sentiment.ts:46` | process | never |
| `let activeCurrency`, `let conversionRate` — mutated by `setActiveCurrency`; **shared across requests on the server** | `utils/pnl.ts:6-7` | process / tab | next call |
| `let cachedRoot` protobuf root | `brokers/ctrader/proto/loader.ts:15` | process | never |
| `let instance` browser Supabase client | `supabase/client.ts:4` | tab | never |
| AI clients | `ai/anthropic-client.ts:7-13`, `ai/client.ts:3-9` | **not** memoised — new SDK instance per call | — |

Interaction worth knowing: `getCachedPrices` applies the TTL against `rowCopies.fetchedAtMs`, and `savePricesToCache` stamps `fetchedAt = now` even when the merged bars came from the in-memory `memoryCache` without a provider call, so a cache-TTL expiry can be "refreshed" with up-to-1-h-old bars (`prices.ts:53-57,94-97`). Tag: **restructure** (state at the edges; inject clocks and caches).

---

## 4. Docs-vs-code name drift (what a fresh session would be misled by)

| # | Document says | Code says |
|---|---|---|
| 1 | `docs/PROJECT_CONTEXT.md:372` (the former CLAUDE.md) `scan/entry.ts:checkDirectionConflict` | defined in `src/lib/scan/entry-gates.ts:37` |
| 2 | `docs/PROJECT_CONTEXT.md:301` newest CHECK migration is 00049 | `00050_alpha_decay_tick_event.sql` replaces it (adds `alpha_decay_tick`); draft PR #291 carries 00053 |
| 3 | `docs/PROJECT_CONTEXT.md:156` hooks list includes `use-live-signal`; `:158` two stores | no such hook; 31 hooks exist, 23 unlisted; 6 stores |
| 4 | `docs/PROJECT_CONTEXT.md:321` puts `filterIncomingBars` and `MAX_BARS_PER_ROW` under `prices.ts` | both live in `price-cache.ts:80` and `:176` |
| 5 | `docs/PROJECT_CONTEXT.md:352` stagnant `max_bars` "clamped 6-48" | `clamp(round(expected_bars × 0.5), 2, 12)` (`stagnant-exit.ts:21`) |
| 6 | `docs/PROJECT_CONTEXT.md:382` "Six other `runPortfolioBacktest` callers" | also `algo-search/per-regime-sweep.ts`, `algo-search/walk-forward-opt.ts` (the live WFO cron) and 25 `scripts/canonical` files |
| 7 | `CLAUDE.md` "Current tables" (13) | migrations also create `portfolios`, `backtest_trades`, `algorithm_geometry_sweeps`, `algorithm_rule_changes`, `llm_decisions_archive`, `activity_log_archive` |
| 8 | `CLAUDE.md` cron list (8 wrappers); `scripts/README.md:124-137` table (14 rows) | 15 wrappers exist; `reconcile-broker-positions-cron.sh` is in neither; three listed crons are not installed on the VPS (audit) |
| 9 | `CLAUDE.md` routes list | undocumented: `/api/cron/cleanup-caches`, `/api/cron/reconcile-broker-positions`, `/api/admin/{check-drift,ctrader-test,evaluate-pairs,flatten-algo,inspect-backtest,loser-analysis,readiness-check,walk-forward}` |
| 10 | `CLAUDE.md` "`exit_reason` is the source of truth for … stagnant cut"; `engine-position-mgmt.ts:87` comment "matches the ExitReason type union" | the engine writes `stagnant_exit`; the union has `stagnant_no_excursion`; the DB CHECK has neither `stagnant_exit` nor the halt reasons |
| 11 | `market-data/types.ts:19` "mirrors paper_positions.exit_reason" | `stop_loss_hit`/`take_profit_hit`/`signal_exit`/`force_close` vs live `stop_loss`/`take_profit`/`exit_signal` |
| 12 | `constants/algorithm.ts:97` `EXIT_REASON_LABELS` | 4 of 8 written values |
| 13 | `types/activity.ts` `ActivityEventType` | lacks `alpha_decay_tick`; code emits four types in no CHECK (`drift_warn`, `dll_warning`, `broker_realized_synced`, `live_order_close_failed`); `drift-summary.ts:222` queries `drift_warn`, which cannot be stored |
| 14 | `scripts/README.md:429` and `scan/manage.ts:41` cite `scripts/reconcile-broker-close.ts`; `performance/strategy-matrix.ts:7` cites `scripts/backfill-backtest-results.ts` | neither file exists |
| 15 | `CLAUDE.md` keeps the Groq client "because … combinatorial-search template selector" uses it | `strategies/selector.ts` + `templates.ts` have zero importers; the grid search uses its own `grid-templates.ts` |
| 16 | `CLAUDE.md` "`backtest-engine.ts` simpler positions … preserve legacy 'any loss counts'" (consec-loss section) | `backtest-engine.ts` is unreachable |
| 17 | `CLAUDE.md` glossary: `symbol` only inside `lib/brokers/*`; `algo` never in a type | 265 `symbol` occurrences outside; 22 `Algo*` exported types + route, hooks, components, directory |
| 18 | `CLAUDE.md` "`src/lib/validators/` (algorithm, trade, journal, position)" | also `trading-profile.ts`, zero importers |
| 19 | `docs/PROJECT_CONTEXT.md:196` `scripts/llm-trader-backtest.ts` + `scripts/llm-trader-walk-forward.ts` | live only under `scripts/archive/2026-06-18/` |
| 20 | `CLAUDE.md` "`LLM_MONTHLY_BUDGET_USD` … hard process-exit" | implemented only in the archived harness; no enforcement in `src/` (audit F7) |
| 21 | `CLAUDE.md` "Stagnant Exit … Runs FIRST in `manageExistingPosition` so it preempts SL hits" | true live only; the backtest lets SL/TP win over stagnant (`prop-firm-backtest.ts:524-537`) |
| 22 | `CLAUDE.md` "the engine owns exits" | the LLM path honours `exit` and `move_be` (`entry-llm-trader.ts:124-129`) |
| 23 | `scripts/README.md` opens with "Production cron runs on the operator's local macOS machine" | production is the VPS since 2026-08-27 (`scripts/README.md:349`) |
| 24 | `README.md` | onboarding wizard (deleted PR #269), Twelve Data as primary bars, Mac cron, "AI-powered autopilot" |
| 25 | `utils/date.ts:70-75` "UTC-anchored matches FTMO's day boundary" | FTMO resets at 00:00 CE(S)T (audit A16) |
| 26 | `scan-active-algorithms/route.ts:2-4` "scan every active + live-trading-enabled algorithm … Vercel Cron" | the query filters on `status='active'` only; there is no Vercel |
| 27 | `ROADMAP.md:306,581,644,664` name `multi-account-backtest.ts`, `scripts/canonical/cycles/`, `stats/factor-orthogonality.ts`, `cohort/drawdown-attribution.ts` as deliverables | none exist; planned vs built is not marked |
| 28 | `ROADMAP.md:1181` `alignCompletedBucketIndex`; `:760` `maxDailyDrawdownPct` | nearest code: `alignCompletedDailyIndex` (`resample.ts:134`), `combinedDailyDrawdownPct` (`portfolio-composer.ts:237`) |
| 29 | `engine-position-mgmt.ts` / `CLAUDE.md` "Twelve Data (fallback)" | Twelve Data is the **primary and only** source of live fill quotes (`engine.ts:13,99`); it is a fallback only for bars |
| 30 | `m1-tab.tsx:62` "n=843" literal; `m1-baseline.ts:64` `generated_at` 2026-07-21 | the artifact on disk is a 2026-07-30 regeneration; the JSX literal duplicates the constant |

---

## 5. Finding index by tag

| Tag | Count | Where |
|---|---|---|
| safe-rename | ≈ 95 rows (§1.2 file map 48, §1.3 symbol map 47) | names only; batchable in pure-move PRs once the audit verdict is in |
| safe-move | ≈ 45 rows (§1.2) + 8 type moves (§2.4) + 4 test relocations (§2.3) | paths only |
| reorder | 15 Flow-1 hazards (§3.1), 19 parity rows (§3.2), halt latch + UTC boundary (§3.4), 14 self-modifying rows (§3.4) | each needs a characterisation test before it changes |
| restructure | 24 rows across §1.2/§1.3, 19 files in §2.2, the duplicated-logic register (§3.2), startup config (§3.3), the three-shape `backtest_results` contract (§3.4), state at the edges (§3.6) | Phase E, after the audit verdict |

The two findings that would change the most behaviour if fixed, and therefore must not be touched before the audit verdict: (i) the exit-reason/event-type contract (TS union ≠ engine ≠ DB CHECK) and (ii) the live↔backtest duplicated logic (sizing, fills, halts, cooldown, alignment).

---

## 6. What was not checked

- Nothing was executed against the live system: no DB queries, no VPS, no broker or provider calls. Whether the DB CHECK constraints were widened out-of-band is inferred from migrations (the audit confirmed them by SQL on 2026-10-28).
- `src/components/**` and `src/hooks/**` bodies beyond the cycle files, `search-tab.tsx` and the duplication pairs; frontend naming beyond `algo-*` files is unaudited (the audit's `05-frontend.md` covers behaviour).
- `scripts/archive/**` (≈20k lines) and `scripts/canonical/*.md` content.
- The LLM-trader path internals beyond the cited touchpoints (`exit`/`move_be`, throttle, budget); pattern detectors beyond `daily-bias`; trailing-stop, regime-routing, vol-target and conviction sizing branches at runtime (deployed algos use none of them).
- Numerical impact of the sibling-window day-key bug (§3.2) and of the consec-loss / cooldown divergences on the 843-trade baseline — only that the comparisons are wrong by construction.
- `database.types.ts` against the migrations (it is nine migrations stale; what changed is not enumerated).
- Mermaid diagrams were not rendered.
