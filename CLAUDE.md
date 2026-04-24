@AGENTS.md

# QuantTrader

AI-powered trading platform that works for everyone — from complete beginners to experienced traders. The AI discovers opportunities, builds strategies, manages risk, and (eventually) trades autonomously. No prior trading experience required.

## Product Vision

- **Core:** The AI is the strategist AND the executor. Users don't need trading experience — the AI guides beginners through what to trade and why, while experienced traders can upload history to refine the AI's approach. Human error is where profit is lost — minimize human decision-making.
- **Two entry points:** (1) Beginners — the AI asks about goals, risk comfort, and interests, then builds strategies from scratch. (2) Experienced traders — upload CSV history, AI learns winning patterns and enhances them.
- **Architecture layers:** User Profile (learned from conversation OR CSV) → Discovery Engine (finds opportunities) → Signal Engine (technical + sentiment conditions) → Execution Engine (broker API) → Learning Loop (refines over time).
- **Autonomy levels:** Monitor → Suggest → Semi-auto → Full auto. User progresses as trust builds.
- **Secondary:** Manual trade placement, trade journaling with AI analysis, performance dashboard, educational onboarding.
- **Our app is NOT a broker.** It's a controller that executes on connected brokers (Alpaca, Trading 212, Binance) via their APIs. No brokerage license needed.

## Commands

```bash
pnpm dev         # Start dev server (http://localhost:3000)
pnpm build       # Production build (run to verify before committing)
pnpm lint        # ESLint (0 errors, 0 warnings required)
pnpm lint:fix    # Auto-fix lint issues
pnpm format      # Prettier format all source files
pnpm format:check # Check formatting without writing
pnpm start       # Start production server
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
| AI/LLM | Groq SDK (`groq-sdk`) — llama-3.3-70b-versatile | - |
| Market Data | Twelve Data (prices, primary), Yahoo Finance (prices, fallback), Alpha Vantage (news sentiment), Finnhub (ticker lookup, company profiles) | - |
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
│   ├── ai/
│   │   ├── client.ts           # Groq SDK client + model constant
│   │   └── prompts/            # System prompts: algorithm, chat, backtest, journal, signal
│   ├── market-data/
│   │   ├── alpha-vantage.ts    # Price data fetcher (TIME_SERIES_DAILY)
│   │   ├── news-sentiment.ts   # News sentiment fetcher (NEWS_SENTIMENT) with cache
│   │   ├── sentiment-evaluator.ts # Evaluate sentiment conditions against snapshot
│   │   ├── indicators.ts       # RSI, SMA, EMA, MACD, Bollinger Bands
│   │   ├── backtest-engine.ts  # Run algorithm rules against historical prices
│   │   └── types.ts            # PriceBar, BacktestTrade, BacktestMetrics
│   ├── signals/
│   │   └── evaluate-live.ts    # LLM-powered live signal evaluation orchestrator
│   ├── constants/
│   │   ├── algorithm.ts        # Label maps: asset class, risk, status, operators
│   │   ├── journal.ts          # Label maps: entry type, emotion
│   │   └── prop-firm.ts        # FTMO, Topstep, FundedNext, The5ers presets
│   ├── utils/
│   │   ├── parse-trade-csv.ts  # Trading 212 CSV parser → trade analysis text
│   │   └── pnl.ts              # P&L formatting helpers
│   ├── utils.ts                # cn() - clsx + tailwind-merge
│   └── validators/             # Zod schemas (algorithm, trade, journal)
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

type EntryCondition = TechnicalCondition | SentimentCondition;
```

**Legacy normalization:** Old conditions without a `type` field are auto-normalized to `"technical"` at Zod parse time. No database migration needed — `rules` is JSONB.

**Backtest behavior:** Technical conditions are backtested against price data. Sentiment conditions are filtered out (can't historically backtest news). Results include `backtest_mode: "technical_only"` when sentiment conditions were excluded.

**Live signal check:** For algorithms with sentiment conditions, the algorithm detail page shows a "Live Signal Check" card. Enter a ticker → fetches current news → evaluates sentiment thresholds → LLM assesses narrative/catalyst patterns → returns buy/hold/no_signal with confidence.

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
- `profiles` — extends `auth.users` with app data (auto-created via trigger on signup). Unique: email.
- `trades` — trade records with entry/exit prices, P&L, status (open/closed)
- `journal_entries` — trade reflections with emotion tracking and AI analysis
- `algorithms` — AI-generated trading algorithms with rules (JSONB), backtest results, status. Unique: (user_id, name).
- `sentiment_cache` — cached NEWS_SENTIMENT API responses per ticker/topics, builds historical data. Unique: (user_id, ticker, fetched_at).
- `algorithm_watchlist` — tickers linked to algorithms with backtest metrics. `added_by`: "user" | "ai" | "csv".
- `price_cache` — cached OHLCV bars per ticker/output_size, avoids redundant API calls.

All tables use Row Level Security (RLS). Users can only access their own data.

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
Both API routes (`api/chat/route.ts`, `api/algorithms/generate/route.ts`) validate request bodies with Zod before processing. When adding new API routes, always:
1. Check auth via `supabase.auth.getUser()`
2. Validate the request body with a Zod schema
3. Return typed error responses (not generic 503s)

### Auth Redirect Whitelist
The OAuth callback (`app/(auth)/callback/route.ts`) validates the `next` parameter against an allowed paths whitelist. When adding new protected routes, add them to the `ALLOWED_REDIRECTS` array and the `protectedPrefixes` array in `lib/supabase/middleware.ts`.

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
