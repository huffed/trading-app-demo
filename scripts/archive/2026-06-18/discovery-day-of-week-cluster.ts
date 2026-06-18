/**
 * Day-of-week + month-end + NFP-Friday cohort screen — sub of #228.
 *
 * V1.2 cluster + non-cluster sliced by:
 *   - day_of_week (Mon-Fri, UTC)
 *   - is_month_end (entry within the final 3 trading days of the calendar month)
 *   - is_nfp_friday (first Friday of the month — forex NFP catalyst)
 *
 * Cheap to compute (date math only). Two questions:
 *   1. Are any DoWs disproportionately represented in the loser cluster?
 *   2. Do calendar effects shift the cluster's signature?
 *
 * Output: console table + scripts/discovery-day-of-week-cluster-<ts>.json.
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
  .split(",")
  .map((s) => s.trim());
const FRICTION_SLIPPAGE_BPS = 0.5;
const FRICTION_SPREAD_BPS = 0.4;

function assetClassFor(ticker: string): "commodity" | "forex" {
  return ticker.startsWith("XAU") || ticker.startsWith("XAG") ? "commodity" : "forex";
}

function baseRules(
  timeframe: "4h" | "1h" | "30m",
  side: "long" | "short" = "long",
  assetClass: "commodity" | "forex" = "commodity"
): AlgorithmRules {
  return {
    entry_conditions: [],
    exit_conditions: [],
    stop_loss: { type: "swing_anchor", value: 0.1, lookback: 4 },
    take_profit: { type: "rr_multiple", value: 3 },
    position_sizing: { type: "risk_per_trade", value: RISK_PCT },
    max_positions: 1,
    leverage: 9,
    timeframe,
    asset_class: assetClass,
    side,
    stagnant_exit: { enabled: true },
    prop_firm: { slippage_bps: FRICTION_SLIPPAGE_BPS, spread_bps: FRICTION_SPREAD_BPS },
  } as unknown as AlgorithmRules;
}

interface AlgoSpec {
  key: string;
  timeframe: "4h" | "1h" | "30m";
  rules: AlgorithmRules;
  gate: boolean;
}

function buildSpecs(assetClass: "commodity" | "forex"): AlgoSpec[] {
  const db = baseRules("4h", "long", assetClass);
  db.entry_conditions = [
    { type: "pattern", pattern: "liquidity_sweep", direction: "bullish", lookback: 5, timeframe: "4h" },
    { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "4h" },
  ];
  db.market_state_gate = {
    mode: "block",
    states: { mtf: ["fast_div_bull"], dxy: ["usd_down"] },
    on_unreadable: "allow",
  };
  const cb4 = baseRules("4h", "long", assetClass);
  cb4.entry_conditions = [
    { type: "pattern", pattern: "bos", direction: "bullish", lookback: 5, timeframe: "4h" },
    { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "4h" },
  ];
  cb4.market_state_gate = { mode: "allow", states: { range: ["compressed"] } };
  const cb1 = baseRules("1h", "long", assetClass);
  cb1.entry_conditions = [
    { type: "pattern", pattern: "bos", direction: "bullish", lookback: 5, timeframe: "1h" },
  ];
  const bs = baseRules("4h", "short", assetClass);
  bs.entry_conditions = [
    { type: "pattern", pattern: "bos", direction: "bearish", lookback: 5, timeframe: "4h" },
    { type: "pattern", pattern: "daily_bias", direction: "bearish", ma_period: 20, timeframe: "4h" },
  ];
  bs.market_state_gate = { mode: "allow", states: { mtf: ["aligned_LH"] } };
  const br = baseRules("4h", "short", assetClass);
  br.entry_conditions = [
    { type: "pattern", pattern: "bos", direction: "bearish", lookback: 5, timeframe: "4h" },
  ];
  br.market_state_gate = { mode: "allow", states: { mtf: ["fast_div_bear"] } };
  const fv = baseRules("30m", "long", assetClass);
  fv.entry_conditions = [
    { type: "pattern", pattern: "fvg", direction: "bullish", timeframe: "30m" },
  ];
  const mrL = baseRules("4h", "long", assetClass);
  mrL.entry_conditions = [
    { type: "pattern", pattern: "mean_reversion", direction: "bullish", lookback: 20, timeframe: "4h" },
  ];
  const mrS = baseRules("4h", "short", assetClass);
  mrS.entry_conditions = [
    { type: "pattern", pattern: "mean_reversion", direction: "bearish", lookback: 20, timeframe: "4h" },
  ];
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

function positionInRange(
  corpusBars: { date: string; high: number; low: number }[],
  entryDate: string,
  entryPrice: number
): number | null {
  const idx = findBarIdx(corpusBars, entryDate);
  if (idx < 20) return null;
  let hiV = -Infinity, loV = Infinity;
  for (let i = idx - 19; i <= idx; i++) {
    hiV = Math.max(hiV, corpusBars[i].high);
    loV = Math.min(loV, corpusBars[i].low);
  }
  if (hiV <= loV) return null;
  const pct = ((entryPrice - loV) / (hiV - loV)) * 100;
  return Math.max(0, Math.min(100, pct));
}

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** UTC day-of-month for the LAST trading day in the entry's UTC month
 *  (approximation: count Mon-Fri days; close enough for month-end signal). */
function isMonthEnd(date: Date): boolean {
  // Find last weekday of the month. Counting from end.
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  // Last day of month
  const lastDay = new Date(Date.UTC(y, m + 1, 0));
  let cursor = new Date(lastDay);
  // Walk back to last weekday (Mon=1..Fri=5).
  while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6) {
    cursor = new Date(cursor.getTime() - DAY_MS);
  }
  const daysToLast = Math.round((cursor.getTime() - date.getTime()) / DAY_MS);
  return daysToLast >= 0 && daysToLast < 3; // last 3 trading days
}

/** First Friday of the month — NFP catalyst day for forex/gold. */
function isFirstFridayOfMonth(date: Date): boolean {
  if (date.getUTCDay() !== 5) return false;
  const day = date.getUTCDate();
  return day >= 1 && day <= 7;
}

interface TaggedTrade {
  ticker: string;
  algo: string;
  side: "long" | "short";
  pnl: number;
  r: number;
  entry_date: string;
  entry_hour_utc: number;
  dow: number; // 0=Sun..6=Sat
  is_month_end: boolean;
  is_first_friday: boolean;
  entry_zone: "discount" | "equilibrium" | "premium" | "n/a";
  range: string;
  in_v12_cluster: boolean;
}

async function processOneTicker(ticker: string): Promise<TaggedTrade[]> {
  const assetClass = assetClassFor(ticker);
  console.log(`\n--- Loading corpora for ${ticker} (${assetClass}) ---`);
  const corpus4h = await loadCorpus("4h", ticker);
  const corpus1h = await loadCorpus("1h", ticker);
  const corpus30m = await loadCorpus("30m", ticker);
  const series: MarketStateSeries = {
    bars4h: new Map([[ticker, corpus4h.bars]]),
    oneHour: new Map([[ticker, corpus1h.bars]]),
    daily: new Map([[ticker, corpus4h.dailyBars]]),
    eurusd4h: corpus4h.eurusd4h,
  };
  const inputs: MarketStateInputs = {
    bars4h: corpus4h.bars,
    oneHourBars: corpus1h.bars,
    dailyBars: corpus4h.dailyBars,
    eurusd4h: corpus4h.eurusd4h,
  };

  const localChunked = (rules: AlgorithmRules, corpus: Corpus, srs: MarketStateSeries | null): BacktestTrade[] => {
    const bars = corpus.bars;
    if (bars.length === 0) return [];
    const trades: BacktestTrade[] = [];
    const startMs = new Date(bars[0].date).getTime();
    const endMs = new Date(bars[bars.length - 1].date).getTime();
    for (let cursor = startMs; cursor < endMs; cursor += CHUNK_DAYS * DAY_MS) {
      const chunkEnd = cursor + CHUNK_DAYS * DAY_MS;
      const chunk = bars.filter((b) => {
        const t = new Date(b.date).getTime();
        return t >= cursor && t < chunkEnd;
      });
      if (chunk.length < 30) continue;
      const m = runPortfolioBacktest(rules, new Map([[ticker, chunk]]), CAPITAL, [], null, srs);
      trades.push(...m.trades);
    }
    trades.sort((a, b) => new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime());
    return trades;
  };

  const specs = buildSpecs(assetClass);
  const tickerTrades: TaggedTrade[] = [];

  for (const s of specs) {
    const corpus = s.timeframe === "4h" ? corpus4h : s.timeframe === "1h" ? corpus1h : corpus30m;
    const trades = localChunked(s.rules, corpus, s.gate ? series : null);

    for (const t of trades) {
      const tfBars = corpus.bars as { date: string; high: number; low: number; close: number; open: number; volume: number }[];
      const posInRange = positionInRange(tfBars, t.entry_date, t.entry_price);
      const d = new Date(t.entry_date);
      const ms4hIdx = findBarIdx(inputs.bars4h, t.entry_date);
      const range = ms4hIdx >= 0 ? computeMarketState4h(inputs, ms4hIdx).range : "n/a";

      const entry_zone =
        posInRange === null ? "n/a"
        : posInRange < 33 ? "discount"
        : posInRange < 67 ? "equilibrium"
        : "premium";
      const entry_hour_utc = d.getUTCHours();

      tickerTrades.push({
        ticker,
        algo: s.key,
        side: t.side,
        pnl: t.pnl,
        r: t.pnl / RISK_DOLLARS,
        entry_date: t.entry_date,
        entry_hour_utc,
        dow: d.getUTCDay(),
        is_month_end: isMonthEnd(d),
        is_first_friday: isFirstFridayOfMonth(d),
        entry_zone,
        range,
        in_v12_cluster:
          entry_zone === "discount" &&
          entry_hour_utc >= 7 && entry_hour_utc < 13 &&
          range === "compressed",
      });
    }
    console.log(`  ${s.key.padEnd(28)} → ${trades.length} trades`);
  }

  return tickerTrades;
}

function aggregate(rs: number[]): { n: number; mean_r: number; total_r: number; win_pct: number } {
  if (rs.length === 0) return { n: 0, mean_r: 0, total_r: 0, win_pct: 0 };
  const sum = rs.reduce((s, x) => s + x, 0);
  const wins = rs.filter((x) => x > 0).length;
  return { n: rs.length, mean_r: sum / rs.length, total_r: sum, win_pct: (wins * 100) / rs.length };
}

function printDowTable(label: string, trades: TaggedTrade[]): void {
  console.log(`\n=== ${label} (n=${trades.length}) ===`);
  console.log("DoW  n     mean_R   total_R   win%");
  for (let d = 0; d < 7; d++) {
    const dayTrades = trades.filter((t) => t.dow === d);
    if (dayTrades.length === 0) continue;
    const agg = aggregate(dayTrades.map((t) => t.r));
    console.log(
      `${DOW_NAMES[d].padEnd(4)} ${String(agg.n).padStart(4)}  ${agg.mean_r.toFixed(3).padStart(7)}  ${agg.total_r.toFixed(2).padStart(7)}  ${agg.win_pct.toFixed(1).padStart(5)}`
    );
  }
}

async function main() {
  console.log("Discovery — day-of-week + calendar effects on V1.2 cluster + non-cluster");
  console.log(`Tickers: ${TICKERS.join(", ")}`);

  const allTrades: TaggedTrade[] = [];
  for (const ticker of TICKERS) {
    const tickerTrades = await processOneTicker(ticker);
    allTrades.push(...tickerTrades);
  }
  console.log(`\nTotal pooled trades: ${allTrades.length}`);

  const clusterTrades = allTrades.filter((t) => t.in_v12_cluster);
  const nonCluster = allTrades.filter((t) => !t.in_v12_cluster);

  // ===== Day-of-week =====
  printDowTable("V1.2 cluster — by DoW", clusterTrades);
  printDowTable("Non-cluster — by DoW", nonCluster);
  printDowTable("All pooled — by DoW", allTrades);

  // ===== Month-end =====
  console.log("\n=== Month-end (last 3 trading days of calendar month) ===");
  for (const [label, ts] of [
    ["V1.2 cluster", clusterTrades],
    ["Non-cluster", nonCluster],
    ["All pooled", allTrades],
  ] as const) {
    const me = ts.filter((t) => t.is_month_end);
    const notMe = ts.filter((t) => !t.is_month_end);
    if (ts.length === 0) continue;
    const aggMe = aggregate(me.map((t) => t.r));
    const aggNotMe = aggregate(notMe.map((t) => t.r));
    console.log(
      `  ${label.padEnd(15)}  month-end: n=${String(aggMe.n).padStart(4)} mean_R=${aggMe.mean_r.toFixed(3).padStart(7)}  |  rest: n=${String(aggNotMe.n).padStart(4)} mean_R=${aggNotMe.mean_r.toFixed(3).padStart(7)}`
    );
  }

  // ===== NFP first-Friday =====
  console.log("\n=== First Friday of month (NFP catalyst day) ===");
  for (const [label, ts] of [
    ["V1.2 cluster", clusterTrades],
    ["Non-cluster", nonCluster],
    ["All pooled", allTrades],
  ] as const) {
    const ff = ts.filter((t) => t.is_first_friday);
    const notFf = ts.filter((t) => !t.is_first_friday);
    if (ts.length === 0) continue;
    const aggFf = aggregate(ff.map((t) => t.r));
    const aggNotFf = aggregate(notFf.map((t) => t.r));
    console.log(
      `  ${label.padEnd(15)}  NFP Fri: n=${String(aggFf.n).padStart(4)} mean_R=${aggFf.mean_r.toFixed(3).padStart(7)}  |  rest: n=${String(aggNotFf.n).padStart(4)} mean_R=${aggNotFf.mean_r.toFixed(3).padStart(7)}`
    );
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/discovery-day-of-week-cluster-${ts}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        tickers: TICKERS,
        total_trades: allTrades.length,
        v12_cluster_n: clusterTrades.length,
        dow: {
          cluster: Array.from({ length: 7 }, (_, d) => ({
            dow: DOW_NAMES[d],
            ...aggregate(clusterTrades.filter((t) => t.dow === d).map((t) => t.r)),
          })),
          non_cluster: Array.from({ length: 7 }, (_, d) => ({
            dow: DOW_NAMES[d],
            ...aggregate(nonCluster.filter((t) => t.dow === d).map((t) => t.r)),
          })),
        },
        month_end: {
          cluster: aggregate(clusterTrades.filter((t) => t.is_month_end).map((t) => t.r)),
          non_cluster: aggregate(nonCluster.filter((t) => t.is_month_end).map((t) => t.r)),
        },
        first_friday: {
          cluster: aggregate(clusterTrades.filter((t) => t.is_first_friday).map((t) => t.r)),
          non_cluster: aggregate(nonCluster.filter((t) => t.is_first_friday).map((t) => t.r)),
        },
      },
      null,
      2
    )
  );
  console.log(`\nWrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
