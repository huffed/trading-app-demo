@AGENTS.md

# QuantTrader

A **personal autonomous trading system** for a single operator (not a SaaS — no users planned). An LLM (Anthropic Haiku) makes per-bar discretionary trading decisions on gold (XAU/USD); a deterministic engine handles everything enforceable — SL/TP geometry, gates, halts, sizing, broker mirroring. Goal: pass FTMO funded-account challenges and scale to multiple funded accounts.

## Product Vision (updated 2026-06-10)

- **Core division of labor:** the LLM picks entries (direction + timing from chart structure, regime, intermarket context); the engine owns exits, risk, and execution. Every dataset so far endorses this split — LLM mid-trade exits measured at ~−24% R vs mechanical SL/TP, permissive prompt-feedback fails, engine gates work.
- **The learning loop is the spine** (see `project_roadmap_2026_06` in operator memory): per-trade cohort attribution → weekly cohort report → $0 replay screens → ≤1 paid walk-forward confirmation/month (pre-registered criteria + recency window) → shadow-then-enforce engine gates → live paper feeds back.
- **Current focus:** gold 4h (`v2` prompt — the only validated baseline). Lower timeframes are sequenced, not dead: 30m re-entry comes as a ported-primitives scalper bundle after the 4h geometry confirmation. Multi-instrument (forex alongside gold — gold stays in the mix permanently) is the endpoint.
- **Budget reality:** ≤£150/month total. Development defaults to $0 (replay screens over recorded trades, Groq free tier for plumbing); the harness enforces `LLM_MONTHLY_BUDGET_USD` (default $25) with a hard process-exit.
- **Our app is NOT a broker.** It's a controller that executes on connected brokers (MetaApi MT5 — primary; cTrader Open API — dormant by design, kept as the MT5 alternative) via their APIs.
- **Dormant-by-design surfaces (updated 2026-06-17 PR #270):** the operator deleted the chat-creates-algorithm flow + onboarding wizard + algorithm generate wizards in PR #270 — the original "kept deliberately" policy was reversed for these three families specifically because the personal-operator workflow doesn't need them (algos deploy via `scripts/deploy-*.ts`). **Still dormant-by-design and not to be deleted/extended:** journal pages + components, trades page + CSV import, stocks scaffolding, cTrader Open API (see [[feedback_keep_ctrader]] — operator has corrected this twice). The Groq SDK + `src/lib/ai/client.ts` stay because journal analysis + combinatorial-search template selector + LLM-trader fallback still use them.

## Commands

```bash
pnpm dev         # Start dev server (http://localhost:3000)
pnpm build       # Production build (run to verify before committing)
pnpm lint        # ESLint (0 errors, 0 warnings required)
pnpm lint:fix    # Auto-fix lint issues
pnpm format      # Prettier format all source files
pnpm format:check # Check formatting without writing
pnpm start       # Start production server
pnpm test        # Vitest suite (119 tests)
pnpm test:watch  # Vitest in watch mode
```

Add shadcn components: `pnpm dlx shadcn@latest add <component-name>`

**Package manager: pnpm.** Do not use npm or yarn. Do not create package-lock.json or yarn.lock.

## Git Workflow

- **Repo:** https://github.com/huffed/trading-app-demo
- **Main branch:** `main` — production-ready code
- **Integration branch:** `dev` — merge feature branches here via PR
- Do not include `Co-Authored-By` lines in commit messages
- Always run `pnpm build` and `pnpm lint` before committing (0 errors, 0 warnings)

### Feature Branches

All work happens on feature branches off `dev`. Never commit directly to `dev` or `main`.

- **Branch naming:** `feat/<short-description>` (e.g., `feat/dashboard-widgets`, `feat/broker-integration`)
- **Scope:** One branch per iteration or logical feature. If an iteration is large, split it into multiple branches with focused PRs (e.g., `feat/dashboard-stat-cards`, `feat/dashboard-charts`).
- **PR size:** Keep PRs reviewable — aim for under ~500 lines changed. Split larger work into sequential PRs.
- **Flow:** Create branch → develop → test locally → push → open PR into `dev` → merge

```bash
# Start new feature
git checkout dev && git pull
git checkout -b feat/my-feature

# When done
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
| Styling | Tailwind CSS (utility classes, CSS variables in `globals.css`) | 4 |
| UI Components | shadcn/ui **base-nova** style (uses `@base-ui/react`, NOT Radix) | 4 |
| Icons | lucide-react | - |
| Backend/Auth | Supabase (`@supabase/ssr`) | - |
| Server State | TanStack React Query | 5 |
| Client State | Zustand | 5 |
| Validation | Zod | 4 |
| AI/LLM (trading brain) | Anthropic SDK (`@anthropic-ai/sdk`) — claude-haiku-4-5, per-bar LLM-trader decisions (live + backtest harness) | - |
| AI/LLM (chat/codegen) | Groq SDK (`groq-sdk`) — llama-3.3-70b-versatile, dormant SaaS chat + algorithm generation | - |
| Market Data | OANDA (prices, HEAD of live chain + positioning book), Twelve Data (fallback), Yahoo Finance (fallback), Alpha Vantage (news sentiment), Finnhub (economic calendar) | - |
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
<TooltipTrigger render={<SomeElement />} />

// WRONG - Radix asChild pattern (does NOT work)
<Button asChild><Link href="/foo">Click me</Link></Button>
```

Always check the actual component source in `src/components/ui/` before assuming any API.

## Project Structure

```
src/
├── app/
│   ├── layout.tsx              # Root layout: ThemeProvider > QueryProvider > TooltipProvider
│   ├── page.tsx                # Landing page (public)
│   ├── globals.css             # Tailwind imports + CSS variable theme (oklch colors)
│   ├── (auth)/                 # Route group: login, signup, callback (no sidebar)
│   │   └── layout.tsx          # Centered container layout
│   └── (dashboard)/            # Route group: all authenticated pages
│       └── layout.tsx          # Sidebar + Topbar shell (server component, redirects if no user)
├── components/
│   ├── ui/                     # shadcn/ui primitives (generated via CLI, do not edit directly)
│   ├── layout/                 # Shell: sidebar, topbar, mobile-nav, theme-toggle, user-menu
│   ├── auth/                   # Login/signup forms
│   ├── dashboard/              # Dashboard-specific components
│   ├── trades/                 # Trade-related components
│   ├── journal/                # Journal-related components
│   ├── algorithms/             # Algorithm cards, rules display, backtest, live signal card
│   ├── chat/                   # AI chat: drawer, input (with CSV upload), message bubble
│   └── shared/                 # Cross-cutting reusable components
├── lib/
│   ├── supabase/
│   │   ├── client.ts           # createClient() - browser Supabase client
│   │   ├── server.ts           # createClient() - server Supabase client (uses cookies())
│   │   └── middleware.ts       # updateSession() - refreshes auth tokens per request
│   ├── ai/                       # Groq client + prompts (algorithm, chat, backtest, journal, signal)
│   ├── algorithm/                # Strategy gates and search engine
│   │   ├── intraday-atr-gate.ts  # ATR-percentile liquidity gate (always-on, backtest + live)
│   │   ├── spread-gate.ts        # Live broker bid/ask refusal (live-only)
│   │   ├── stagnant-exit.ts      # Cut deeply-stuck red trades (R-aware, ATR-derived bar count)
│   │   ├── bar-staleness-gate.ts # Refuse LLM calls on stale cached bars (pre-LLM, saves spend)
│   │   ├── live-price-drift-gate.ts # Block entries when live price drifted >0.20% from bar close
│   │   ├── re-entry-cooldown.ts  # No re-entry within 1× primary TF of a loss close
│   │   ├── structural-sl.ts      # swing_anchor SL + adaptive rr_multiple TP (production path)
│   │   ├── conviction-sizing.ts  # Conviction-scaled position sizing
│   │   ├── dxy-filter.ts         # DXY directional filter (opt-in)
│   │   ├── rules-post-process.ts # clampRules() — corrects LLM output
│   │   └── combinatorial-search* # Wave 7: search engine + grid + scoring + universe + price loader
│   ├── brokers/                  # Multi-broker abstraction
│   │   ├── types.ts              # BrokerAdapter / BrokerQuote / BrokerSymbolSpec interfaces
│   │   ├── registry.ts           # Provider → adapter dispatch
│   │   ├── metaapi.ts            # MetaApi REST client (MT5 bridge)
│   │   ├── metaapi-mt5.ts        # MetaApi adapter (FTMO MT5)
│   │   ├── ctrader-openapi.ts    # cTrader Open API adapter (proto over TLS)
│   │   ├── ctrader/              # Protobuf client, session, message helpers
│   │   └── sizing.ts             # notionalToLots
│   ├── constants/
│   │   ├── algorithm.ts          # Label maps: asset class, risk, status, operators
│   │   ├── markets.ts            # FOREX_PAIRS + COMMODITIES catalog + TYPICAL_SPREAD_PIPS map
│   │   ├── journal.ts            # Label maps: entry type, emotion
│   │   └── prop-firm.ts          # FTMO, Topstep, FundedNext, The5ers presets
│   ├── market-data/
│   │   ├── prices.ts             # OANDA → Twelve Data → Yahoo → Alpha Vantage fallback chain
│   │   ├── oanda.ts              # OANDA v20 candles (head of live chain, unmetered practice host)
│   │   ├── oanda-positioning.ts  # OANDA positionBook fetcher → oanda_positioning_cache
│   │   ├── parse-bar-date.ts     # parseBarDate() — UTC-explicit parsing (2026-05-12 BST incident)
│   │   ├── price-cache.ts        # Supabase price_cache reads/writes
│   │   ├── twelve-data.ts        # Batch quote fetcher (live prices)
│   │   ├── news-sentiment.ts     # NEWS_SENTIMENT fetcher with sentiment_cache
│   │   ├── sentiment-evaluator.ts# Sentiment condition evaluator
│   │   ├── economic-calendar.ts  # Finnhub calendar + currency-specific veto windows
│   │   ├── indicators.ts         # RSI / SMA / EMA / MACD / Bollinger Bands
│   │   ├── indicator-registry.ts # Indicator dispatch + cache
│   │   ├── condition-evaluator.ts# Mixed (technical + pattern) evaluator
│   │   ├── technical-evaluator.ts# Technical-only evaluator
│   │   ├── regime-filter.ts      # Daily ATR-percentile regime gate (opt-in)
│   │   ├── adx-filter.ts         # ADX trend-strength gate (opt-in)
│   │   ├── auto-side.ts          # D1 bias resolution for side: "auto"
│   │   ├── resample.ts           # Multi-timeframe resampling
│   │   ├── interval.ts           # timeframeToInterval / barsPerDay / minBarsFor
│   │   ├── backtest-engine.ts    # Single-ticker backtest (runBacktest) + runSimulation
│   │   ├── portfolio-backtest.ts # Multi-ticker portfolio backtest (runPortfolioBacktest)
│   │   ├── prop-firm-backtest.ts # Prop-firm-aware sim helpers (DLL halt, force-close)
│   │   ├── walk-forward.ts       # Rolling out-of-sample windows
│   │   ├── backtest-metrics.ts   # WR, Sharpe, drawdown, trade stats
│   │   └── types.ts              # PriceBar, BacktestTrade, BacktestMetrics
│   ├── patterns/                 # ICT/SMC pattern detectors (FVG, IFVG, sweep, BOS, OB, daily bias)
│   ├── scan/                     # Live scan engine + manage cron
│   │   ├── engine.ts             # processTicker, manageExistingPosition, scanAlgorithm
│   │   ├── manage.ts             # Manage tick — exits + broker P&L sync + reconciliation
│   │   ├── entry.ts              # evaluateEntry + evaluateLlmTraderEntry — full entry-gate pipeline
│   │   ├── llm-trader.ts         # THE CORE: per-bar Anthropic call, context builder, decision parse
│   │   ├── llm-trader-prompts.ts # Prompt versions v1-v5_15m + PROMPT_HAS_MTF_OVERRIDE registry
│   │   ├── llm-trader-reflection.ts # Layer-3 substrate: summariseRecentOutcomes (unwired)
│   │   ├── llm-trader-audit.ts   # llm_decisions persistence + trade-outcome backfill
│   │   ├── live-execution.ts     # executeLiveEntry / executeLiveExit (broker mirror + 30× sanity gate)
│   │   ├── broker-truth-sync.ts  # Broker deal record → realized P&L reconciliation
│   │   ├── flatten.ts            # Flatten-everything routine (admin escape hatch + DLL halt)
│   │   ├── helpers.ts            # logActivity (error-checked), position sizing, risk prices
│   │   ├── consec-loss-halt.ts   # R-aware 3-strikes daily halt
│   │   ├── consistency-halt.ts   # FTMO consistency-rule guard (live-only)
│   │   ├── daily-halt.ts         # Daily loss limit force-close
│   │   ├── portfolio-halt.ts     # Portfolio-level halt (cross-algo, per portfolio)
│   │   ├── risk-pool-halt.ts     # Combined-risk cap across algos sharing a broker
│   │   ├── divergence.ts         # Cumulative paper-vs-broker divergence kill switch
│   │   ├── drift-detector.ts     # Live-vs-backtest WR drift halt
│   │   ├── pair-quality.ts       # Auto-pair-pruning
│   │   ├── per-hour-stats.ts     # Per-hour outcome aggregation
│   │   └── readiness-check.ts    # Pass/caution/fail verdict aggregator
│   ├── signals/
│   │   └── evaluate-live.ts      # LLM-powered live signal evaluation orchestrator
│   ├── api/
│   │   └── admin-auth.ts         # verifyAdminAuth — Bearer CRON_SECRET auth for admin/cron routes
│   ├── supabase/                 # Browser/server clients + middleware
│   ├── utils/
│   │   ├── parse-trade-csv.ts    # Trading 212 CSV parser
│   │   ├── pnl.ts                # P&L + price formatting helpers (display currency aware)
│   │   └── derive-trading-params.ts # Onboarding wizard answers → algorithm rules
│   ├── utils.ts                  # cn() - clsx + tailwind-merge
│   ├── logger.ts                 # Structured logger
│   └── validators/               # Zod schemas (algorithm, trade, journal, position)
├── hooks/
│   ├── use-algorithms.ts       # CRUD + backtest hooks for algorithms
│   ├── use-chat.ts             # Chat state, streaming, CSV upload, algorithm creation/editing
│   ├── use-live-signal.ts      # Live signal evaluation mutation
│   ├── use-trades.ts           # Trade CRUD hooks
│   ├── use-journal.ts          # Journal CRUD + trade linking hooks
│   ├── use-watchlist.ts        # Watchlist CRUD per algorithm
│   └── use-dashboard-stats.ts  # Dashboard statistics
├── stores/                     # Zustand stores (ui-store.ts = sidebar state)
├── providers/                  # React context providers (theme, query)
└── types/                      # Shared TypeScript types (algorithm, chat, trade, journal)
middleware.ts                   # Root middleware: auth redirects via lib/supabase/middleware.ts
supabase/migrations/            # SQL migrations (run manually against Supabase)
```

## Algorithm Condition System

Algorithms use a **discriminated union** for entry/exit conditions. Every condition has a `type` field:

```typescript
// Technical — price-based indicators evaluated in backtest engine
interface TechnicalCondition {
  type: "technical";
  indicator: string;   // RSI, SMA20, EMA12, MACD, BollingerBands_upper/lower
  operator: "less_than" | "greater_than" | "crosses_above" | "crosses_below";
  value: number;       // Threshold (0 = compare against price/companion MA)
  timeframe: string;
}

// Sentiment — news/social data evaluated via Alpha Vantage + LLM
interface SentimentCondition {
  type: "sentiment";
  source: "news" | "social";
  metric: string;      // overall_sentiment, article_count, topic_buzz
  operator: "above" | "below" | "spike_above" | "spike_below";
  threshold: number;
  topics?: string[];
  tickers?: string[];
  timeframe: string;
}

// Pattern — ICT/SMC chart patterns detected from OHLC by lib/patterns
interface PatternCondition {
  type: "pattern";
  pattern: "liquidity_sweep" | "fvg" | "ifvg" | "daily_bias" | "bos" | "order_block";
  direction?: "bullish" | "bearish";
  lookback?: number;   // swing-based patterns; default 5
  ma_period?: number;  // daily_bias only; default 20
  timeframe: string;
}

type EntryCondition = TechnicalCondition | SentimentCondition | PatternCondition;
```

**Logic combinators:** `entry_logic` is `"all"`, `"any"`, or `{ type: "n_of_m", n }`. The `n_of_m` form is what the friend's strategy uses — fires when at least `n` of M conditions align.

**Legacy normalization:** Old conditions without a `type` field are auto-normalized to `"technical"` at Zod parse time. No database migration needed — `rules` is JSONB.

**Backtest behavior:** Technical and pattern conditions are backtested against price data. Sentiment conditions are filtered out (can't historically backtest news). Results include `backtest_mode: "technical_only"` when sentiment conditions were excluded.

**Live signal check:** For algorithms with sentiment conditions, the algorithm detail page shows a "Live Signal Check" card. Enter a ticker → fetches current news → evaluates sentiment thresholds → LLM assesses narrative/catalyst patterns → returns buy/hold/no_signal with confidence.

## LLM-Trader (the live trading core)

The condition system above is the legacy/dormant path. **The active system is the LLM-trader**: when `rules.llm_trader.enabled`, the scan skips condition evaluation and, on each primary-TF bar close, sends chart context (recent bars, D1 regime read, SMA/momentum, DXY proxy, gold intermarket, optional higher-TF lines) to Anthropic Haiku, which returns `enter_long | enter_short | hold | exit | move_be` as JSON.

- **Prompts** live in `src/lib/scan/llm-trader-prompts.ts` — versions `v1`-`v5_15m` + `v2_generic`/`v2_mtf`, selected per algo via `rules.llm_trader.prompt_version`. Prompt text is **validated-baseline material**: never edit a version in place; add a new version and take it through the confirmation pipeline. Capability flags (e.g. multi-TF override) live in `PROMPT_HAS_MTF_OVERRIDE: Record<PromptVersion, boolean>` — the compiler forces new versions to declare them; never hardcode version lists in gates.
- **Division of labor:** the LLM picks entries; the **engine owns exits** (SL/TP geometry via `structural-sl.ts`, stagnant cut, halts). Measured 2026-06-10 (PR #178 replay, n=299): honoring LLM mid-trade exits cost ~24% of total R vs letting SL/TP play out.
- **Every decision is audited** to the `llm_decisions` table (context, decision, confidence, reasoning, linked position, trade outcome backfilled on close) — surfaced on the algorithm detail page.
- **Defensive gates run before the LLM call when flat** (dead-hour, ATR liquidity, news veto, consec-loss halt, etc.) and are **skipped in-position** so the LLM can always manage an open trade (2026-05-11 incident). The RANGING hard block consults the prompt-capability registry.
- **`live_trading_enabled` gates ONLY broker mirroring — NOT the scan or the LLM call.** A `status='active'` algo with the flag off still scans, still spends API tokens (~$0.003/call), and still opens PAPER positions. Zero-spend idle requires `status='paused'`.

### Validation economics (the harness)

`scripts/llm-trader-backtest.ts` + `scripts/llm-trader-walk-forward.ts` replay history through the same prompts with real Anthropic calls. Hard-won rules, all enforced in code:

- **`SL_PRESET=baseline|live|comboC`** pins the full SL/TP geometry; omitting it runs harness defaults (pct 1.5%/4.5%) which are NOT the live config — the header warns loudly. Resolved geometry is echoed in the header and summary JSON (the May baselines silently ran the wrong geometry for weeks).
- **`REPLAY_CACHE=1`** memoises responses on disk — re-running an unchanged config costs $0. Default OFF so variance reps stay independent.
- **Rate limiter + jittered backoff** (`LLM_RPM`/`LLM_TPM`/`LLM_MAX_ATTEMPTS`) — the 2026-05-18 cascade wasted ~67% of a sweep before these existed.
- **`LLM_MONTHLY_BUDGET_USD` (default $25)** — a per-month spend ledger; the process exits before exceeding it. The £150/month ceiling is structural, not advisory.
- **Confirmation protocol** (walk-forward docstring): screen candidates at $0 first (`scripts/exit-mechanics-replay.ts` pattern — replay recorded entries through variant mechanics), then ONE paid A/B confirmation with pre-registered criteria, always including a **recency window ending run-day** (the standard grid stops at 2026-04-30).

## Pre-deploy validation (canonical 4-way for library algos)

Applies to **every condition-based library algo** (entry_conditions through `runWalkForward`) — both new deploys AND retroactive revalidation of existing deployed algos. Established 2026-06-16 (PRs #258 + #259) after FVG-DailyBias-Long 4h surfaced a geometry mismatch (rr=3 was demonstrably worse than rr=2) that single-backtest validation would have missed. Coil-Breakout 4h then showed the same pattern under retroactive sweep. Cost: $0 per pass (replay over recorded corpus, no LLM calls).

**The 4 validations — all are MANDATORY before `APPLY=1` on any deploy or geometry change:**

1. **Friction test** — re-run with realistic execution costs. For gold: `FRICTION_SLIPPAGE_BPS=0.5 FRICTION_SPREAD_BPS=0.4`. If returns degrade >5% from frictionless, the frictionless baseline was misleading and shouldn't be the ship signal.

2. **Cadence comparison** — when applicable, run the same composition on 1h and 30m via `TIMEFRAME=1h` / `TIMEFRAME=30m` in `scripts/library-walk-forward.ts`. 4h is usually correct (deepest multi-regime corpus); the comparison surfaces whether a sister-cadence sister algo is warranted AND confirms 4h is the right primary.

3. **Per-window decomp** — `PER_WINDOW=1 pnpm dlx tsx scripts/library-walk-forward.ts ONLY=<candidate>` writes per-window detail into the summary JSON. Aggregate to year-by-year breakdown to identify regime-concentrated failure modes. **Aggregate stats hide chop-year disasters** (e.g. 57% overall green could be 71% ex-2021 + 17% in 2021).

4. **RR × lookback geometry grid** — `pnpm dlx tsx scripts/sweep-algo-geometry.ts` runs `rr_multiple ∈ {2, 3, 5}` × `sl_lookback ∈ {3, 4, 6}` = 9 cells with per-year decomp on each. **Pattern recognition:** a monotonic improvement across the RR axis (rr=2 > rr=3 > rr=5 in ALL lookbacks) is structural, not noise.

**Hard rules:**

- **The sister-algo `rr=3` convention is NOT a default.** Each algo's RR must be validated per-algo via the grid. Coil-1h and Dip-Buyer happen to be at rr=3-best; FVG-DailyBias-Long 4h and Coil-Breakout 4h are at rr=2-best. Don't pattern-match to sister algos — verify.

- **The "chop-rescue mechanism" is real.** rr=2 specifically rescues sideways/distribution regimes (2021 gold range, 2025 chop) because price reverses within 2R before completing a 3R move. When the per-year decomp shows rr=2 turning a chop-year loss into a profit, that's the signal — not statistical noise.

- **Don't change live geometry on backtest alone.** Per [[feedback_iterate_only_validated_baselines]], live algos with a proposed geometry change require an A/B paper variant alongside live for ~30 days before flipping. The update script (`scripts/update-library-geometry-*.ts`) MUST refuse `live_trading_enabled=true` targets as defense-in-depth.

- **Generalize, don't fork.** The sweep script is `scripts/sweep-algo-geometry.ts` with a TARGETS list; add a new target rather than forking the script. The deploy/update scripts follow `scripts/deploy-<algo>-<tf>.ts` and `scripts/update-library-geometry-<date>.ts` patterns.

**What this does NOT replace** (these layers still bind):
- 10% DD hard gate per [[feedback_dd_validation_gate]] — any sweep cell with worst DD > 5% on a window is disqualified from ship.
- Direction-split per [[feedback_direction_split_first]] — bullish and bearish are independent validations.
- Friend-replay direction-of-development signal per [[project_friend_replay_2026_06]] — supplementary, not substitute.

**Reports** live at `scripts/REVALIDATION_REPORT_<date>.md` and get linked from PR bodies.

## Conventions

### File Naming
- Components: `kebab-case.tsx` (e.g., `login-form.tsx`, `trade-table.tsx`)
- Exports: PascalCase (e.g., `LoginForm`, `TradeTable`)
- Hooks: `use-[name].ts` exporting `use[Name]`
- Stores: `[name]-store.ts` exporting `use[Name]Store`
- Validators: `[entity].ts` in `lib/validators/`

### Component Organization
- **`components/ui/`** - shadcn primitives only. Add via CLI, avoid manual edits.
- **`components/layout/`** - App shell components (sidebar, topbar, etc.)
- **`components/[feature]/`** - Feature-specific components (trades, journal, algorithms, chat, etc.)
- **`components/shared/`** - Reusable components used across features

### Client vs Server Components
- Default to server components. Add `"use client"` only when needed (hooks, state, event handlers).
- `(dashboard)/layout.tsx` is a server component - it calls `supabase.auth.getUser()` and redirects.
- Auth forms, sidebar, topbar, theme toggle, chat, algorithm components are client components.

### State Management
- **TanStack Query** for all server/async state (API data, Supabase queries)
- **Zustand** only for ephemeral client UI state (sidebar open/closed, modals, filter state)
- Never put server data in Zustand. Never use TanStack Query for pure UI state.

### Styling
- Tailwind utility classes only. No CSS modules.
- Colors defined as CSS variables in `globals.css` using oklch color space.
- Use `cn()` from `@/lib/utils` to merge classes conditionally.
- Trading-specific colors: `--profit` (green) and `--loss` (red) CSS variables.
- Theme is dark-mode-first. Always test both modes.

### Supabase Auth
- Use `getUser()`, **never** `getSession()` for server-side auth checks. `getUser()` validates the token server-side and cannot be spoofed.
- Browser: `import { createClient } from "@/lib/supabase/client"`
- Server/API routes: `import { createClient } from "@/lib/supabase/server"`
- Protected routes redirect in both middleware (`middleware.ts`) and the dashboard layout.

### Import Alias
All imports use `@/*` which maps to `./src/*`:
```tsx
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { useUIStore } from "@/stores/ui-store";
```

## Environment Variables

Required in `.env.local` (see `.env.example`):
```
NEXT_PUBLIC_SUPABASE_URL=      # Supabase project URL
NEXT_PUBLIC_SUPABASE_ANON_KEY= # Supabase anonymous/public key
GROQ_API_KEY=                  # Groq API key (server-only, free tier)
ALPHA_VANTAGE_API_KEY=         # Alpha Vantage key (prices + news, 25 req/day free)
FINNHUB_API_KEY=               # Finnhub key (ticker lookup, company profiles, 60 req/min free)
TWELVE_DATA_API_KEY=           # Twelve Data key (price data, primary provider, 800 credits/day free)
```

`NEXT_PUBLIC_` prefix = exposed to browser. Server-only secrets must NOT have this prefix.

## Database

Migrations live in `supabase/migrations/` and must be run manually against your Supabase project.

Current tables:
- `profiles` — extends `auth.users` with app data + `trading_profile` JSONB (onboarding answers) + display currency setting. Auto-created via trigger on signup. Unique: email.
- `trades` — manual trade records (legacy / CSV import) with entry/exit prices, P&L, status. Largely deferred in favour of `paper_positions`.
- `journal_entries` — trade reflections with emotion tracking and AI analysis.
- `algorithms` — AI-generated trading algorithms with `rules` (JSONB), backtest results, `status`, `live_trading_enabled`, `broker_connection_id`. Unique: (user_id, name).
- `algorithm_watchlist` — tickers linked to algorithms with backtest metrics + `auto_paused` from pair-quality pruner. `added_by`: "user" | "ai" | "csv".
- `paper_positions` — every position the scan engine opens; broker mirror fields (`broker_position_id`, `broker_fill_price`, `broker_unrealized_pnl`, `broker_close_price`) populated when live trading is on. `exit_reason` is the source of truth for SL hit / TP hit / signal exit / stagnant cut / manual close.
- `activity_log` — every event the scan/manage cron emits. `event_type` is constrained (see migration 00028 for the full list); `details` is JSONB with per-event telemetry. Read this for any "did the gate fire?" question.
- `broker_connections` — operator's broker creds (token, account_id, region) per provider (`metaapi` / `ctrader`). RLS-scoped to user.
- `sentiment_cache` — cached NEWS_SENTIMENT API responses per ticker/topics, builds historical data. Unique: (user_id, ticker, fetched_at).
- `price_cache` — cached OHLCV bars per ticker/interval/output_size (global, not user-scoped since 00037), avoids redundant API calls.
- `llm_decisions` — per-bar LLM-trader audit trail (context, decision, confidence, reasoning, prompt_version, source live/walk_forward, linked paper_position, trade outcome backfilled on close). Migration 00031+00035.
- `oanda_positioning_cache` — OANDA retail positionBook snapshots every 20 min (long/short %, price buckets). History builds forward only — OANDA exposes no historical positioning. Collecting since 2026-06-10. Migration 00034.
- `paper_positions_archive` — archived position rows (migration 00033).
- `public.last_manage_tick()` — SECURITY DEFINER function, anon-executable, exposes exactly one timestamp for the GitHub Actions dead-man switch. Migration 00039.

All tables use Row Level Security (RLS). Users can only access their own data. The scan engine uses an admin client (`createAdminClient()`) for the cron path because scheduled execution has no Supabase session.

## Architecture Decisions & Gotchas

Things that are easy to get wrong or forget. Read this before modifying any of these systems.

### AI Chat → Algorithm Creation Flow
The chat hook (`use-chat.ts`) parses special markers from LLM responses:
- `[CREATE_ALGORITHM]{json}` → calls `generateAlgorithm()` server action → seeds watchlist → runs discovery + backtest
- `[EDIT_ALGORITHM]{json}` → calls `updateAlgorithm()` server action

The LLM is instructed to emit these markers in `lib/ai/prompts/chat.ts`. The marker JSON is stripped from the displayed message via `stripMarker()`. If you change the marker format, update both the prompt and the parser.

### Condition value=0 Semantics
When a technical condition has `value: 0` and is a price-based indicator (SMA/EMA/BB), the backtest engine compares **indicator vs price** (not indicator vs 0). This is how the LLM generates crossover signals: "SMA20 crosses_above 0" means "price crosses above SMA20".

**Special case:** EMA12 with value=0 compares against EMA26 (standard MACD crossover), NOT against price. This is hardcoded in `backtest-engine.ts:evalPriceComparison()`.

### clampRules() Post-Processing
The LLM's generated rules go through `clampRules()` in `algorithms/actions.ts` before saving. This function:
- Limits entry conditions to 1 tech + 1 sentiment for swing/long strategies (prevents zero-trade backtests)
- Relaxes RSI < 30 to RSI < 45 for long-term strategies
- Converts decimal percentages (0.05 → 5) for stop loss / take profit / position sizing

This exists because the LLM regularly ignores prompt instructions. If you change condition limits, also update the prompt to match.

### Price Provider Fallback Chain
`lib/market-data/prices.ts` fetches prices via: Twelve Data → Yahoo Finance → Alpha Vantage. Each failure is logged and falls through. The final provider throws on failure. In-memory cache has 1h TTL. Persistent cache is in Supabase `price_cache` table, managed by callers.

### Sentinel Conditions: Legacy Normalization
Old algorithms stored in DB may have conditions without a `type` field. These are normalized to `"technical"` in TWO places:
1. Zod validator (`lib/validators/algorithm.ts`) — at parse time via `z.preprocess`
2. Backtest engine (`lib/market-data/backtest-engine.ts`) — as a safety net for unvalidated DB reads

Both must stay in sync. The backtest engine's version is intentionally redundant — it catches data that bypasses validation.

### Display Labels — Single Source of Truth
**Never define label maps inline in components.** Import from:
- `lib/constants/algorithm.ts` — `ASSET_CLASS_LABELS`, `RISK_LEVEL_LABELS`, `STATUS_LABELS`, `STATUS_COLORS`, operator labels
- `lib/constants/journal.ts` — `ENTRY_TYPE_LABELS`, `ENTRY_TYPE_SHORT_LABELS`, `EMOTION_LABELS`
- `lib/constants/prop-firm.ts` — prop firm preset configurations

### Server Actions Return `ActionResult<T>`
All server actions in `app/(dashboard)/*/actions.ts` return `{ success: true, data: T } | { success: false, error: string }`. When adding new actions, always type the generic parameter (e.g., `ActionResult<Algorithm>`), never leave it as `ActionResult` (defaults to `unknown`).

### API Route Validation
All API routes validate request bodies with Zod before processing. Two auth flavours:

- **User-scoped routes** (`api/chat/route.ts`, `api/algorithms/generate/route.ts`): check auth via `supabase.auth.getUser()`. Return 401 on missing session.
- **Admin / cron routes** (`api/admin/*`, `api/cron/*`): check auth via `verifyAdminAuth(request)` from `@/lib/api/admin-auth`. Bearer header against `CRON_SECRET`. Used by the local cron scripts and any operator-only endpoints (readiness check, walk-forward, flatten, combinatorial search).

When adding a new route:
1. Pick the right auth pattern (user vs admin)
2. Validate the request body with a Zod schema
3. Return typed error responses (not generic 503s)
4. If it's a cron entrypoint, add a row to `scripts/README.md` schedule table

### Auth Redirect Whitelist
The OAuth callback (`app/(auth)/callback/route.ts`) validates the `next` parameter against an allowed paths whitelist. When adding new protected routes, add them to the `ALLOWED_REDIRECTS` array and the `protectedPrefixes` array in `lib/supabase/middleware.ts`.

### Adaptive Gates (entry-side)
Three gates evaluate before entering a position. Order matters:

1. **Intraday ATR liquidity** (`lib/algorithm/intraday-atr-gate.ts`) — always-on, runs in backtest + live. Skips when current 14-bar ATR is below the 20th percentile of the last 200 bars. Adapts per symbol — replaces the old clock-time `session_filter` (deleted).
2. **Live spread gate** (`lib/algorithm/spread-gate.ts`) — live-only (no spread in OHLC backtest). Calls `adapter.fetchQuote(...)` pre-order; refuses when `(ask − bid) / pip > catalog_typical × 2.5`. Catalog typicals live in `markets.ts` `TYPICAL_SPREAD_PIPS`. Every attempt logs `observed_spread_pips` for future learned-threshold tuning.
3. **News veto** (`lib/market-data/economic-calendar.ts`) — Finnhub events; refuses entries within configurable window before/after tier-1 releases.

Plus the existing opt-in `regime_filter` (daily ATR percentile) and `adx_filter` (trend strength).

### Stagnant Exit Gate (exit-side)
`lib/algorithm/stagnant-exit.ts` — closes positions that have been open ≥ N bars, never reached `min_excursion_r` favourable, and currently sit at `≤ min_pnl_r`. `max_bars` is auto-derived from `SL_distance / ATR(14)` (clamped 6-48) when not pinned explicitly. Defaults are conservative (only cuts deeply-stuck losers); tighter timeframes / scalping strategies should override.

Runs FIRST in `manageExistingPosition` so it preempts SL hits — recording an intra-bar SL fill as the exit reason would obscure the gate's contribution.

### R-Aware Consecutive-Loss Halt
`lib/scan/consec-loss-halt.ts` — friend's "3 strikes" daily halt, but only counts losses ≥ 0.5R adverse. Micro stagnant-cut nips (< 0.5R) are skipped (don't reset the streak, don't count toward it). 1R is computed per-row from `entry_price`, `stop_loss_price`, `side`, `quantity`, `ticker` via `pnlInUsd`.

### FTMO Consistency Halt
`lib/scan/consistency-halt.ts` — refuses new entries on a day whose net profit ≥ N% of total accumulated profit (FTMO standard challenge: 40%). Live-only; backtest's `buildPropFirmReport` flags violations at end-of-run but doesn't enforce mid-sim.

### Combinatorial Search (Wave 7)
`lib/algorithm/combinatorial-search.ts` (+ helpers in same dir) — given `(capital, monthly_target_pct, prefer/avoid)`, runs a curated grid of 8 strategy templates × 4 timeframe / SL-TP combos through walk-forward and ranks candidates by score. PR-A merged: search engine + admin endpoint at `POST /api/admin/combinatorial-search`. PR-B (calibration + algo creation hook) and PR-C (UI) follow.

### Position-Size Sanity Gate
`lib/scan/live-execution.ts` — refuses live orders with implied notional > 30× capital. Defense-in-depth catch for any sizing-math bug (catalog miss, divide-by-zero recovery, etc.). The CHF/JPY blow-up was 67× — this gate would have caught it.

### Broker Adapter Quote Method
`adapter.fetchQuote(conn, appSymbol)` returns `BrokerQuote | null`. MetaApi MT5 implements via `/symbols/{symbol}/current-price`. cTrader returns `null` (proto streams only — one-shot quotes don't fit the streaming interface). Spread gate falls back to "skipped" status when null, so non-quote brokers stay tradeable without the spread refinement.

### Beginner Onboarding Wizard
After the guided tour completes, a 6-step wizard dialog asks beginner-friendly questions (goal, risk comfort, capital, interests, time commitment, experience level). Answers are stored as `trading_profile` JSONB on the `profiles` table.

**Flow:** Tour completes → `setWizardPending()` in onboarding store → `WizardProvider` mounts in dashboard layout → dialog opens → user fills out → `saveTradingProfileAndGenerate()` saves profile AND auto-generates first algorithm → redirects to algorithm detail page.

**Key files:**
- `components/onboarding/wizard-dialog.tsx` — the multi-step dialog UI
- `components/onboarding/wizard-provider.tsx` — show/hide logic based on store + DB state
- `lib/utils/derive-trading-params.ts` — pure function mapping answers → algorithm params
- `lib/constants/onboarding.ts` — label maps for wizard options
- `app/(dashboard)/onboarding/actions.ts` — `saveTradingProfileAndGenerate()` server action

**Chat integration:** When `trading_profile` exists, the chat system prompt includes the user's preferences and experience level. For beginners, it instructs the AI to explain concepts in plain language and skip re-asking for asset class/risk/capital.

**Skip path:** Experienced traders can dismiss the wizard at any step. The chat falls back to existing question-by-question behavior when no profile exists.

## Adding New Features

1. Create the page in `src/app/(dashboard)/[feature]/page.tsx`
2. Add components in `src/components/[feature]/`
3. Add Zod validators in `src/lib/validators/[entity].ts`
4. Add TanStack Query hooks in `src/hooks/use-[entity].ts`
5. Add API routes in `src/app/api/[feature]/route.ts` if needed
6. Add Supabase migrations in `supabase/migrations/`
7. Update sidebar nav items in `src/components/layout/sidebar.tsx` and `src/components/layout/mobile-nav.tsx`

## Nav Items

Sidebar and mobile nav share the same items (defined separately in each file):
Dashboard, Trades, Journal, Algorithms, Analytics, Settings

If adding/renaming nav items, update both `sidebar.tsx` and `mobile-nav.tsx`.

## Cron / live trading

Production cron runs on the operator's local Mac via the system `cron` daemon (NOT a separate cron host). See `scripts/README.md` for the schedule, log paths, and the "is the cron alive?" diagnostic. The Mac and `pnpm dev` / `pnpm start` must both be up for any scheduled task to fire — closed lid or sleep stalls the schedule.

Five live cron entrypoints (all in the operator's crontab as of 2026-06-10):
- `manage-cron.sh` (every 5 min) → `/api/cron/manage-positions`
- `scan-cron.sh` (every 15 min — aligned to 15m/1h/4h bar closes) → `/api/cron/scan-active-algorithms`
- `heartbeat-cron.sh` (every 5 min) → `/api/cron/heartbeat` + optional `HEARTBEAT_PING_URL` dead-man ping
- `oanda-positioning-cron.sh` (every 20 min) → `/api/admin/snapshot-oanda-positioning?instruments=XAU_USD`
- `prune-sentiment-cache-cron.sh` (daily 04:00 UTC) → `/api/admin/prune-sentiment-cache`

Each emits `manage_tick` / `scan_started` + `scan_completed` events to `activity_log` so the operator can verify liveness even on no-op ticks.

**Independent alerting:** `.github/workflows/dead-man.yml` (GitHub Actions, every 30 min) calls the anon-executable `last_manage_tick()` RPC and fails — emailing the repo owner — when the heartbeat trail is >45 min stale. Covers the full 2026-05-24 silent-outage chain: Mac asleep → cron dead → zero DB traffic → Supabase free-tier auto-pause (which took the DB offline for 17 days, unnoticed). The 5-min ticks are also what keep the free-tier Supabase project from auto-pausing again.

**Restart-from-idle warning:** restarting the dev server with algos `status='active'` resumes LLM calls and paper trading immediately (the live flag doesn't gate scans — see LLM-Trader section). Run `pnpm dlx tsx scripts/live-state.ts` first; it fails loudly on an unreachable DB.
