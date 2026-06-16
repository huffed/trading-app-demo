/**
 * Re-runs the active "Forex testing" algo's backtest and prints the
 * per-trade list (entry/exit dates, hold duration, PnL, heuristic exit
 * reason). The persisted backtest_results in Supabase store only summary
 * stats — this script regenerates the trade-level detail on demand.
 *
 * Run: pnpm tsx scripts/inspect-active-algo-backtest.ts
 *
 * Rules are embedded as of 2026-04-30. If the active algo's rules
 * change, re-fetch from Supabase and update the constants below.
 */
import { readFileSync } from "fs";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import { fetchDailyPrices } from "../src/lib/market-data/prices";
import type { BacktestTrade, PriceBar } from "../src/lib/market-data/types";
import type { AlgorithmRules } from "../src/types/algorithm";

// Manual env loader.
{
  try {
    const raw = readFileSync(".env.local", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.replace(/^['"]|['"]$/g, "");
    }
  } catch {
    /* ignore */
  }
}

const CAPITAL = 100000;
const TICKERS = ["AUD/USD", "CHF/JPY", "EUR/JPY"];

// Snapshot of the active algo's rules from algorithms row
// 0fda73df-6728-4b69-aa98-f8a29c483466 as of 2026-04-30.
const RULES: AlgorithmRules = {
  side: "long",
  leverage: 100,
  timeframe: "1h",
  asset_class: "forex",
  max_positions: 6,
  max_per_ticker: 2,
  stop_loss: { type: "percentage", value: 1.2 },
  take_profit: { type: "percentage", value: 3.6 },
  position_sizing: { type: "risk_per_trade", value: 0.7 },
  entry_logic: { type: "n_of_m", n: 2 },
  exit_conditions: [],
  entry_conditions: [
    {
      type: "pattern",
      pattern: "daily_bias",
      direction: "bullish",
      ma_period: 20,
      timeframe: "1d",
    },
    {
      type: "pattern",
      pattern: "liquidity_sweep",
      lookback: 5,
      direction: "bullish",
      timeframe: "1h",
    },
    { type: "pattern", pattern: "fvg", direction: "bullish", timeframe: "1h" },
    {
      type: "pattern",
      pattern: "ifvg",
      lookback: 5,
      direction: "bullish",
      timeframe: "1h",
    },
    {
      type: "pattern",
      pattern: "liquidity_sweep",
      lookback: 5,
      direction: "bullish",
      timeframe: "4h",
    },
  ],
  prop_firm: {
    daily_loss_limit: 5,
    max_drawdown: 10,
    profit_target: 10,
    max_consecutive_losses: 0,
    consecutive_loss_unit: "days",
    consecutive_loss_daily_halt: 3,
    daily_loss_halt_pct: 80,
    consistency_rule: 40,
    slippage_bps: 10,
    commission_pct: 0.1,
    commission_per_lot: 7,
  },
  news_veto: {
    enabled: true,
    block_minutes_before: 60,
    block_minutes_after: 60,
    min_impact: "high",
  },
  divergence_kill: { max_avg_bps: 20, window_trades: 10 },
  regime_filter: {
    enabled: false,
    atr_period: 20,
    lookback_days: 90,
    percentile_floor: 0.5,
  },
  adx_filter: { enabled: false, adx_period: 14, min_adx: 25 },
  stagnant_exit: {
    enabled: true,
    max_bars: 48,
    min_excursion_r: 0.1,
    min_pnl_r: -0.5,
  },
};

interface ClassifiedTrade extends BacktestTrade {
  hold_hours: number;
  exit_reason_label: string;
}

const TP_PCT = (RULES.take_profit.value as number) / 100;
const SL_PCT = (RULES.stop_loss.value as number) / 100;
const TOLERANCE = 0.001;

function classifyExit(t: BacktestTrade): string {
  if (t.entry_price <= 0) return "unknown";
  const ratio = t.exit_price / t.entry_price;
  const tpRatio = t.side === "long" ? 1 + TP_PCT : 1 - TP_PCT;
  const slRatio = t.side === "long" ? 1 - SL_PCT : 1 + SL_PCT;
  if (Math.abs(ratio - tpRatio) <= TOLERANCE) return "TP hit";
  if (Math.abs(ratio - slRatio) <= TOLERANCE) return "SL hit";
  if (t.pnl > 0) return "early-exit (win)";
  if (t.pnl < 0) return "early-exit (loss)";
  return "flat";
}

function holdHours(t: BacktestTrade): number {
  const ms =
    new Date(t.exit_date).getTime() - new Date(t.entry_date).getTime();
  return ms / 3600000;
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "0.0";
  return ((numerator / denominator) * 100).toFixed(1);
}

async function main(): Promise<void> {
  console.log("Inspecting active algo backtest");
  console.log(`  capital  : $${CAPITAL.toLocaleString()}`);
  console.log(`  tickers  : ${TICKERS.join(", ")}`);
  console.log(
    `  rules    : ${RULES.timeframe} · ${RULES.position_sizing.value}% risk · SL ${SL_PCT * 100}% / TP ${TP_PCT * 100}% · ${RULES.entry_conditions.length}-pattern n_of_m=${RULES.entry_logic && typeof RULES.entry_logic === "object" ? RULES.entry_logic.n : "all"}`
  );
  console.log("");

  const pricesByTicker = new Map<string, PriceBar[]>();
  console.log("Fetching prices...");
  for (const ticker of TICKERS) {
    try {
      const bars = await fetchDailyPrices(ticker, "full", "1h");
      pricesByTicker.set(ticker, bars);
      const first = bars[0]?.date ?? "?";
      const last = bars[bars.length - 1]?.date ?? "?";
      console.log(`  ${ticker.padEnd(8)} ${bars.length} bars  (${first} → ${last})`);
    } catch (err) {
      console.log(`  ${ticker} FAILED: ${(err as Error).message}`);
    }
  }
  console.log("");

  const start = Date.now();
  const result = runPortfolioBacktest(RULES, pricesByTicker, CAPITAL, []);
  const duration = ((Date.now() - start) / 1000).toFixed(1);

  const trades: ClassifiedTrade[] = result.trades.map((t) => ({
    ...t,
    hold_hours: holdHours(t),
    exit_reason_label: classifyExit(t),
  }));

  console.log(`Backtest complete in ${duration}s`);
  console.log(
    `  total_trades : ${result.total_trades}  (win_rate ${result.win_rate.toFixed(1)}%, total_return $${result.total_return.toFixed(2)}, max_dd ${result.max_drawdown.toFixed(2)}%)`
  );
  console.log("");

  // Exit-reason breakdown
  const reasonCounts = new Map<string, { count: number; pnl: number }>();
  for (const t of trades) {
    const r = reasonCounts.get(t.exit_reason_label) ?? { count: 0, pnl: 0 };
    r.count++;
    r.pnl += t.pnl;
    reasonCounts.set(t.exit_reason_label, r);
  }
  console.log("Exit-reason breakdown:");
  for (const [reason, stats] of reasonCounts) {
    console.log(
      `  ${reason.padEnd(20)} ${String(stats.count).padStart(3)}  (${pct(stats.count, trades.length).padStart(5)}%)  net pnl $${stats.pnl.toFixed(0)}`
    );
  }
  console.log("");

  // Hold-duration histogram
  const buckets = [
    { name: "< 4h", max: 4 },
    { name: "4-12h", max: 12 },
    { name: "12-24h", max: 24 },
    { name: "1-2d", max: 48 },
    { name: "2-5d", max: 120 },
    { name: "5d+", max: Infinity },
  ];
  const histo = buckets.map((b) => ({
    name: b.name,
    count: trades.filter(
      (t) =>
        t.hold_hours <
          (buckets[buckets.findIndex((x) => x.name === b.name) - 1]?.max ?? 0) +
            (b.max - (buckets[buckets.findIndex((x) => x.name === b.name) - 1]?.max ?? 0)) &&
        t.hold_hours <= b.max
    ).length,
  }));
  // simpler: compute manually
  const counts: Record<string, number> = {};
  for (const t of trades) {
    let bucket = "5d+";
    for (let i = 0; i < buckets.length; i++) {
      if (t.hold_hours <= buckets[i].max) {
        bucket = buckets[i].name;
        break;
      }
    }
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  console.log("Hold-duration distribution:");
  for (const b of buckets) {
    const n = counts[b.name] ?? 0;
    if (n > 0) {
      console.log(
        `  ${b.name.padEnd(8)} ${String(n).padStart(3)}  (${pct(n, trades.length).padStart(5)}%)`
      );
    }
  }
  void histo;
  console.log("");

  // Per-trade list
  console.log("Per-trade detail:");
  console.log(
    `  ${"ticker".padEnd(8)} ${"side".padEnd(5)} ${"entry".padEnd(20)} ${"exit".padEnd(20)} ${"hold".padStart(7)}  ${"pnl".padStart(8)}  reason`
  );
  for (const t of trades) {
    const entry = t.entry_date.replace("T", " ").slice(0, 16);
    const exitDate = t.exit_date.replace("T", " ").slice(0, 16);
    const hold =
      t.hold_hours < 24
        ? `${t.hold_hours.toFixed(1)}h`
        : `${(t.hold_hours / 24).toFixed(1)}d`;
    console.log(
      `  ${(t.ticker ?? "?").padEnd(8)} ${t.side.padEnd(5)} ${entry.padEnd(20)} ${exitDate.padEnd(20)} ${hold.padStart(7)}  $${t.pnl.toFixed(0).padStart(7)}  ${t.exit_reason_label}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
