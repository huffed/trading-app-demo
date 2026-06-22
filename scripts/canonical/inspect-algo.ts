/**
 * Generalized backtest re-runner for any algorithm by ID. Fetches rules
 * + watchlist from Supabase, fetches the price corpus, runs the
 * production backtest engine, and prints per-trade detail (entry/exit
 * dates, hold duration, PnL, heuristic exit reason) plus aggregates.
 *
 * Usage:
 *   ALGO_ID=<uuid> pnpm tsx scripts/inspect-algo.ts
 *
 * Env:
 *   ALGO_ID  required — the algorithm row to re-run
 *   NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — for the row fetch
 *   TWELVE_DATA_API_KEY etc. — for price fetches via the price-provider chain
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { runPortfolioBacktest } from "../../src/lib/market-data/portfolio-backtest";
import { fetchDailyPrices } from "../../src/lib/market-data/prices";
import { timeframeToInterval, type BarInterval } from "../../src/lib/market-data/interval";
import type { BacktestMetrics, BacktestTrade, PriceBar } from "../../src/lib/market-data/types";
import type { AlgorithmRules } from "../../src/types/algorithm";

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

interface ClassifiedTrade extends BacktestTrade {
  hold_hours: number;
  exit_reason_label: string;
}

function classifyExit(t: BacktestTrade, rules: AlgorithmRules): string {
  if (t.entry_price <= 0) return "unknown";
  const tpPct = rules.take_profit.value / 100;
  const slPct = rules.stop_loss.value / 100;
  const ratio = t.exit_price / t.entry_price;
  const tpRatio = t.side === "long" ? 1 + tpPct : 1 - tpPct;
  const slRatio = t.side === "long" ? 1 - slPct : 1 + slPct;
  const TOL = 0.001;
  if (Math.abs(ratio - tpRatio) <= TOL) return "TP hit";
  if (Math.abs(ratio - slRatio) <= TOL) return "SL hit";
  if (t.pnl > 0) return "early-exit (win)";
  if (t.pnl < 0) return "early-exit (loss)";
  return "flat";
}

function holdHours(t: BacktestTrade): number {
  return (new Date(t.exit_date).getTime() - new Date(t.entry_date).getTime()) / 3600000;
}

function pct(n: number, total: number): string {
  if (total === 0) return "0.0";
  return ((n / total) * 100).toFixed(1);
}

interface AlgoRow {
  id: string;
  name: string;
  capital: number;
  rules: AlgorithmRules;
}

interface WatchlistRow {
  ticker: string;
}

async function main(): Promise<void> {
  const algoId = process.env.ALGO_ID;
  if (!algoId) throw new Error("ALGO_ID env var required");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: algo, error: algoErr } = await supabase
    .from("algorithms")
    .select("id, name, capital, rules")
    .eq("id", algoId)
    .single();
  if (algoErr || !algo) {
    throw new Error(`Could not fetch algo ${algoId}: ${algoErr?.message ?? "not found"}`);
  }
  const algoRow = algo as AlgoRow;

  const { data: watchlist, error: wlErr } = await supabase
    .from("algorithm_watchlist")
    .select("ticker")
    .eq("algorithm_id", algoId);
  if (wlErr || !watchlist) {
    throw new Error(`Could not fetch watchlist: ${wlErr?.message}`);
  }
  const tickers = (watchlist as WatchlistRow[]).map((w) => w.ticker);

  console.log(`Inspecting algo: ${algoRow.name}`);
  console.log(`  id        : ${algoRow.id}`);
  console.log(`  capital   : $${Number(algoRow.capital).toLocaleString()}`);
  console.log(`  tickers   : ${tickers.join(", ")}`);
  console.log(
    `  rules     : ${algoRow.rules.timeframe} · ${algoRow.rules.position_sizing.type}=${algoRow.rules.position_sizing.value}% · SL ${algoRow.rules.stop_loss.value}% / TP ${algoRow.rules.take_profit.value}% · side=${algoRow.rules.side ?? "long"}`
  );
  console.log("");

  const interval: BarInterval = timeframeToInterval(algoRow.rules.timeframe);
  console.log("Fetching prices...");
  const pricesByTicker = new Map<string, PriceBar[]>();
  for (const ticker of tickers) {
    try {
      const bars = await fetchDailyPrices(ticker, "full", interval);
      pricesByTicker.set(ticker, bars);
      const first = bars[0]?.date ?? "?";
      const last = bars[bars.length - 1]?.date ?? "?";
      console.log(`  ${ticker.padEnd(10)} ${interval.padEnd(5)} ${bars.length} bars  (${first} → ${last})`);
    } catch (err) {
      console.log(`  ${ticker} FAILED: ${(err as Error).message}`);
    }
  }
  console.log("");

  // Optional: overlay trailing-stop + breakeven + DXY-filter config on
  // the algo's rules to see the uplift WITHOUT modifying the persisted
  // row.
  const trailingEnabled =
    process.env.TRAILING_ENABLED === "true" || process.env.TRAILING_ENABLED === "1";
  const breakevenEnabled =
    process.env.BREAKEVEN_ENABLED === "true" || process.env.BREAKEVEN_ENABLED === "1";
  const dxyEnabled =
    process.env.DXY_FILTER_ENABLED === "true" || process.env.DXY_FILTER_ENABLED === "1";
  const trailingActivateR = process.env.TRAILING_ACTIVATE_R
    ? Number(process.env.TRAILING_ACTIVATE_R)
    : 0.5;
  const trailingDistanceR = process.env.TRAILING_DISTANCE_R
    ? Number(process.env.TRAILING_DISTANCE_R)
    : 1.0;
  const breakevenTriggerR = process.env.BREAKEVEN_TRIGGER_R
    ? Number(process.env.BREAKEVEN_TRIGGER_R)
    : 1.0;
  const dxyLookbackHours = process.env.DXY_LOOKBACK_HOURS
    ? Number(process.env.DXY_LOOKBACK_HOURS)
    : 12;
  const dxyPipThreshold = process.env.DXY_PIP_THRESHOLD
    ? Number(process.env.DXY_PIP_THRESHOLD)
    : 15;
  const dxyBlockNeutral =
    process.env.DXY_BLOCK_NEUTRAL === "true" || process.env.DXY_BLOCK_NEUTRAL === "1";
  const dxyMode = (process.env.DXY_MODE ?? undefined) as
    | "block_against"
    | "block_neutral_only"
    | "block_against_and_neutral"
    | undefined;

  const overlayActive = trailingEnabled || breakevenEnabled || dxyEnabled;
  const overlayRules: AlgorithmRules = overlayActive
    ? {
        ...algoRow.rules,
        ...(trailingEnabled
          ? {
              trailing_stop: {
                enabled: true,
                activate_at_r: trailingActivateR,
                trail_distance_r: trailingDistanceR,
              },
            }
          : {}),
        ...(breakevenEnabled
          ? { breakeven_move: { enabled: true, trigger_at_r: breakevenTriggerR } }
          : {}),
        ...(dxyEnabled
          ? {
              dxy_filter: {
                enabled: true,
                lookback_hours: dxyLookbackHours,
                pip_threshold: dxyPipThreshold,
                block_neutral: dxyBlockNeutral,
                ...(dxyMode ? { mode: dxyMode } : {}),
              },
            }
          : {}),
      }
    : algoRow.rules;

  // Fetch EUR/USD proxy bars when DXY overlay is enabled. 1h granularity
  // matches the lookback windows we're testing (4-72h); fetched once
  // and shared across the simulation.
  let proxyBars: PriceBar[] | null = null;
  if (dxyEnabled) {
    console.log("Fetching EUR/USD 1h bars (DXY proxy)...");
    proxyBars = await fetchDailyPrices("EUR/USD", "full", "1h");
    console.log(
      `  ${proxyBars.length} bars  (${proxyBars[0]?.date} → ${proxyBars[proxyBars.length - 1]?.date})`
    );
    console.log("");
  }

  if (overlayActive) {
    console.log("Overlay (NOT persisted to DB):");
    if (trailingEnabled) {
      console.log(
        `  trailing_stop  : activate_at_r=${trailingActivateR}, trail_distance_r=${trailingDistanceR}`
      );
    }
    if (breakevenEnabled) {
      console.log(`  breakeven_move : trigger_at_r=${breakevenTriggerR}`);
    }
    if (dxyEnabled) {
      console.log(
        `  dxy_filter     : lookback_hours=${dxyLookbackHours}, pip_threshold=${dxyPipThreshold}, block_neutral=${dxyBlockNeutral}, mode=${dxyMode ?? "(default block_against)"}`
      );
    }
    console.log("");
  }

  const start = Date.now();
  // Run baseline (no overlay) for comparison when overlay is active.
  const baseline: BacktestMetrics | null = overlayActive
    ? runPortfolioBacktest(algoRow.rules, pricesByTicker, Number(algoRow.capital))
    : null;
  const result = runPortfolioBacktest(
    overlayRules,
    pricesByTicker,
    Number(algoRow.capital),
    { proxyBars }
  );
  const duration = ((Date.now() - start) / 1000).toFixed(1);

  const trades: ClassifiedTrade[] = result.trades.map((t) => ({
    ...t,
    hold_hours: holdHours(t),
    exit_reason_label: classifyExit(t, algoRow.rules),
  }));

  console.log(`Backtest complete in ${duration}s`);
  if (baseline) {
    console.log(
      `  baseline      : ${baseline.total_trades}t · WR ${baseline.win_rate.toFixed(1)}% · $${baseline.total_return.toFixed(0)} · DD ${baseline.max_drawdown.toFixed(2)}%`
    );
    console.log(
      `  with overlay  : ${result.total_trades}t · WR ${result.win_rate.toFixed(1)}% · $${result.total_return.toFixed(0)} · DD ${result.max_drawdown.toFixed(2)}%`
    );
    const dReturn = result.total_return - baseline.total_return;
    const dDd = result.max_drawdown - baseline.max_drawdown;
    const dWr = result.win_rate - baseline.win_rate;
    console.log(
      `  diff          : WR ${dWr >= 0 ? "+" : ""}${dWr.toFixed(1)}pp · ${dReturn >= 0 ? "+" : ""}$${dReturn.toFixed(0)} return · ${dDd >= 0 ? "+" : ""}${dDd.toFixed(2)}pp DD`
    );
  } else {
    console.log(
      `  total_trades : ${result.total_trades}  (win_rate ${result.win_rate.toFixed(1)}%, total_return $${result.total_return.toFixed(2)}, max_dd ${result.max_drawdown.toFixed(2)}%)`
    );
  }
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
    { name: "< 30m", max: 0.5 },
    { name: "30m-1h", max: 1 },
    { name: "1-2h", max: 2 },
    { name: "2-4h", max: 4 },
    { name: "4-12h", max: 12 },
    { name: "12-24h", max: 24 },
    { name: "1d+", max: Infinity },
  ];
  const counts: Record<string, number> = {};
  for (const t of trades) {
    let bucket = "1d+";
    for (const b of buckets) {
      if (t.hold_hours <= b.max) {
        bucket = b.name;
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
        `  ${b.name.padEnd(10)} ${String(n).padStart(3)}  (${pct(n, trades.length).padStart(5)}%)`
      );
    }
  }
  // Median hold
  const sortedHolds = trades.map((t) => t.hold_hours).sort((a, b) => a - b);
  const median =
    sortedHolds.length === 0
      ? 0
      : sortedHolds.length % 2 === 0
        ? (sortedHolds[sortedHolds.length / 2 - 1] + sortedHolds[sortedHolds.length / 2]) / 2
        : sortedHolds[Math.floor(sortedHolds.length / 2)];
  console.log(`  median hold : ${median < 1 ? `${(median * 60).toFixed(0)}min` : `${median.toFixed(1)}h`}`);
  console.log("");

  // Win/loss aggregates
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  console.log("Win/loss aggregates:");
  console.log(`  wins   : ${wins.length}  avg $${avgWin.toFixed(0)}`);
  console.log(`  losses : ${losses.length}  avg $${avgLoss.toFixed(0)}`);
  if (avgLoss !== 0) {
    console.log(`  win/loss ratio : ${(Math.abs(avgWin / avgLoss)).toFixed(2)}x`);
  }
  console.log("");

  // First / last trade dates for context
  if (trades.length > 0) {
    const firstDate = trades.reduce((min, t) => (t.entry_date < min ? t.entry_date : min), trades[0].entry_date);
    const lastDate = trades.reduce((max, t) => (t.exit_date > max ? t.exit_date : max), trades[0].exit_date);
    const days = (new Date(lastDate).getTime() - new Date(firstDate).getTime()) / 86400000;
    console.log(`Sample window: ${firstDate.slice(0, 10)} → ${lastDate.slice(0, 10)} (${days.toFixed(0)} days, ${(trades.length / days * 30).toFixed(1)} trades/month)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
