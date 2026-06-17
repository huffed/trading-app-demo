@AGENTS.md

# QuantTrader

A **personal autonomous trading system** for a single operator (not a SaaS — no users planned). An LLM (Anthropic Haiku) makes per-bar discretionary entry decisions; a deterministic engine handles everything enforceable — SL/TP geometry, gates, halts, sizing, broker mirroring. Goal: pass FTMO challenges and scale to multiple funded accounts. Current library: gold + USD/JPY + EUR/USD + GBP/USD.

## Product Vision (updated 2026-06-10)

- **Core division of labor:** the LLM picks entries; the engine owns exits, risk, and execution. Every dataset endorses this split — LLM mid-trade exits cost ~−24% R vs mechanical SL/TP.
- **The learning loop is the spine** (see `project_roadmap_2026_06` in operator memory): per-trade cohort attribution → weekly cohort report → $0 replay screens → ≤1 paid walk-forward confirmation/month (pre-registered + recency window) → shadow-then-enforce engine gates → live paper feeds back.
- **Current focus:** gold 4h `v2` prompt is the validated LLM-trader baseline; condition-based library algos (FVG-DailyBias, Coil-Breakout, Dip-Buyer, OTE-Long, sweep_reclaim-DailyBias) cover the 4h-and-up bands across forex majors. 30m re-entry sits as a sequenced future bundle. Multi-instrument is the endpoint — gold stays in the mix permanently.
- **Budget reality:** ≤£150/month total. Development defaults to $0 (replay screens over recorded trades, Groq free tier for plumbing). The harness enforces `LLM_MONTHLY_BUDGET_USD` (default $25) with a hard process-exit.
- **Our app is NOT a broker.** It's a controller that executes on connected brokers (MetaApi MT5 primary; cTrader Open API dormant by design, kept as the MT5 alternative).
- **Dormant-by-design surfaces (updated 2026-06-17 PR #269):** chat-creates-algorithm, onboarding wizard, and algorithm generate wizards were DELETED in PR #269 — the personal-operator workflow doesn't need them (algos deploy via `scripts/deploy-*.ts`). **Still dormant-by-design and not to be deleted/extended:** journal pages + components, trades page + CSV import, stocks scaffolding, cTrader Open API (see [[feedback_keep_ctrader]] — operator has corrected this twice). The Groq SDK + `src/lib/ai/client.ts` stay because journal analysis + combinatorial-search template selector + LLM-trader fallback still use them.

## Commands

```bash
pnpm dev         # Start dev server (http://localhost:3000)
pnpm build       # Production build (run before committing)
pnpm lint        # ESLint (0 errors required; warnings inherited from baseline)
pnpm format      # Prettier all source files
pnpm test        # Vitest suite
```

Add shadcn components: `pnpm dlx shadcn@latest add <name>`

**Package manager: pnpm.** Do not use npm or yarn.

## Git Workflow

- **Repo:** https://github.com/huffed/trading-app-demo
- **Main branch:** `main` — production-ready code
- **Integration branch:** `dev` — merge feature branches here via PR
- Do not include `Co-Authored-By` lines in commit messages
- Always run `pnpm build` and `pnpm lint` before committing

All work happens on feature branches off `dev` (`feat/<short-description>`). Aim for PRs under ~500 lines; split larger work sequentially.

```bash
git checkout dev && git pull
git checkout -b feat/my-feature
# ...
pnpm build && pnpm lint
git push -u origin feat/my-feature
gh pr create --base dev
```

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | Next.js (App Router, `src/` dir) | 16 |
| React | React | 19 |
| Language | TypeScript (strict) | 5 |
| Styling | Tailwind CSS (oklch CSS variables in `globals.css`) | 4 |
| UI Components | shadcn/ui **base-nova** style (wraps `@base-ui/react`, NOT Radix) | 4 |
| Icons | lucide-react | - |
| Backend/Auth | Supabase (`@supabase/ssr`) | - |
| Server State | TanStack React Query | 5 |
| Client State | Zustand | 5 |
| Validation | Zod | 4 |
| LLM (trading brain) | Anthropic SDK (`@anthropic-ai/sdk`) — claude-haiku-4-5, per-bar LLM-trader decisions (live + backtest harness) | - |
| LLM (utility) | Groq SDK (`groq-sdk`) — llama-3.3-70b-versatile, used by journal/analyze + strategies/selector + LLM-trader fallback | - |
| Market Data | OANDA (prices + positioning), Twelve Data (fallback), Yahoo Finance (fallback), Alpha Vantage (news), Finnhub (calendar) | - |
| CSV Parsing | PapaParse | 5 |
| Charts | Recharts | 3 |
| Theme | next-themes (dark mode default) | - |

## Critical: shadcn/ui v4 Uses Base UI, Not Radix

This project uses **shadcn/ui base-nova style** which wraps `@base-ui/react`, NOT `@radix-ui`. The composition API is different:

```tsx
// CORRECT - Base UI render prop
<Button render={<Link href="/foo" />}>Click me</Button>
<SheetTrigger render={<Button variant="ghost" />}>Open</SheetTrigger>
<DropdownMenuTrigger render={<Button />}>Menu</DropdownMenuTrigger>

// WRONG - Radix asChild pattern (does NOT work)
<Button asChild><Link href="/foo">Click me</Link></Button>
```

Always check the actual component source in `src/components/ui/` before assuming any API.

## Project Structure (top-level)

```
src/
├── app/
│   ├── layout.tsx              # Root layout
│   ├── (auth)/                 # Route group: login, signup, callback
│   └── (dashboard)/            # Route group: all authenticated pages
│       ├── layout.tsx          # Sidebar + Topbar shell (server)
│       ├── algorithms/         # Library deploys (no AI generate UI; via scripts)
│       ├── reports/            # /reports — engine activity + cohort tables (PR #270)
│       ├── analytics/          # Aggregate stats over closed positions
│       ├── settings/           # Profile, brokers, currency
│       └── api/                # Cron + admin routes (no public chat/generate)
├── components/
│   ├── ui/                     # shadcn primitives (generated via CLI; do not hand-edit)
│   ├── layout/                 # Sidebar, topbar, mobile-nav, theme-toggle, user-menu
│   ├── algorithms/             # Cards, strategy-card, rules display, edit, numeric-override
│   ├── onboarding/             # tour-overlay + tour-provider (wizard files removed PR #269)
│   └── shared/                 # Cross-cutting reusable components
├── lib/
│   ├── ai/                     # client.ts (Groq), anthropic-client.ts, prompts/{journal,signal}
│   ├── algorithm/              # Gates (intraday-atr, spread, stagnant-exit, bar-staleness,
│   │                           #   live-price-drift, re-entry-cooldown), structural-sl,
│   │                           #   conviction-sizing, dxy-filter, rules-post-process,
│   │                           #   combinatorial-search/*
│   ├── brokers/                # types, registry, metaapi/metaapi-mt5 (primary),
│   │                           #   ctrader-openapi + ctrader/* (dormant alternative)
│   ├── cohort/                 # engine-activity.ts — shared by /reports + cohort-report CLI
│   ├── constants/              # algorithm, markets, journal, prop-firm, nav
│   ├── market-data/            # prices (fallback chain), oanda, indicators, regime/adx
│   │                           #   filters, backtest-engine, walk-forward, prop-firm-backtest
│   ├── patterns/               # ICT/SMC detectors (FVG, IFVG, sweep, BOS, OB, daily-bias)
│   ├── scan/                   # engine, manage, entry, llm-trader + prompts + audit,
│   │                           #   live-execution, broker-truth-sync, halts (daily,
│   │                           #   consec-loss, consistency, portfolio, risk-pool),
│   │                           #   drift-detector, divergence, flatten, helpers
│   ├── signals/evaluate-live   # LLM-powered live signal evaluation
│   ├── strategies/selector     # Combinatorial-search template selection (uses Groq)
│   ├── supabase/               # client.ts (browser), server.ts, middleware.ts
│   ├── utils/parse-trade-csv   # Trading 212 CSV parser (dormant)
│   ├── utils/pnl               # Display-currency aware formatting
│   └── validators/             # Zod schemas (algorithm, trade, journal, position)
├── hooks/                      # use-algorithms, use-strategies, use-engine-activity,
│                               #   use-trades, use-journal, use-watchlist, use-live-signal,
│                               #   use-dashboard-stats
├── stores/                     # Zustand (ui-store, onboarding-store)
└── types/                      # algorithm.ts (Strategy + Algorithm), position, trade, journal
middleware.ts                   # Auth redirects (whitelist must include any new protected route)
supabase/migrations/            # SQL migrations (apply manually)
scripts/                        # Deploy/sweep/replay scripts + cohort-report CLI
```

For an authoritative listing, `ls` the directory. This index is intentionally partial — names that shift frequently (component variants, gate files) shouldn't be enumerated here.

## Strategies Umbrella

Algorithms are grouped under shared **strategies** (PRs #266 + #267 + #270). Each algorithm belongs to one strategy via `algorithms.strategy_id`. Strategies hold a `rules_template` JSONB; algorithm-specific overrides live in `algorithms.rules`.

- **A1+A2 (DONE):** schema + seed — 7 strategies, 16 algos linked.
- **A3 (DEFERRED):** scan-engine `effective_rules = deepMerge(strategy.rules_template, algorithm.rules)` — risky on live trading paths (Coil-1h + Dip-Buyer are LIVE). Live trading + manage cron still read `algorithms.rules` directly.
- **A4 (DONE):** `/algorithms` page groups by strategy via `StrategyCard`. Default = collapsed; toggle for flat view. `src/components/algorithms/strategy-card.tsx`, `src/hooks/use-strategies.ts`.

## Algorithm Conditions (condensed)

Library algos (the deployed ones) use a discriminated union for entry/exit conditions: `TechnicalCondition` (RSI/SMA/EMA/MACD/BB), `PatternCondition` (ICT/SMC: FVG, IFVG, sweep, BOS, OB, daily_bias), `SentimentCondition` (Alpha Vantage news, filtered out in backtest). Full types in `src/types/algorithm.ts` + Zod schema in `src/lib/validators/algorithm.ts`.

- **Logic combinator:** `entry_logic` = `"all"` | `"any"` | `{ type: "n_of_m", n }`.
- **Legacy normalization:** conditions without a `type` field auto-normalize to `"technical"` at parse time (Zod preprocess) + backtest engine (safety net).
- **`value: 0` semantics:** when a technical condition has `value: 0` on a price-MA indicator (SMA/EMA/BB), the engine compares **indicator vs price**, not vs 0. Special case: EMA12 vs 0 compares against EMA26 (standard MACD).
- **Backtest:** technical + pattern conditions are testable; sentiment is filtered out (`backtest_mode: "technical_only"`).

## LLM-Trader (the live trading core)

When `rules.llm_trader.enabled`, the scan skips condition evaluation and, on each primary-TF bar close, sends chart context (recent bars, D1 regime, SMA/momentum, DXY proxy, optional higher-TF lines) to Anthropic Haiku, which returns `enter_long | enter_short | hold | exit | move_be` as JSON.

- **Prompts** live in `src/lib/scan/llm-trader-prompts.ts` — versions `v1`-`v5_15m` + `v2_generic`/`v2_mtf`. Selected per-algo via `rules.llm_trader.prompt_version`. Prompt text is **validated-baseline material**: never edit a version in place; add a new version and take it through the confirmation pipeline. Capability flags (e.g. multi-TF override) live in `PROMPT_HAS_MTF_OVERRIDE: Record<PromptVersion, boolean>` — the compiler forces new versions to declare them; never hardcode version lists in gates.
- **Division of labor:** the LLM picks entries; the **engine owns exits** (SL/TP via `structural-sl.ts`, stagnant cut, halts). Measured 2026-06-10 (PR #178 replay, n=299): honoring LLM mid-trade exits cost ~24% of total R.
- **Every decision is audited** to the `llm_decisions` table (context, decision, confidence, reasoning, linked position, outcome backfilled on close) — surfaced on the algorithm detail page + the `/reports` engine-activity table.
- **Defensive gates run before the LLM call when flat** (dead-hour, ATR liquidity, news veto, consec-loss halt) and are **skipped in-position** so the LLM can manage an open trade (2026-05-11 incident). The RANGING hard block consults the prompt-capability registry.
- **`live_trading_enabled` gates ONLY broker mirroring — NOT the scan or the LLM call.** A `status='active'` algo with the flag off still scans, spends API tokens (~$0.003/call), and opens PAPER positions. Zero-spend idle requires `status='paused'`.

### Validation economics (the harness)

`scripts/llm-trader-backtest.ts` + `scripts/llm-trader-walk-forward.ts` replay history with real Anthropic calls. Hard-won rules, enforced in code:

- **`SL_PRESET=baseline|live|comboC`** pins the full SL/TP geometry; omitting it runs harness defaults (pct 1.5%/4.5%) which are NOT the live config — the header warns loudly. Resolved geometry is echoed in the header + summary JSON.
- **`REPLAY_CACHE=1`** memoises responses on disk — re-running an unchanged config costs $0. Default OFF so variance reps stay independent.
- **Rate limiter + jittered backoff** (`LLM_RPM`/`LLM_TPM`/`LLM_MAX_ATTEMPTS`) — the 2026-05-18 cascade wasted ~67% of a sweep before these existed.
- **`LLM_MONTHLY_BUDGET_USD` (default $25)** — per-month spend ledger; the process exits before exceeding it. The £150/month ceiling is structural, not advisory.
- **Confirmation protocol:** screen candidates at $0 first (replay recorded entries through variant mechanics), then ONE paid A/B confirmation with pre-registered criteria including a **recency window ending run-day** (standard grid stops at 2026-04-30).

## Pre-deploy validation (canonical 4-way for library algos)

Applies to **every condition-based library algo** — both new deploys AND retroactive revalidation of existing deployed algos. Established 2026-06-16 (PRs #258 + #259) after FVG-DailyBias-Long 4h surfaced an rr=3 vs rr=2 geometry mismatch single-backtest validation would have missed. Cost: $0 per pass (replay over recorded corpus, no LLM calls).

**The 4 validations — all MANDATORY before `APPLY=1` on any deploy or geometry change:**

1. **Friction test** — re-run with realistic costs. For gold: `FRICTION_SLIPPAGE_BPS=0.5 FRICTION_SPREAD_BPS=0.4`. If returns degrade >5% from frictionless, the frictionless baseline shouldn't be the ship signal.
2. **Cadence comparison** — when applicable, run on 1h and 30m via `TIMEFRAME=1h` / `TIMEFRAME=30m` in `scripts/library-walk-forward.ts`. Surfaces sister-cadence candidates AND confirms 4h is the right primary.
3. **Per-window decomp** — `PER_WINDOW=1 pnpm dlx tsx scripts/library-walk-forward.ts ONLY=<candidate>` writes per-window detail into summary JSON. Aggregate stats hide chop-year disasters (e.g. 57% overall green could be 71% ex-2021 + 17% in 2021).
4. **RR × lookback geometry grid** — `pnpm dlx tsx scripts/sweep-algo-geometry.ts` runs `rr_multiple ∈ {2, 3, 5}` × `sl_lookback ∈ {3, 4, 6}` = 9 cells with per-year decomp. Monotonic improvement across RR is structural, not noise.

**Hard rules:**

- **The sister-algo `rr=3` convention is NOT a default.** Each algo's RR validates per-algo via the grid. Coil-1h and Dip-Buyer happen to be rr=3-best; FVG-DailyBias-Long 4h and Coil-Breakout 4h are rr=2-best. Don't pattern-match — verify.
- **The "chop-rescue mechanism" is real.** rr=2 specifically rescues sideways/distribution regimes because price reverses within 2R before completing 3R. When per-year decomp shows rr=2 turning a chop-year loss into profit, that's the signal.
- **Don't change live geometry on backtest alone.** Per [[feedback_iterate_only_validated_baselines]], live algos require an A/B paper variant alongside live for ~30 days before flipping. The update script (`scripts/update-library-geometry-*.ts`) MUST refuse `live_trading_enabled=true` targets.
- **Generalize, don't fork.** The sweep script `scripts/sweep-algo-geometry.ts` has a TARGETS list; add a new target rather than forking. Deploy/update scripts follow `scripts/deploy-<algo>-<tf>.ts` and `scripts/update-library-geometry-<date>.ts` patterns.
- **Persist `backtest_results` on deploy.** Walk-forward gives total_return + total_trades + worst_dd per candidate; the deploy script MUST write these to `algorithms.backtest_results` on insert (rescaled to the algo's `capital` — walk-forwards run at $100K and most algos deploy at $10K; R-per-trade is scale-invariant so the rescale just keeps the stored $ aligned with the algo's account size). Without this, the `/reports` Promotion Eligibility tab can't compute realized-vs-backtest variance and the live-mirror milestone falls back to manual verification. Existing rows backfilled via `scripts/backfill-backtest-results.ts` (2026-06-17).

**Layers this does NOT replace:**
- 10% DD hard gate per [[feedback_dd_validation_gate]] — any sweep cell with worst DD > 5% on a window is disqualified.
- Direction-split per [[feedback_direction_split_first]] — bullish and bearish are independent validations.
- Friend-replay direction-of-development signal per [[project_friend_replay_2026_06]] — supplementary, not substitute.

**Reports** live at `scripts/REVALIDATION_REPORT_<date>.md` and get linked from PR bodies.

## Conventions

### File naming
- Components: `kebab-case.tsx` (e.g., `strategy-card.tsx`)
- Exports: PascalCase (e.g., `StrategyCard`)
- Hooks: `use-[name].ts` exporting `use[Name]`
- Stores: `[name]-store.ts` exporting `use[Name]Store`
- Validators: `[entity].ts` in `lib/validators/`

### Component organization
- `components/ui/` — shadcn primitives only. Add via CLI; avoid hand-edits.
- `components/layout/` — App shell (sidebar, topbar, etc.)
- `components/[feature]/` — Feature-specific (algorithms, journal, trades, etc.)
- `components/shared/` — Reusable cross-cutting

### Client vs server components
- Default to server. Add `"use client"` only when needed (hooks, state, event handlers).
- `(dashboard)/layout.tsx` is a server component — calls `supabase.auth.getUser()` and redirects.

### State management
- **TanStack Query** for all server/async state.
- **Zustand** only for ephemeral client UI state.
- Never put server data in Zustand. Never use TanStack Query for pure UI state.

### Styling
- Tailwind utility classes only. No CSS modules.
- Colors via oklch CSS variables in `globals.css`.
- `cn()` from `@/lib/utils` for conditional class merging.
- Trading-specific colors: `--profit` / `--loss`.
- Dark-mode-first; test both modes.

### Supabase auth
- Use `getUser()`, **never** `getSession()` for server-side checks.
- Browser: `import { createClient } from "@/lib/supabase/client"`
- Server: `import { createClient } from "@/lib/supabase/server"`

### Import alias
All imports use `@/*` → `./src/*`.

## Environment Variables

Required in `.env.local`:
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
GROQ_API_KEY=                  # server-only
ALPHA_VANTAGE_API_KEY=         # 25 req/day free
FINNHUB_API_KEY=               # 60 req/min free
TWELVE_DATA_API_KEY=           # 800 credits/day free
```

`NEXT_PUBLIC_` = exposed to browser. Server-only secrets must NOT have this prefix.

## Database

Migrations live in `supabase/migrations/` and are applied manually against Supabase.

Current tables:
- `profiles` — extends `auth.users` with display currency. `trading_profile` JSONB column exists (legacy from the deleted wizard, PR #269) but is no longer written.
- `strategies` — strategy umbrellas with `rules_template` JSONB (PR #266, migration 00042). Algorithm instances reference via `algorithms.strategy_id`.
- `algorithms` — deployed trading strategies with `rules` (JSONB), `status`, `live_trading_enabled`, `broker_connection_id`, `strategy_id`. Algos are seeded via `scripts/deploy-*.ts`, not via UI generation.
- `algorithm_watchlist` — tickers linked to algorithms.
- `paper_positions` — every position the scan engine opens; broker mirror fields populated when live. `exit_reason` is the source of truth for SL hit / TP hit / signal exit / stagnant cut / manual close.
- `activity_log` — every event the scan/manage cron emits. `event_type` constrained (see migration 00028). Read for "did the gate fire?" questions; powers `/reports` via `src/lib/cohort/engine-activity.ts`.
- `broker_connections` — operator's broker creds per provider (`metaapi` / `ctrader`). RLS-scoped.
- `sentiment_cache` — NEWS_SENTIMENT cache per ticker/topics.
- `price_cache` — OHLCV bars per ticker/interval (global since 00037).
- `llm_decisions` — per-bar LLM-trader audit trail. Backfilled with trade outcome on close. Migration 00031 + 00035.
- `oanda_positioning_cache` — OANDA positionBook snapshots every 20 min. Migration 00034.
- `paper_positions_archive` — archived position rows (migration 00033).
- `trades`, `journal_entries` — dormant per the personal-operator workflow (kept per dormant-by-design policy).
- `public.last_manage_tick()` — SECURITY DEFINER function for the GitHub Actions dead-man switch. Migration 00039.

All tables use RLS. Scheduled scan uses an admin client (`createAdminClient()`) because cron has no Supabase session.

## Architecture Decisions & Gotchas

Things easy to get wrong. Read before modifying.

### clampRules() Post-Processing
`lib/algorithm/rules-post-process.ts` `clampRules()` normalizes rules on update — relaxes RSI thresholds for long-term strategies, converts decimal percentages (0.05 → 5) for stop loss / take profit / position sizing. Called from `updateAlgorithm` in `app/(dashboard)/algorithms/actions.ts`.

### Price Provider Fallback Chain
`lib/market-data/prices.ts` fetches via: Twelve Data → Yahoo Finance → Alpha Vantage. Each failure logs + falls through. Final provider throws. In-memory 1h TTL; persistent cache in `price_cache`.

### Display Labels — Single Source of Truth
**Never define label maps inline in components.** Import from:
- `lib/constants/algorithm.ts` — `ASSET_CLASS_LABELS`, `RISK_LEVEL_LABELS`, `STATUS_LABELS`, `STATUS_COLORS`, operator labels
- `lib/constants/journal.ts` — `ENTRY_TYPE_LABELS`, `ENTRY_TYPE_SHORT_LABELS`, `EMOTION_LABELS`
- `lib/constants/prop-firm.ts` — prop firm preset configurations

### Server Actions Return `ActionResult<T>`
All server actions in `app/(dashboard)/*/actions.ts` return `{ success: true, data: T } | { success: false, error: string }`. Always type the generic (e.g., `ActionResult<Algorithm>`); never leave as bare `ActionResult` (defaults to `unknown`).

### API Route Validation
All API routes validate request bodies with Zod. Two auth flavours:

- **User-scoped routes:** check via `supabase.auth.getUser()`. Return 401 on missing session.
- **Admin / cron routes** (`api/admin/*`, `api/cron/*`): check via `verifyAdminAuth(request)` from `@/lib/api/admin-auth`. Bearer header against `CRON_SECRET`.

When adding a new route: pick the right auth pattern, validate body with Zod, return typed error responses, and if it's a cron entrypoint, add a row to `scripts/README.md` schedule table.

### Auth Redirect Whitelist
The OAuth callback (`app/(auth)/callback/route.ts`) validates `next` against `ALLOWED_REDIRECTS`. When adding a new protected route, add it there AND to `protectedPrefixes` in `lib/supabase/middleware.ts` AND to the matcher in `middleware.ts`.

### Adaptive Gates (entry-side)
Three gates before entering a position:
1. **Intraday ATR liquidity** (`lib/algorithm/intraday-atr-gate.ts`) — always-on. Skips when 14-bar ATR < 20th percentile of last 200 bars.
2. **Live spread gate** (`lib/algorithm/spread-gate.ts`) — live-only. Refuses when `(ask − bid) / pip > catalog_typical × 2.5`. Catalog typicals in `markets.ts` `TYPICAL_SPREAD_PIPS`.
3. **News veto** (`lib/market-data/economic-calendar.ts`) — Finnhub events; configurable window before/after tier-1 releases.

Plus opt-in `regime_filter` (daily ATR percentile) and `adx_filter` (trend strength).

### Stagnant Exit Gate (exit-side)
`lib/algorithm/stagnant-exit.ts` — closes positions open ≥ N bars that never reached `min_excursion_r` favourable and currently sit at `≤ min_pnl_r`. `max_bars` auto-derived from `SL_distance / ATR(14)` (clamped 6-48) when not pinned. Runs FIRST in `manageExistingPosition` so it preempts SL hits.

### R-Aware Consecutive-Loss Halt
`lib/scan/consec-loss-halt.ts` — 3-strikes daily halt counting only losses ≥ 0.5R. Micro stagnant-cut nips (< 0.5R) don't reset OR count toward the streak.

### FTMO Consistency Halt
`lib/scan/consistency-halt.ts` — refuses new entries on a day whose net profit ≥ N% of total accumulated profit (FTMO challenge: 40%). Live-only; backtest flags violations end-of-run.

### Combinatorial Search (Wave 7)
`lib/algorithm/combinatorial-search.ts` — given `(capital, monthly_target_pct, prefer/avoid)`, runs a curated grid of 8 strategy templates × 4 timeframe / SL-TP combos through walk-forward. Admin endpoint at `POST /api/admin/combinatorial-search`.

### Position-Size Sanity Gate
`lib/scan/live-execution.ts` — refuses live orders with implied notional > 30× capital. The CHF/JPY blow-up was 67× — this gate would have caught it.

### Broker Adapter Quote Method
`adapter.fetchQuote(conn, appSymbol)` returns `BrokerQuote | null`. MetaApi MT5 implements via `/symbols/{symbol}/current-price`. cTrader returns `null` (proto streams only). Spread gate falls back to "skipped" when null.

## Adding New Features

1. Page in `src/app/(dashboard)/[feature]/page.tsx`
2. Components in `src/components/[feature]/`
3. Zod validators in `src/lib/validators/[entity].ts`
4. TanStack Query hooks in `src/hooks/use-[entity].ts`
5. API routes in `src/app/api/[feature]/route.ts` if needed
6. Supabase migrations in `supabase/migrations/`
7. Nav: add to `src/lib/constants/nav.ts` (sidebar + mobile-nav both consume it)
8. Auth whitelist (if protected): `middleware.ts`, `lib/supabase/middleware.ts`, `(auth)/callback/route.ts`

## Nav Items

Single source of truth: `src/lib/constants/nav.ts`. Sidebar (desktop) and MobileNav (mobile) both render from it.

Current: Dashboard, Trades, Journal, Algorithms, Reports, Analytics, Settings.

## Cron / live trading

Production cron runs on the operator's local Mac via system `cron` (NOT a separate cron host). See `scripts/README.md` for schedule, log paths, and the "is the cron alive?" diagnostic. The Mac and `pnpm dev` / `pnpm start` must both be up — closed lid or sleep stalls the schedule.

Five live cron entrypoints (operator's crontab as of 2026-06-10):
- `manage-cron.sh` (every 5 min) → `/api/cron/manage-positions`
- `scan-cron.sh` (every 15 min — aligned to 15m/1h/4h bar closes) → `/api/cron/scan-active-algorithms`
- `heartbeat-cron.sh` (every 5 min) → `/api/cron/heartbeat` + optional `HEARTBEAT_PING_URL`
- `oanda-positioning-cron.sh` (every 20 min) → `/api/admin/snapshot-oanda-positioning?instruments=XAU_USD`
- `prune-sentiment-cache-cron.sh` (daily 04:00 UTC) → `/api/admin/prune-sentiment-cache`

Each emits `manage_tick` / `scan_started` + `scan_completed` events to `activity_log` so liveness is verifiable on no-op ticks.

**Independent alerting:** `.github/workflows/dead-man.yml` (GitHub Actions, every 30 min) calls the anon-executable `last_manage_tick()` RPC and emails the repo owner when the heartbeat trail is >45 min stale. Covers the 2026-05-24 silent-outage chain (Mac asleep → cron dead → zero DB traffic → Supabase free-tier auto-pause for 17 days unnoticed). The 5-min ticks also keep the free-tier Supabase project from auto-pausing.

**Restart-from-idle warning:** restarting the dev server with algos `status='active'` resumes LLM calls and paper trading immediately (the live flag doesn't gate scans — see LLM-Trader section). Run `pnpm dlx tsx scripts/live-state.ts` first; it fails loudly on an unreachable DB.
