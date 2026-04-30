/**
 * Sweeps DXY filter (lookback_hours × pip_threshold) on a given algo's
 * long corpus and prints the grid as a table. Reuses inspect-algo's
 * fetch + backtest plumbing — added to compare modes after empirical
 * analysis showed Algo D's longs benefit from block_neutral_only.
 *
 * Usage:
 *   ALGO_ID=<uuid> [DXY_MODE=block_neutral_only] pnpm dlx tsx scripts/sweep-dxy-params.ts
 *
 * Env:
 *   ALGO_ID  required
 *   DXY_MODE optional — defaults to block_neutral_only
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import { fetchDailyPrices } from "../src/lib/market-data/prices";
import { timeframeToInterval, type BarInterval } from "../src/lib/market-data/interval";
import type { PriceBar } from "../src/lib/market-data/types";
import type { AlgorithmRules } from "../src/types/algorithm";

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

interface AlgoRow {
  id: string;
  name: string;
  capital: number;
  rules: AlgorithmRules;
}

async function main(): Promise<void> {
  const algoId = process.env.ALGO_ID;
  if (!algoId) throw new Error("ALGO_ID env var required");
  const mode = (process.env.DXY_MODE ?? "block_neutral_only") as
    | "block_against"
    | "block_neutral_only"
    | "block_against_and_neutral";

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
  if (algoErr || !algo) throw new Error(`Could not fetch algo: ${algoErr?.message}`);
  const algoRow = algo as AlgoRow;

  const { data: watchlist, error: wlErr } = await supabase
    .from("algorithm_watchlist")
    .select("ticker")
    .eq("algorithm_id", algoId);
  if (wlErr || !watchlist) throw new Error(`Could not fetch watchlist: ${wlErr?.message}`);
  const tickers = (watchlist as { ticker: string }[]).map((w) => w.ticker);

  console.log(`Algo: ${algoRow.name} · ${tickers.join(", ")} · mode=${mode}`);
  console.log("");

  const interval: BarInterval = timeframeToInterval(algoRow.rules.timeframe);
  const pricesByTicker = new Map<string, PriceBar[]>();
  for (const ticker of tickers) {
    const bars = await fetchDailyPrices(ticker, "full", interval);
    pricesByTicker.set(ticker, bars);
  }
  const proxyBars = await fetchDailyPrices("EUR/USD", "full", "1h");

  const capital = Number(algoRow.capital);
  const baseline = runPortfolioBacktest(algoRow.rules, pricesByTicker, capital, [], null);
  console.log(
    `Baseline (no overlay): ${baseline.total_trades}t · WR ${baseline.win_rate.toFixed(1)}% · $${baseline.total_return.toFixed(0)} · DD ${baseline.max_drawdown.toFixed(2)}%`
  );
  console.log("");

  const lookbacks = [4, 8, 12, 24, 48, 72];
  const thresholds = [5, 10, 15, 20, 30, 50];

  console.log(
    "lookback | thresh | trades | WR    | return  | DD     | dWR    | dReturn  | dDD"
  );
  console.log(
    "---------|--------|--------|-------|---------|--------|--------|----------|--------"
  );

  interface Row {
    lb: number;
    th: number;
    trades: number;
    wr: number;
    ret: number;
    dd: number;
  }
  const rows: Row[] = [];

  for (const lb of lookbacks) {
    for (const th of thresholds) {
      const overlay: AlgorithmRules = {
        ...algoRow.rules,
        dxy_filter: { enabled: true, lookback_hours: lb, pip_threshold: th, mode },
      };
      const r = runPortfolioBacktest(overlay, pricesByTicker, capital, [], proxyBars);
      rows.push({
        lb,
        th,
        trades: r.total_trades,
        wr: r.win_rate,
        ret: r.total_return,
        dd: r.max_drawdown,
      });
      const dWr = r.win_rate - baseline.win_rate;
      const dRet = r.total_return - baseline.total_return;
      const dDd = r.max_drawdown - baseline.max_drawdown;
      console.log(
        `${String(lb).padStart(7)}h | ${String(th).padStart(5)}p | ${String(r.total_trades).padStart(6)} | ${r.win_rate.toFixed(1).padStart(4)}% | $${r.total_return.toFixed(0).padStart(6)} | ${r.max_drawdown.toFixed(2).padStart(5)}% | ${(dWr >= 0 ? "+" : "") + dWr.toFixed(1)}pp | ${(dRet >= 0 ? "+" : "") + "$" + dRet.toFixed(0).padStart(5)} | ${(dDd >= 0 ? "+" : "") + dDd.toFixed(2)}pp`
      );
    }
  }

  console.log("");
  // Top 3 by DD reduction (with non-negative return diff filter — we want DD wins, not return wins)
  const ranked = rows
    .filter((r) => r.ret - baseline.total_return > -2000) // tolerate small return drag
    .sort((a, b) => a.dd - b.dd)
    .slice(0, 5);
  console.log("Top 5 by lowest DD (return drag ≤ $2K):");
  for (const r of ranked) {
    const dDd = r.dd - baseline.max_drawdown;
    const dRet = r.ret - baseline.total_return;
    console.log(
      `  ${r.lb}h × ${r.th}pip  →  DD ${r.dd.toFixed(2)}% (${(dDd >= 0 ? "+" : "") + dDd.toFixed(2)}pp)  ·  return $${r.ret.toFixed(0)} (${dRet >= 0 ? "+" : ""}$${dRet.toFixed(0)})  ·  ${r.trades}t · WR ${r.wr.toFixed(1)}%`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
