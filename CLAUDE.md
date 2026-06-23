@AGENTS.md

# QuantTrader

A **personal autonomous trading system** for a single operator (not a SaaS — no users planned). An LLM (Anthropic Haiku) makes per-bar discretionary entry decisions; a deterministic engine handles everything enforceable — SL/TP geometry, gates, halts, sizing, broker mirroring. Goal: pass FTMO challenges and scale to multiple funded accounts. Current library: gold + USD/JPY + EUR/USD + GBP/USD.

## Product Vision (updated 2026-06-23 LATE)

- **Active forward plan:** see `scripts/canonical/ROADMAP.md` (canonical, version-controlled). Phases F → G → H → I, single linear sequence, no parallel branches. Each phase has formal pass/fail gates.
- **Where we are right now:** Phase F (overfit gating) — building deflated Sharpe + PBO + purged k-fold CV before any deploy. The current Stage 6.7 acceptance packet at `scripts/canonical/algo-search-acceptance.md` is DEFERRED until F.4–F.6 v3 re-evaluation. ~5 working days of math.
- **Core division of labor:** the engine owns exits, risk, and execution (always). Algos under Phase E v2 are deterministic rules-based (no LLM in production scan path right now); LLM-trader path is Phase I.3 (paid, last). When restored, the LLM picks entries and the engine still owns exits — every dataset endorses that split (LLM mid-trade exits cost ~−24% R per the 2026-06-10 PR #178 replay).
- **Current focus:** gold-only demo deployment per `[[feedback_gold_only_demo_stage]]`. The Phase E sweep produced 3 strong singleton candidates (BOS-Long / Engulfing-Long / Sweep-Long, all XAU/USD 4h) which Phase F re-evaluates under overfit-adjusted statistics before any operator stamp. Forex re-research deferred to Phase I.4 (after ≥1 stable gold demo player).
- **Budget reality:** ≤£150/month total. Phase F + G build is $0 (no LLM calls). Phase H feature library + xgboost may require Python sidecar; still $0 inference. The harness enforces `LLM_MONTHLY_BUDGET_USD` (default $25) with a hard process-exit if/when LLM-trader is restored at I.3.
- **Our app is NOT a broker.** Controller that executes on connected brokers (MetaApi MT5 primary; cTrader Open API dormant by design).
- **Dormant-by-design surfaces (updated 2026-06-17 PR #269):** chat-creates-algorithm + onboarding wizard + algorithm-generate wizards DELETED in PR #269. **Still dormant-by-design and not to be deleted/extended:** journal pages + components, trades page + CSV import, stocks scaffolding, cTrader Open API (see `[[feedback_keep_ctrader]]`). The Groq SDK + `src/lib/ai/client.ts` stay because journal analysis + combinatorial-search template selector + LLM-trader fallback still use them.

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

## Domain Glossary (CB.G1)

Use these terms consistently. Mixing them is a frequent source of bugs (and lost time in code review). Canonical meanings:

| Term | Meaning | Use when |
|---|---|---|
| **Strategy** | An umbrella concept — a reusable rule template (`rules_template` JSONB on the `strategies` table). One strategy can have many algorithm instances. | Talking about the conceptual approach (e.g. "the FVG-DailyBias strategy"). |
| **Algorithm** | A single deployed instance of a strategy — a row in the `algorithms` table with its own `rules` JSONB, `capital`, `status`, watchlist, and broker connection. The canonical name in DB, types, and external APIs. | Anywhere persisted: DB schema, types, server actions, external APIs. |
| **algo** | Shorthand for `Algorithm` — local variable name only. Never appears in DB, types, or function signatures; only in tight scopes (`for (const algo of algos)`). | Local-scope variable naming inside a function. |
| **ticker** | The in-app symbol for an instrument (e.g. `XAU/USD`, `EUR/USD`). Used by `algorithms.ticker`, `algorithm_watchlist.ticker`, anything operator-facing. | Anywhere in app code, UI, DB rows. |
| **symbol** | The broker-API symbol (e.g. MetaApi's `XAUUSD`, cTrader's `XAU/USD`). Differs per broker; translated at the adapter boundary. | Only inside broker adapter code (`lib/brokers/*`). |
| **position** | A trade in OPEN or CLOSED state — a row in `paper_positions` (and its mirror to the broker when live). Has `status: "open" | "closed"`, entry/exit prices, realized/unrealized P&L. | Anywhere referring to a tradable lifecycle: open + close + manage. |
| **trade** | A historical record of a completed round-trip (not a live tradable state). Used for backtest output (`BacktestTrade`), cohort attribution, journal entries. | Backtest analytics, retrospective metrics, journal/cohort tooling. |
| **order** | A broker order placement — the network call to the broker to open/close a position. Lives only on the broker adapter layer. | Broker adapter code; never appears at the application layer. |

`Strategy` ≠ `Algorithm`, `ticker` ≠ `symbol`, `position` ≠ `trade`. When in doubt, default to the more general term and let context narrow it.

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

### Validation economics — HISTORICAL (LLM-trader harness archived 2026-06-18)

The LLM-trader harness (`scripts/llm-trader-backtest.ts` + `scripts/llm-trader-walk-forward.ts`) is in `scripts/archive/2026-06-18/`. LLM-trader work is deferred to roadmap STEP 12 / Phase D.4 (paid, last). The hard-won rules below applied to that harness; if/when LLM-trader is reactivated, restore from archive + re-validate.

- **`SL_PRESET=baseline|live|comboC`** pinned the full SL/TP geometry; omitting it ran harness defaults (pct 1.5%/4.5%) which are NOT live config.
- **`REPLAY_CACHE=1`** memoised responses on disk — re-running an unchanged config costs $0.
- **Rate limiter + jittered backoff** (`LLM_RPM`/`LLM_TPM`/`LLM_MAX_ATTEMPTS`) — the 2026-05-18 cascade wasted ~67% of a sweep.
- **`LLM_MONTHLY_BUDGET_USD` (default $25)** — per-month spend ledger; process exits before exceeding. £150/month ceiling structural.

**For the CURRENT canonical validator** (free, replaces this harness for library algos): see `scripts/canonical/validate-algo.ts` + `scripts/README.md` env var reference. Phase B fidelity gates section below covers the new pipeline.

## Pre-deploy validation — SUPERSEDED 2026-06-23 LATE by `scripts/canonical/ROADMAP.md`

The "canonical 4-way validation for library algos" (established 2026-06-16, PRs
#258 + #259) was the Stage 4-era methodology. Phase E adopted a more rigorous
spec at `scripts/canonical/algo-search.spec.md`; Phase F (per ROADMAP.md)
adds formal overfit-adjusted statistics before any deploy. The 4-way scripts
referenced below (`scripts/library-walk-forward.ts`, `scripts/sweep-algo-geometry.ts`)
are in `scripts/archive/2026-06-18/`.

**For current pre-deploy validation:**
- Layer A enumeration + per-candidate v2 criteria → `scripts/canonical/algo-search.ts MODE=full` + `src/lib/algo-search/criteria.ts` + `src/lib/algo-search/state.ts`
- Layer B geometry sweep on per-candidate passers → `scripts/canonical/algo-search.ts MODE=layer-b BASE_NAMES=...`
- Phase F overfit gating (deflated Sharpe + PBO + purged k-fold CV) → BUILD PENDING per ROADMAP.md Phase F
- Pre-registration in writing BEFORE any live trade → `scripts/canonical/preregistration.json` + `scripts/canonical/validate-preregistration.ts`
- Operator-stamp acceptance packet → `scripts/canonical/algo-search-acceptance.md` (currently DEFERRED until F.6)

**KEPT from the 4-way era (don't lose):**
- Per-instrument friction calibration (gold: slippage 0.5 bps + spread 0.4 bps; forex: catalog defaults pending B.1.8.a sampling). Realised in `prop_firm.slippage_bps` / `spread_bps` per-algo.
- Per-window walk-forward decomp (aggregate stats hide chop-year disasters). Realised in validate-algo's step3 walk-forward windowing.
- 10% static DD hard gate + 5% daily DD hard gate (FTMO). Realised in v2/v3 spec §4 criteria 3–4.
- Direction-split (bullish vs bearish enumerated separately) per `[[feedback_direction_split_first]]`. Realised in Layer A enumerator.
- "Don't change live geometry on backtest alone." A/B paper period per `[[feedback_iterate_only_validated_baselines]]` → enforced by Stage G.7 demo period in ROADMAP.md (3–6 months before real challenge).
- Persist `backtest_results` JSONB on deploy (powers /reports Promotion Eligibility tab + alpha decay monitoring). Realised in `algorithms.backtest_results` writes via validate-algo PERSIST=1.

**Reports** historically lived at `scripts/REVALIDATION_REPORT_<date>.md`; under
Phase E the equivalent lives in the algorithms table + `/reports?tab=search` UI.
Acceptance packets at `scripts/canonical/*-acceptance.md`.

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
- `activity_log` — every event the scan/manage cron emits. `event_type` is a SQL CHECK constraint; the newest migration replacing the CHECK is currently 00046 (which added `cron_idle` for the 0-active-algos heartbeat per SG.19). Read for "did the gate fire?" questions; powers `/reports` via `src/lib/cohort/engine-activity.ts`.
- `broker_connections` — operator's broker creds per provider (`metaapi` / `ctrader`). RLS-scoped.
- `sentiment_cache` — NEWS_SENTIMENT cache per ticker/topics.
- `price_cache` — OHLCV bars per ticker/interval (global since 00037).
- `llm_decisions` — per-bar LLM-trader audit trail. Backfilled with trade outcome on close. Migration 00031 + 00035.
- `oanda_positioning_cache` — OANDA positionBook snapshots every 20 min. Migration 00034.
- `paper_positions_archive` — archived position rows (migration 00033).
- `trades`, `journal_entries` — dormant per the personal-operator workflow (kept per dormant-by-design policy).
- `public.last_manage_tick()` + `public.last_scan_tick()` — SECURITY DEFINER functions for the GitHub Actions dead-man switch. `last_manage_tick()` from migration 00039; `last_scan_tick()` added 2026-06-15 to decouple scan-heartbeat staleness (35-min threshold, 2+ consecutive 15-min misses) from manage-heartbeat (45-min threshold). Migration 00046 extends both to count `cron_idle` rows tagged with `details.cron in ('scan','manage')` so 0-active-algos no-op ticks keep the dead-man green.

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
`lib/scan/consec-loss-halt.ts` (live) — 3-strikes daily halt counting only losses ≥ 0.25R (the file's `SIGNIFICANT_LOSS_R_THRESHOLD`). Micro stagnant-cut nips don't reset OR count toward the streak. **Backtest equivalent (Phase B.1.1, 2026-06-18):** `closeSimPosition` in `lib/market-data/prop-firm-backtest.ts` applies the same 0.25R filter when the position carries `slDistance`. PortfolioPosition (portfolio-backtest) populates slDistance; backtest-engine.ts simpler positions don't, so those callers preserve legacy "any loss counts" behaviour.

### FTMO Consistency Halt
`lib/scan/consistency-halt.ts` — refuses new entries on a day whose net profit ≥ N% of total accumulated profit (FTMO challenge: 40%). Live-only; backtest flags violations end-of-run.

### Combinatorial Search (Wave 7)
`lib/algorithm/combinatorial-search.ts` — given `(capital, monthly_target_pct, prefer/avoid)`, runs a curated grid of 8 strategy templates × 4 timeframe / SL-TP combos through walk-forward. Admin endpoint at `POST /api/admin/combinatorial-search`.

### Position-Size Sanity Gate
`lib/scan/live-execution.ts` — refuses live orders with implied notional > 30× capital. The CHF/JPY blow-up was 67× — this gate would have caught it.

### Phase B.1 backtest fidelity gates (B.1.13)

Seven live-only behaviours now simulated in `lib/market-data/portfolio-backtest.ts` so backtest verdicts reflect live execution. Each defaults OFF for backwards-compat; the canonical validator (`scripts/canonical/validate-algo.ts`) enables all seven via env vars (`SIBLINGS`, `SPREAD_GATE`, `RISK_POOL`, `FTMO_TERMINATION`, `RE_ENTRY_COOLDOWN`, `PORTFOLIO_HALT`, plus the in-engine R-aware consec-loss; the 7th, R-aware consec-loss, fires automatically when positions carry `slDistance`).

| Gate | Live counterpart | Backtest implementation | Test file |
|---|---|---|---|
| Direction conflict | `scan/entry.ts:checkDirectionConflict` | `hasDirectionConflict` — sibling opposite-side window blocks entry | `portfolio-backtest-direction-conflict.test.ts` |
| Spread (ATR proxy) | `algorithm/spread-gate.ts` (bid/ask) | `hasWideSpreadProxy` — current ATR / median ATR > 2.5× | `portfolio-backtest-spread-gate.test.ts` |
| Risk-pool halt | `scan/risk-pool-halt.ts` | `hasRiskPoolBreach` — combined sibling risk_dollars vs pool_cap_pct | `portfolio-backtest-risk-pool.test.ts` |
| FTMO termination | implicit (FTMO closes account on DD breach) | force-close all + break timeline on `s.drawdownBreached` | `portfolio-backtest-ftmo-termination.test.ts` |
| R-aware consec-loss | `scan/consec-loss-halt.ts` | `closeSimPosition` skips losses < 0.25R when slDistance present | `portfolio-backtest-consec-loss.test.ts` |
| Re-entry cooldown | `algorithm/re-entry-cooldown.ts` | `state.lastLossExitDate` + `hasReEntryCooldownActive` | `portfolio-backtest-re-entry-cooldown.test.ts` |
| Portfolio DLL halt | `scan/portfolio-halt.ts` | `hasPortfolioHaltBreach` — sibling daily PnL map + DLL pct | `portfolio-backtest-portfolio-halt.test.ts` |

Integration test (`portfolio-backtest-gates-integration.test.ts`) verifies all seven compose without crashes/NaN.

**Caller policy (B.1.9, READ BEFORE EDITING).** Only `scripts/canonical/validate-algo.ts` is trusted for ship/no-ship verdicts. Six other `runPortfolioBacktest` callers (`walk-forward.ts`, `(dashboard)/backtest/actions.ts`, `algorithms/backtest-run-actions.ts`, `algorithms/[algoId]/validate/actions.ts`, `api/admin/loser-analysis/route.ts`, `api/admin/inspect-backtest/route.ts`) intentionally run with gates OFF for diagnostic work — trade-flow inspection, sensitivity analysis, cohort review. If their numbers diverge from validate-algo's, that divergence IS the fidelity-gate impact; don't "fix" the diagnostic callers.

**Portfolio modelling (B.1.7).** Algos sharing `algorithms.broker_connection_id` form a portfolio sharing one account. Validate-algo filters siblings to same-broker only and uses `broker_connections.account_capital` (migration 00045) as `reference_capital`. Cross-broker contamination was killing 84% of sweep_reclaim 4h's entries pre-fix. Algos with null `broker_connection_id` are treated as standalone (empty sibling list — `null === null` would have lumped them into an implicit no-broker group, wrong).

**Known semantic notes:**
- **Risk-pool nominal vs actual (B.1.6):** backtest uses `capital × risk_pct` (nominal); live uses `(entry - SL) × qty` (actual). Under `risk_per_trade` sizing these converge — 100% of deployed algos use RPT sizing so the gap is zero. Revisit only if non-RPT sizing modes go live.
- **Spread-gate proxy (B.1.8):** ATR-ratio proxy for live bid/ask is a stress-period inference, NOT a validated correlation. 2.5× multiplier carried from the live gate's catalog calibration; the ATR↔spread mapping is plausible but unproven. Directionally correct (high vol → more refusals), not magnitude-correct. To validate properly, capture ≥50 broker spread samples per symbol + matching ATRs + measure correlation.
- **Portfolio-halt unrealized P&L:** backtest sums sibling REALIZED P&L only; live sums realized + unrealized. Risk-pool's 4% cap (vs DLL 5%) bounds the unrealized contribution below the threshold, so the scenario where realized-only would miss the trip is mathematically prevented. See `feedback_portfolio_halt_realized_only.md` for the reasoning.

See `project_roadmap_2026_06.md` Phase B.1 for the implementation history + the resolved 33-issue audit punch list.

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

Each emits `manage_tick` / `scan_started` + `scan_completed` events to `activity_log` so liveness is verifiable on no-op ticks. With 0 active algos the scan + manage crons emit `cron_idle` instead (SG.19; `src/lib/scan/cron-idle.ts` + migration 00046) — keeps the dead-man switch + dashboard heartbeat rail showing "idle ✓" rather than "stale ✗" during the demo gap before un-pause.

**Independent alerting:** `.github/workflows/dead-man.yml` (GitHub Actions, every 30 min) calls TWO anon-executable RPCs — `last_manage_tick()` (alerts >45 min stale) AND `last_scan_tick()` (alerts >35 min stale, i.e. 2+ consecutive missed 15-min scans) — plus a dual-attempt broker-API liveness probe (30s retry, flags 5xx). Decoupled so scan failures don't mask manage failures and vice versa. Covers the 2026-05-24 silent-outage chain (Mac asleep → cron dead → zero DB traffic → Supabase free-tier auto-pause for 17 days unnoticed). The 5-min ticks also keep the free-tier Supabase project from auto-pausing.

**Alert channels (G.2):** GitHub's default email-on-failure routes to repo-owner notification settings — not testable from CI, and silently broken if the operator filters GitHub emails. The workflow's `notify-failure` job adds a redundant phone-push channel via [ntfy.sh](https://ntfy.sh) (free, no account, push within seconds). Setup is opt-in:

1. Pick a random secret topic string (e.g. `qtrader-deadman-7x9k2`). Anyone with the topic can read its messages — treat as a secret.
2. Install the `ntfy` app on the phone (iOS / Android, free, open-source) and subscribe to that topic.
3. Set repo secret `NTFY_TOPIC` to the string from step 1: `gh secret set NTFY_TOPIC --body 'qtrader-deadman-7x9k2'`.
4. Validate: `gh workflow run dead-man.yml -f fire_test_alert=true --ref dev` — the workflow fires a non-urgent "TEST ALERT — ignore" push within ~30s of completion. Real-outage pushes use `Priority: urgent` (bypasses Do Not Disturb on the ntfy app).

If `NTFY_TOPIC` is unset the redundant channel is skipped silently with a workflow-warning (only GitHub email alerts). The gate "test alert reaches operator's phone within 5 minutes" is operator-verifiable via step 4.

**Restart-from-idle warning:** restarting the dev server with algos `status='active'` resumes LLM calls and paper trading immediately (the live flag doesn't gate scans — see LLM-Trader section). Run `pnpm dlx tsx scripts/live-state.ts` first; it fails loudly on an unreachable DB.
