/**
 * Per-ticker decomposition of the V1.2 loser cluster — answers
 * "is the cluster signature driven by gold or by forex?"
 *
 * V1.2 mining pooled across XAU/USD + EUR/USD + GBP/USD + USD/JPY and
 * reported one cluster R per cell. The cluster gate is now deployed to
 * 6 GOLD-ONLY algos. If the cluster's loser signature comes mostly
 * from forex pairs that no algo trades, the gate is on the wrong side
 * of the signal.
 *
 * Method:
 *   Replicate V1.2-style corpus + tag every trade with V1.2 cluster
 *   membership (discount ∩ london(7-13) ∩ compressed). Then aggregate
 *   per (ticker, cluster_member) and per (ticker, sub-window).
 */
import { writeFileSync } from "fs";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import type { MarketStateSeries } from "../src/lib/market-data/portfolio-backtest";
import type { BacktestTrade } from "../src/lib/market-data/types";
import {
  computeMarketState4h,
  type MarketStateInputs,
} from "../src/lib/market-data/market-state";
import type { AlgorithmRules } from "../src/types/algorithm";
import { loadCorpus, type Corpus } from "./llm-trader-backtest";

const CAPITAL = 100_000;
const RISK_PCT = 0.6;
const RISK_DOLLARS = (CAPITAL * RISK_PCT) / 100;
const CHUNK_DAYS = 90;
const DAY_MS = 86_400_000;
const TICKERS = (process.env.TICKERS ?? "XAU/USD,EUR/USD,GBP/USD,USD/JPY")
  .split(",").map((s) => s.trim());
const FRICTION_SLIPPAGE_BPS = 0.5;
const FRICTION_SPREAD_BPS = 0.4;

function assetClassFor(ticker: string): "commodity" | "forex" {
  return ticker.startsWith("XAU") || ticker.startsWith("XAG") ? "commodity" : "forex";
}

function baseRules(timeframe: "4h" | "1h" | "30m", side: "long" | "short" = "long", assetClass: "commodity" | "forex" = "commodity"): AlgorithmRules {
  return {
    entry_conditions: [], exit_conditions: [],
    stop_loss: { type: "swing_anchor", value: 0.1, lookback: 4 },
    take_profit: { type: "rr_multiple", value: 3 },
    position_sizing: { type: "risk_per_trade", value: RISK_PCT },
    max_positions: 1, leverage: 9, timeframe, asset_class: assetClass, side,
    stagnant_exit: { enabled: true },
    prop_firm: { slippage_bps: FRICTION_SLIPPAGE_BPS, spread_bps: FRICTION_SPREAD_BPS },
  } as unknown as AlgorithmRules;
}

interface AlgoSpec { key: string; timeframe: "4h" | "1h" | "30m"; rules: AlgorithmRules; gate: boolean; }
function buildSpecs(ac: "commodity" | "forex"): AlgoSpec[] {
  const db = baseRules("4h", "long", ac);
  db.entry_conditions = [
    { type: "pattern", pattern: "liquidity_sweep", direction: "bullish", lookback: 5, timeframe: "4h" },
    { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "4h" },
  ];
  db.market_state_gate = { mode: "block", states: { mtf: ["fast_div_bull"], dxy: ["usd_down"] }, on_unreadable: "allow" };
  const cb4 = baseRules("4h", "long", ac);
  cb4.entry_conditions = [
    { type: "pattern", pattern: "bos", direction: "bullish", lookback: 5, timeframe: "4h" },
    { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "4h" },
  ];
  cb4.market_state_gate = { mode: "allow", states: { range: ["compressed"] } };
  const cb1 = baseRules("1h", "long", ac);
  cb1.entry_conditions = [{ type: "pattern", pattern: "bos", direction: "bullish", lookback: 5, timeframe: "1h" }];
  const bs = baseRules("4h", "short", ac);
  bs.entry_conditions = [
    { type: "pattern", pattern: "bos", direction: "bearish", lookback: 5, timeframe: "4h" },
    { type: "pattern", pattern: "daily_bias", direction: "bearish", ma_period: 20, timeframe: "4h" },
  ];
  bs.market_state_gate = { mode: "allow", states: { mtf: ["aligned_LH"] } };
  const br = baseRules("4h", "short", ac);
  br.entry_conditions = [{ type: "pattern", pattern: "bos", direction: "bearish", lookback: 5, timeframe: "4h" }];
  br.market_state_gate = { mode: "allow", states: { mtf: ["fast_div_bear"] } };
  const fv = baseRules("30m", "long", ac);
  fv.entry_conditions = [{ type: "pattern", pattern: "fvg", direction: "bullish", timeframe: "30m" }];
  const mrL = baseRules("4h", "long", ac);
  mrL.entry_conditions = [{ type: "pattern", pattern: "mean_reversion", direction: "bullish", lookback: 20, timeframe: "4h" }];
  const mrS = baseRules("4h", "short", ac);
  mrS.entry_conditions = [{ type: "pattern", pattern: "mean_reversion", direction: "bearish", lookback: 20, timeframe: "4h" }];
  return [
    { key: "dip_buyer_4h", timeframe: "4h", rules: db, gate: true },
    { key: "coil_breakout_4h", timeframe: "4h", rules: cb4, gate: true },
    { key: "coil_breakout_1h", timeframe: "1h", rules: cb1, gate: false },
    { key: "bear_short_4h", timeframe: "4h", rules: bs, gate: true },
    { key: "breakdown_rider_4h", timeframe: "4h", rules: br, gate: true },
    { key: "fvg_long_30m", timeframe: "30m", rules: fv, gate: false },
    { key: "mean_reversion_long_4h", timeframe: "4h", rules: mrL, gate: false },
    { key: "mean_reversion_short_4h", timeframe: "4h", rules: mrS, gate: false },
  ];
}

function findBarIdx(bars: { date: string }[], targetDate: string): number {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= targetDate) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
function positionInRange(corpusBars: { date: string; high: number; low: number }[], entryDate: string, entryPrice: number): number | null {
  const idx = findBarIdx(corpusBars, entryDate);
  if (idx < 20) return null;
  let hiV = -Infinity, loV = Infinity;
  for (let i = idx - 19; i <= idx; i++) {
    hiV = Math.max(hiV, corpusBars[i].high); loV = Math.min(loV, corpusBars[i].low);
  }
  if (hiV <= loV) return null;
  return Math.max(0, Math.min(100, ((entryPrice - loV) / (hiV - loV)) * 100));
}

interface T {
  ticker: string; algo: string; side: "long" | "short"; r: number;
  entry_date: string; hour: number; dow: number;
  entry_zone: "discount" | "equilibrium" | "premium" | "n/a"; range: string;
  in_cluster: boolean;
}

async function processOneTicker(ticker: string): Promise<T[]> {
  const ac = assetClassFor(ticker);
  console.log(`\n--- ${ticker} (${ac}) ---`);
  const c4 = await loadCorpus("4h", ticker);
  const c1 = await loadCorpus("1h", ticker);
  const c30 = await loadCorpus("30m", ticker);
  const series: MarketStateSeries = {
    bars4h: new Map([[ticker, c4.bars]]),
    oneHour: new Map([[ticker, c1.bars]]),
    daily: new Map([[ticker, c4.dailyBars]]),
    eurusd4h: c4.eurusd4h,
  };
  const inputs: MarketStateInputs = {
    bars4h: c4.bars, oneHourBars: c1.bars, dailyBars: c4.dailyBars, eurusd4h: c4.eurusd4h,
  };
  const localChunked = (rules: AlgorithmRules, corpus: Corpus, srs: MarketStateSeries | null): BacktestTrade[] => {
    const bars = corpus.bars;
    if (bars.length === 0) return [];
    const trades: BacktestTrade[] = [];
    const start = new Date(bars[0].date).getTime();
    const end = new Date(bars[bars.length - 1].date).getTime();
    for (let cur = start; cur < end; cur += CHUNK_DAYS * DAY_MS) {
      const ce = cur + CHUNK_DAYS * DAY_MS;
      const chunk = bars.filter((b) => {
        const t = new Date(b.date).getTime();
        return t >= cur && t < ce;
      });
      if (chunk.length < 30) continue;
      const m = runPortfolioBacktest(rules, new Map([[ticker, chunk]]), CAPITAL, [], null, srs);
      trades.push(...m.trades);
    }
    trades.sort((a, b) => new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime());
    return trades;
  };
  const specs = buildSpecs(ac);
  const out: T[] = [];
  for (const s of specs) {
    const corpus = s.timeframe === "4h" ? c4 : s.timeframe === "1h" ? c1 : c30;
    const trades = localChunked(s.rules, corpus, s.gate ? series : null);
    for (const t of trades) {
      const tfBars = corpus.bars as { date: string; high: number; low: number; close: number; open: number; volume: number }[];
      const pir = positionInRange(tfBars, t.entry_date, t.entry_price);
      const d = new Date(t.entry_date);
      const ms4 = findBarIdx(inputs.bars4h, t.entry_date);
      const range = ms4 >= 0 ? computeMarketState4h(inputs, ms4).range : "n/a";
      const entry_zone = pir === null ? "n/a" : pir < 33 ? "discount" : pir < 67 ? "equilibrium" : "premium";
      const hour = d.getUTCHours();
      out.push({
        ticker, algo: s.key, side: t.side, r: t.pnl / RISK_DOLLARS,
        entry_date: t.entry_date, hour, dow: d.getUTCDay(),
        entry_zone, range,
        in_cluster: entry_zone === "discount" && hour >= 7 && hour < 13 && range === "compressed",
      });
    }
  }
  return out;
}

function agg(rs: number[]): { n: number; mean_r: number; total_r: number; win_pct: number } {
  if (rs.length === 0) return { n: 0, mean_r: 0, total_r: 0, win_pct: 0 };
  const sum = rs.reduce((s, x) => s + x, 0);
  const wins = rs.filter((x) => x > 0).length;
  return { n: rs.length, mean_r: sum / rs.length, total_r: sum, win_pct: (wins * 100) / rs.length };
}

async function main() {
  console.log("Per-ticker decomposition of V1.2 loser cluster");
  console.log(`Tickers: ${TICKERS.join(", ")}`);

  const all: T[] = [];
  for (const t of TICKERS) all.push(...(await processOneTicker(t)));
  console.log(`\nTotal trades: ${all.length}`);

  console.log("\n=== V1.2 cluster per ticker ===");
  console.log("Ticker     n    mean_R    total_R    win%");
  for (const t of TICKERS) {
    const ts = all.filter((x) => x.ticker === t && x.in_cluster);
    const a = agg(ts.map((x) => x.r));
    console.log(`${t.padEnd(10)} ${String(a.n).padStart(3)}   ${a.mean_r.toFixed(3).padStart(7)}   ${a.total_r.toFixed(2).padStart(7)}   ${a.win_pct.toFixed(1).padStart(5)}`);
  }

  console.log("\n=== Non-cluster per ticker (for baseline comparison) ===");
  console.log("Ticker      n     mean_R    win%");
  for (const t of TICKERS) {
    const ts = all.filter((x) => x.ticker === t && !x.in_cluster);
    const a = agg(ts.map((x) => x.r));
    console.log(`${t.padEnd(10)} ${String(a.n).padStart(4)}   ${a.mean_r.toFixed(3).padStart(7)}   ${a.win_pct.toFixed(1).padStart(5)}`);
  }

  console.log("\n=== London-early (hour 7-9) sub-cluster per ticker ===");
  console.log("Ticker     n    mean_R    win%");
  for (const t of TICKERS) {
    const ts = all.filter((x) => x.ticker === t && x.in_cluster && x.hour >= 7 && x.hour < 9);
    const a = agg(ts.map((x) => x.r));
    console.log(`${t.padEnd(10)} ${String(a.n).padStart(3)}   ${a.mean_r.toFixed(3).padStart(7)}   ${a.win_pct.toFixed(1).padStart(5)}`);
  }

  console.log("\n=== Wed+Fri sub-cluster per ticker ===");
  console.log("Ticker     n    mean_R    win%");
  for (const t of TICKERS) {
    const ts = all.filter((x) => x.ticker === t && x.in_cluster && (x.dow === 3 || x.dow === 5));
    const a = agg(ts.map((x) => x.r));
    console.log(`${t.padEnd(10)} ${String(a.n).padStart(3)}   ${a.mean_r.toFixed(3).padStart(7)}   ${a.win_pct.toFixed(1).padStart(5)}`);
  }

  // Per-asset-class rollup
  const gold = all.filter((x) => x.ticker.startsWith("XAU"));
  const forex = all.filter((x) => !x.ticker.startsWith("XAU"));
  console.log("\n=== Asset-class rollup ===");
  for (const [label, ts] of [["Gold (XAU/USD)", gold], ["Forex (EUR/GBP/JPY)", forex]] as const) {
    const inC = ts.filter((x) => x.in_cluster);
    const notC = ts.filter((x) => !x.in_cluster);
    console.log(`\n  ${label}:`);
    const aIn = agg(inC.map((x) => x.r));
    const aOut = agg(notC.map((x) => x.r));
    console.log(`    cluster:     n=${String(aIn.n).padStart(4)} mean_R=${aIn.mean_r.toFixed(3).padStart(7)} win%=${aIn.win_pct.toFixed(1).padStart(5)}`);
    console.log(`    non-cluster: n=${String(aOut.n).padStart(4)} mean_R=${aOut.mean_r.toFixed(3).padStart(7)} win%=${aOut.win_pct.toFixed(1).padStart(5)}`);
    console.log(`    delta per cluster-refusal saves: ${(aOut.mean_r - aIn.mean_r).toFixed(3)}R`);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/discovery-per-ticker-cluster-${ts}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        tickers: TICKERS,
        total_trades: all.length,
        per_ticker: TICKERS.map((t) => ({
          ticker: t,
          cluster: agg(all.filter((x) => x.ticker === t && x.in_cluster).map((x) => x.r)),
          non_cluster: agg(all.filter((x) => x.ticker === t && !x.in_cluster).map((x) => x.r)),
          london_early_in_cluster: agg(all.filter((x) => x.ticker === t && x.in_cluster && x.hour >= 7 && x.hour < 9).map((x) => x.r)),
          wed_fri_in_cluster: agg(all.filter((x) => x.ticker === t && x.in_cluster && (x.dow === 3 || x.dow === 5)).map((x) => x.r)),
        })),
        asset_class: {
          gold: {
            cluster: agg(gold.filter((x) => x.in_cluster).map((x) => x.r)),
            non_cluster: agg(gold.filter((x) => !x.in_cluster).map((x) => x.r)),
          },
          forex: {
            cluster: agg(forex.filter((x) => x.in_cluster).map((x) => x.r)),
            non_cluster: agg(forex.filter((x) => !x.in_cluster).map((x) => x.r)),
          },
        },
      },
      null,
      2
    )
  );
  console.log(`\nWrote ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
