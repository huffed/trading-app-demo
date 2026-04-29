# QuantTrader

AI-powered trading autopilot for forex and commodities. Connect a funded broker account, let the AI generate, validate, and execute trading algorithms autonomously.

## What's built

- **Algorithm engine** — backtest + walk-forward + portfolio backtest across 14 forex pairs and 5 commodities
- **Adaptive entry gates** — intraday ATR liquidity, broker spread refusal, regime/ADX filter, news veto, consistency rule
- **Adaptive exit gates** — stop loss, take profit, signal-based exits, stagnant-loser early exit (R-aware)
- **Discipline** — daily loss halt, R-aware consecutive-loss halt, FTMO consistency-rule guard, divergence kill switch, drift detector, auto pair pruning
- **Combinatorial search** (Wave 7) — given (capital, monthly_target, prefer/avoid), the system runs a curated grid of strategy templates × parameters and ranks candidates by walk-forward stability
- **Broker integration** — MetaApi (MT5, including FTMO) live; cTrader Open API ready (KYC pending)
- **Operator UX** — readiness check, drift detector, paper-positions broker P&L sync, scan + manage cron heartbeats, manual flatten escape hatch
- **Onboarding** — beginner wizard collects (goal, risk, capital, interests) and auto-generates a first algorithm

## Tech stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router, `src/`) |
| React | 19 |
| Language | TypeScript 5 strict |
| Styling | Tailwind CSS 4 + shadcn/ui base-nova (Base UI, not Radix) |
| Backend | Supabase (Postgres + Auth + RLS) |
| Server state | TanStack Query 5 |
| Client state | Zustand 5 |
| Validation | Zod 4 |
| LLM | Groq SDK (`llama-3.3-70b-versatile`) |
| Market data | Twelve Data → Yahoo → Alpha Vantage (price fallback chain), Finnhub (calendar + tickers) |
| Brokers | MetaApi MT5 (REST), cTrader Open API (proto over TLS) |

## Setup

```bash
pnpm install
cp .env.example .env.local   # fill in Supabase + Groq + Twelve Data + Finnhub + Alpha Vantage keys
pnpm dev                     # http://localhost:3000
```

Migrations live in `supabase/migrations/` and are applied via the Supabase SQL editor or the MCP `apply_migration` tool. See `CLAUDE.md` for the full workflow.

## Cron / live trading

Production cron runs on the operator's local Mac (system `cron` daemon) — see `scripts/README.md`. Schedule:

| Cadence | Endpoint | Purpose |
|---|---|---|
| every 5 min | `/api/cron/manage-positions` | SL/TP + signal-based exits + stagnant gate + broker P&L sync |
| every hour | `/api/cron/scan-active-algorithms` | Entry evaluation against all active algorithms |
| daily 04:00 UTC | `/api/admin/prune-sentiment-cache` | Cache hygiene |

## Repo & branches

- Repo: https://github.com/huffed/trading-app-demo
- `main` — production-ready
- `dev` — integration branch; merge feature PRs here
- Feature branches: `feat/<short-description>`, off `dev`

`pnpm build` and `pnpm lint` must pass (0 errors) before opening a PR. See `CLAUDE.md` for the full workflow.

## License

Private.
