# QuantTrader

AI-powered quant trading platform for algorithmic trading, multi-broker integration, and intelligent trade journaling.

## Features

- **AI Trading Algorithms** - Generate profitable trading strategies with Claude AI
- **Smart Trading Journal** - AI-analyzed journal with sentiment and emotion tracking
- **Multi-Broker Support** - Connect funded accounts via API (Alpaca, Binance, Bybit, MetaTrader, cTrader, IBKR)
- **Performance Analytics** - P&L tracking, win rate, risk metrics, and visualizations
- **Dark-Mode-First UI** - Clean, minimal interface inspired by Perplexity AI

## Tech Stack

- **Frontend:** Next.js 16 (App Router) + React 19 + TypeScript
- **UI:** shadcn/ui v4 + Tailwind CSS 4
- **Backend:** Supabase (Postgres, Auth, Realtime)
- **AI:** Claude API (Anthropic SDK)
- **State:** TanStack React Query + Zustand

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm (`npm install -g pnpm`)
- A [Supabase](https://supabase.com) project

### Setup

```bash
# Install dependencies
pnpm install

# Copy env template and fill in your Supabase credentials
cp .env.example .env.local

# Run the profiles migration against your Supabase project
# (paste supabase/migrations/00001_create_profiles.sql into the Supabase SQL editor)

# Start dev server
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

### Scripts

```bash
pnpm dev         # Start dev server
pnpm build       # Production build
pnpm lint        # ESLint
pnpm start       # Start production server
```

## Project Status

**Current:** Dashboard widgets, onboarding, and AI chat assistant

**Roadmap:**
1. ~~Trade management (manual entry, CSV import, P&L)~~ ✓
2. ~~Trading journal (rich text, sentiment, AI analysis)~~ ✓
3. ~~AI integration (Claude API, journal auto-analysis)~~ ✓
4. ~~Dashboard widgets (charts, stats, recent trades)~~ ✓
5. ~~AI-guided onboarding & education (tooltips, guided tour, AI chat)~~ ✓
6. AI algorithm generation (natural language to code, paper trading, backtesting)
7. Broker integration (API keys, trade sync, order execution from platform)
8. Advanced analytics (Sharpe ratio, drawdown, heatmaps)
9. Monetization (Stripe billing, WhatsApp/Teams integration)

## License

Private
