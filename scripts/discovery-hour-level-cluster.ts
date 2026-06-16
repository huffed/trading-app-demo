/**
 * Hour-level bucketing of the V1.2 loser cluster — sub-item of #228.
 *
 * V1.2 surfaced `discount ∩ london(7-13) ∩ compressed` as a -0.76R
 * Bonferroni-significant loser cluster. London(7-13) is a 6-hour
 * bucket; this screen tests whether any individual hour within (or
 * adjacent to) that window shows a sharper signature — which would
 * tighten the deployed gate from a 6-hour window to e.g. 7-9 or 10-12.
 *
 * Method:
 *   For every trade in the V1.2-style corpus:
 *     - Compute entry_zone (V1.2's 20-bar PIR).
 *     - Compute entry_hour_utc (0-23).
 *     - Compute range state (4h market_state).
 *   Filter: entry_zone=discount AND range=compressed.
 *   Within that filter, group by entry_hour_utc → per-hour aggregate
 *   (n, mean_R, win%). Highlight hours that pass V1.2-style gates.
 *
 * Output: console table + scripts/discovery-hour-level-cluster-<ts>.json.
 *
 * Usage:
 *   pnpm dlx tsx scripts/discovery-hour-level-cluster.ts
 *   TICKERS=XAU/USD pnpm dlx tsx scripts/discovery-hour-level-cluster.ts
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

// ----- Constants mirror V1.2. -----
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

type EntryZone = "discount" | "equilibrium" | "premium" | "n/a";
function entryZoneOf(posPct: number | null): EntryZone {
  if (posPct === null) return "n/a";
  if (posPct < 33) return "discount";
  if (posPct < 67) return "equilibrium";
  return "premium";
}

interface TaggedTrade {
  ticker: string;
  algo: string;
  side: "long" | "short";
  pnl: number;
  r: number;
  entry_date: string;
  entry_zone: EntryZone;
  entry_hour_utc: number;
  range: string;
  in_base_filter: boolean; // discount AND compressed
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
      const entryHour = new Date(t.entry_date).getUTCHours();
      const ms4hIdx = findBarIdx(inputs.bars4h, t.entry_date);
      const range = ms4hIdx >= 0 ? computeMarketState4h(inputs, ms4hIdx).range : "n/a";

      const entry_zone = entryZoneOf(posInRange);
      const in_base_filter = entry_zone === "discount" && range === "compressed";

      tickerTrades.push({
        ticker,
        algo: s.key,
        side: t.side,
        pnl: t.pnl,
        r: t.pnl / RISK_DOLLARS,
        entry_date: t.entry_date,
        entry_zone,
        entry_hour_utc: entryHour,
        range,
        in_base_filter,
      });
    }
    console.log(`  ${s.key.padEnd(28)} → ${trades.length} trades`);
  }

  return tickerTrades;
}

interface HourAgg {
  hour: number;
  n: number;
  mean_r: number;
  win_pct: number;
  total_r: number;
}

function aggregatePerHour(trades: TaggedTrade[]): HourAgg[] {
  const buckets: Record<number, number[]> = {};
  for (let h = 0; h < 24; h++) buckets[h] = [];
  for (const t of trades) buckets[t.entry_hour_utc].push(t.r);

  const out: HourAgg[] = [];
  for (let h = 0; h < 24; h++) {
    const rs = buckets[h];
    if (rs.length === 0) {
      out.push({ hour: h, n: 0, mean_r: 0, win_pct: 0, total_r: 0 });
      continue;
    }
    const sum = rs.reduce((s, x) => s + x, 0);
    const wins = rs.filter((x) => x > 0).length;
    out.push({
      hour: h,
      n: rs.length,
      mean_r: sum / rs.length,
      win_pct: (wins * 100) / rs.length,
      total_r: sum,
    });
  }
  return out;
}

function printHourTable(label: string, agg: HourAgg[]): void {
  console.log(`\n=== ${label} ===`);
  console.log("Hour  n   mean_R   total_R   win%   bar");
  for (const row of agg) {
    if (row.n === 0) continue;
    const bar = row.mean_r < 0 ? "█".repeat(Math.min(20, Math.round(Math.abs(row.mean_r) * 10))) : "·";
    const sign = row.mean_r >= 0 ? " " : "";
    console.log(
      `${String(row.hour).padStart(2)}    ${String(row.n).padStart(3)}  ${sign}${row.mean_r.toFixed(3).padStart(7)}  ${sign}${row.total_r.toFixed(2).padStart(7)}  ${row.win_pct.toFixed(1).padStart(5)}  ${bar}`
    );
  }
}

async function main() {
  console.log("Discovery — hour-level bucketing of V1.2 base filter");
  console.log(`Tickers: ${TICKERS.join(", ")}`);
  console.log("Base filter: entry_zone=discount AND range=compressed");
  console.log("Question: which individual UTC hour(s) drive the loser signature?");

  const allTrades: TaggedTrade[] = [];
  for (const ticker of TICKERS) {
    const tickerTrades = await processOneTicker(ticker);
    allTrades.push(...tickerTrades);
  }
  console.log(`\nTotal pooled trades: ${allTrades.length}`);

  const inFilter = allTrades.filter((t) => t.in_base_filter);
  const nonFilter = allTrades.filter((t) => !t.in_base_filter);
  console.log(`Trades in base filter (discount + compressed): ${inFilter.length}`);

  printHourTable(`Per-hour distribution WITHIN base filter (n=${inFilter.length})`, aggregatePerHour(inFilter));
  printHourTable(`Per-hour distribution OUTSIDE base filter (n=${nonFilter.length})`, aggregatePerHour(nonFilter));

  // London(7-13) windowed sub-comparisons.
  console.log("\n=== London-window sub-buckets (base filter only) ===");
  const subWindows = [
    { label: "london full (7-13)", start: 7, end: 13 },
    { label: "london early (7-9)", start: 7, end: 9 },
    { label: "london mid (9-11)", start: 9, end: 11 },
    { label: "london late (11-13)", start: 11, end: 13 },
    { label: "london open hr (7-8)", start: 7, end: 8 },
    { label: "london open-close range (8-12)", start: 8, end: 12 },
  ];
  for (const w of subWindows) {
    const sub = inFilter.filter((t) => t.entry_hour_utc >= w.start && t.entry_hour_utc < w.end);
    if (sub.length === 0) {
      console.log(`  ${w.label.padEnd(34)}  EMPTY`);
      continue;
    }
    const sum = sub.reduce((s, t) => s + t.r, 0);
    const wins = sub.filter((t) => t.r > 0).length;
    console.log(
      `  ${w.label.padEnd(34)}  n=${String(sub.length).padStart(4)}  mean_R=${(sum / sub.length).toFixed(3).padStart(7)}  win%=${((wins * 100) / sub.length).toFixed(1).padStart(5)}`
    );
  }

  // V1.2 cluster baseline for comparison.
  const v12Cluster = inFilter.filter((t) => t.entry_hour_utc >= 7 && t.entry_hour_utc < 13);
  console.log(
    `\nV1.2 cluster baseline (discount + compressed + hour∈[7,13)): n=${v12Cluster.length}  mean_R=${(v12Cluster.reduce((s, t) => s + t.r, 0) / Math.max(1, v12Cluster.length)).toFixed(3)}`
  );

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/discovery-hour-level-cluster-${ts}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        tickers: TICKERS,
        method: "Filter trades to entry_zone=discount AND range=compressed. Within that, aggregate per UTC entry hour.",
        total_trades: allTrades.length,
        in_filter_n: inFilter.length,
        per_hour_in_filter: aggregatePerHour(inFilter),
        per_hour_out_filter: aggregatePerHour(nonFilter),
        sub_windows: subWindows.map((w) => {
          const sub = inFilter.filter((t) => t.entry_hour_utc >= w.start && t.entry_hour_utc < w.end);
          if (sub.length === 0) return { ...w, n: 0, mean_r: 0, win_pct: 0 };
          const sum = sub.reduce((s, t) => s + t.r, 0);
          const wins = sub.filter((t) => t.r > 0).length;
          return { ...w, n: sub.length, mean_r: sum / sub.length, win_pct: (wins * 100) / sub.length };
        }),
        v12_cluster_baseline: {
          n: v12Cluster.length,
          mean_r: v12Cluster.reduce((s, t) => s + t.r, 0) / Math.max(1, v12Cluster.length),
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
