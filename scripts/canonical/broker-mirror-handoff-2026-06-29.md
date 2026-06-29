# Broker Mirror Handoff — 3-algo Gold Portfolio → FTMO Demo $100K

**Date:** 2026-06-29 NIGHT+3
**Verdict:** DB-side configuration COMPLETE. **2 operator-required steps before orders flow.**

## What I configured (autonomously)

3 deployed algos updated via `scripts/canonical/enable-broker-mirror.ts`:

| Algo | Capital | Risk | Broker | Live |
|---|---|---|---|---|
| `Deploy: XAU/USD ARB+DailyBias 4h \| r085 v1` (id `1ebdce3d-...`) | **$100,000** | 0.80% | FTMO Test $100k | **TRUE** |
| `Deploy: XAU/USD Engulfing+DailyBias 4h \| r080 v1` (id `824b6e40-...`) | **$100,000** | 0.80% | FTMO Test $100k | **TRUE** |
| `Deploy: XAU/USD ARB25+DailyBias 4h \| r080 v1` (id `f4b56c3a-...`) | **$100,000** | 0.80% | FTMO Test $100k | **TRUE** |

All 3 now point at `broker_connection_id = c508808c-e799-444e-a34e-47c36af23bc4` (FTMO Test $100K MetaApi MT5). Capital matches broker account so 0.80% risk = $800 per trade per algo, 2.4% combined cap (within 4% prop_firm cap + FTMO 5% daily).

## What you must do for orders to actually flow

The readiness checker (`scripts/canonical/broker-mirror-readiness-check.ts`) ran and surfaced **2 blockers requiring your action**:

### Blocker 1: Broker token likely expired (last_synced 18.3 days ago)

```
✗ Broker last synced 438.1h ago — token likely expired.
```

**Action:** open the app at `http://localhost:3000/settings/brokers`, find "FTMO Test $100k", re-authenticate (MetaApi token refresh). After re-auth, `last_synced_at` should update + `status` stays `active`.

### Blocker 2: Mac cron not running (last fired 2026-06-23 EVE)

```
✗ Scan cron last fired 8391 min ago (>35min stale)
✗ Manage cron last fired 8391 min ago (>15min stale)
```

**Action:** restart the cron entries on your Mac. Per `scripts/README.md` schedule:

```
*/15 7-23 * * 1-5  cd /Users/jack.jones/Documents/trading-app/demo-1 && ./scripts/scan-cron.sh
*/5 7-23 * * 1-5   cd /Users/jack.jones/Documents/trading-app/demo-1 && ./scripts/manage-cron.sh
*/5 * * * *        cd /Users/jack.jones/Documents/trading-app/demo-1 && ./scripts/heartbeat-cron.sh
```

Verify with `crontab -l`. If empty/missing, install per scripts/README.md.

Also: `pnpm dev` (or `pnpm start`) must be running locally so the cron scripts can hit `http://localhost:3000/api/cron/*` endpoints.

## How to verify everything is green

```bash
pnpm dlx tsx scripts/canonical/broker-mirror-readiness-check.ts
```

Expect 6 ✓ checks (broker connection synced + 3 algos configured + scan/manage alive + price_cache fresh + no halts + no stale open positions). Exit code 0 = ready.

## What happens next (once both blockers cleared)

1. **Next scan tick** (~every 15 min) → engine evaluates each algo against current 4h bar
2. **First entry signal** (Engulfing OR ARB OR ARB25 + daily_bias all = bullish on 4h bar close) → engine opens paper position internally AND mirrors order to FTMO Test $100k via MetaApi
3. **Position open** → `paper_positions` row with `broker_position_id` populated; visible on FTMO Trader app
4. **SL/TP hit OR signal exit** → engine closes both paper + broker positions; trade recorded
5. Trade rate per backtest: ~15 trades/yr per algo × 3 algos = ~45 trades/yr portfolio = ~3-4 trades/month total

## Critical risk-management notes (already enforced)

- **FTMO Max Loss 10%** ($90K floor on $100K account): empirical stress test showed 0/529 challenge windows breached this floor. **9.11% worst-case** with 1% buffer.
- **FTMO Daily 5%** ($5K daily loss limit): empirical worst window 3.46%, 1.5% buffer.
- **portfolio_halt.ts + risk_pool_halt.ts** enforce sibling coordination — if combined daily PnL across all 3 algos approaches the cap, halts kick in BEFORE breach.
- **alpha-decay-cron** (G.4) auto-pauses any algo whose live Sharpe sustains below in-sample baseline.
- **dead-man-switch** (G.2 + GitHub Actions) alerts if cron silent >30 min.

## Reversal commands (paste-ready)

**Full revert to paper-only (broker mirror OFF):**
```sql
UPDATE algorithms SET live_trading_enabled=false, broker_connection_id=NULL, capital=10000
WHERE name LIKE 'Deploy: %';
```

**Archive all 3 entirely:**
```sql
UPDATE algorithms SET status='archived' WHERE name LIKE 'Deploy: %';
```

**Re-deploy from scratch if needed:**
```bash
pnpm dlx tsx scripts/canonical/deploy-arb-daily-bias.ts
pnpm dlx tsx scripts/canonical/deploy-multi-algo-portfolio.ts
pnpm dlx tsx scripts/canonical/enable-broker-mirror.ts
```

## Where this fits in the roadmap

- **G.6 ✓** — algo design + ship config (multi-algo portfolio at 0.80% risk each)
- **G.7 (current phase)** — Demo period: 3-6 months for gold 4h. Goal: ≥30 demo trades per algo within ±30% of in-sample mean-R per `[[feedback_live_mirror_milestone]]`
- **G.8** — Demo gate evaluation at 30 trades
- **G.9** — Branch: real FTMO challenge OR back to research

This handoff doc + `enable-broker-mirror.ts` + `broker-mirror-readiness-check.ts` are committed to dev branch.
