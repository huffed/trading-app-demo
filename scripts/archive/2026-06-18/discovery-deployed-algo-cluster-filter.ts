/**
 * Cluster-filter rescue check on deployed library algos.
 *
 * Question: the V1.2 cluster gate (discount ∩ london(7-13) ∩ compressed,
 * shadow=true) was deployed on dip_buyer_4h + bear_short_4h via PR #240
 * composite + on fvg_long_30m + coil_breakout_1h via PR #237 solo. We
 * never measured whether the gate, when it flips from shadow→enforce,
 * would rescue any algo's expectancy. Per `feedback_validate_filters_via_backtest`,
 * settle this against the corpus, not against future live data.
 *
 * Output (gold-only, since deployment is gold-only):
 *   Per deployed algo: pre-filter (n, mean_R), post-filter (n, mean_R),
 *   cluster-only (n, mean_R), R saved per refusal.
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
const TICKERS = (process.env.TICKERS ?? "XAU/USD").split(",").map((s) => s.trim());
const FRICTION_SLIPPAGE_BPS = 0.5;
const FRICTION_SPREAD_BPS = 0.4;
const DEPLOYED = new Set(["dip_buyer_4h", "bear_short_4h", "fvg_long_30m", "coil_breakout_1h"]);

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
  const cb1 = baseRules("1h", "long", ac);
  cb1.entry_conditions = [{ type: "pattern", pattern: "bos", direction: "bullish", lookback: 5, timeframe: "1h" }];
  const bs = baseRules("4h", "short", ac);
  bs.entry_conditions = [
    { type: "pattern", pattern: "bos", direction: "bearish", lookback: 5, timeframe: "4h" },
    { type: "pattern", pattern: "daily_bias", direction: "bearish", ma_period: 20, timeframe: "4h" },
  ];
  bs.market_state_gate = { mode: "allow", states: { mtf: ["aligned_LH"] } };
  const fv = baseRules("30m", "long", ac);
  fv.entry_conditions = [{ type: "pattern", pattern: "fvg", direction: "bullish", timeframe: "30m" }];
  return [
    { key: "dip_buyer_4h", timeframe: "4h", rules: db, gate: true },
    { key: "coil_breakout_1h", timeframe: "1h", rules: cb1, gate: false },
    { key: "bear_short_4h", timeframe: "4h", rules: bs, gate: true },
    { key: "fvg_long_30m", timeframe: "30m", rules: fv, gate: false },
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
  let hi = -Infinity, lo = Infinity;
  for (let i = idx - 19; i <= idx; i++) {
    hi = Math.max(hi, corpusBars[i].high);
    lo = Math.min(lo, corpusBars[i].low);
  }
  if (hi <= lo) return null;
  return Math.max(0, Math.min(100, ((entryPrice - lo) / (hi - lo)) * 100));
}

interface T { algo: string; ticker: string; r: number; in_cluster: boolean; }

async function processOneTicker(ticker: string): Promise<T[]> {
  const ac = assetClassFor(ticker);
  console.log(`\n--- ${ticker} ---`);
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
      const hour = new Date(t.entry_date).getUTCHours();
      const ms4 = findBarIdx(inputs.bars4h, t.entry_date);
      const range = ms4 >= 0 ? computeMarketState4h(inputs, ms4).range : "n/a";
      const entry_zone = pir === null ? "n/a" : pir < 33 ? "discount" : pir < 67 ? "equilibrium" : "premium";
      const in_cluster = entry_zone === "discount" && hour >= 7 && hour < 13 && range === "compressed";
      out.push({ algo: s.key, ticker, r: t.pnl / RISK_DOLLARS, in_cluster });
    }
    console.log(`  ${s.key.padEnd(28)} → ${trades.length} trades`);
  }
  return out;
}

function agg(rs: number[]): { n: number; mean_r: number; total_r: number } {
  if (rs.length === 0) return { n: 0, mean_r: 0, total_r: 0 };
  const s = rs.reduce((a, x) => a + x, 0);
  return { n: rs.length, mean_r: s / rs.length, total_r: s };
}

async function main() {
  console.log("Cluster-filter rescue check on deployed library algos");
  console.log(`Tickers: ${TICKERS.join(", ")} (gold-only by default)`);

  const all: T[] = [];
  for (const t of TICKERS) all.push(...(await processOneTicker(t)));
  console.log(`\nTotal pooled trades: ${all.length}\n`);

  console.log("=== Per deployed algo, gold-only ===");
  console.log("Algo                          pre-filter        post-filter (refused cluster)   cluster-only   R saved/refusal");
  console.log("                              n     mean_R       n     mean_R                   n     mean_R");
  for (const algo of Array.from(DEPLOYED)) {
    const algoTrades = all.filter((t) => t.algo === algo);
    const pre = agg(algoTrades.map((t) => t.r));
    const post = agg(algoTrades.filter((t) => !t.in_cluster).map((t) => t.r));
    const cluster = agg(algoTrades.filter((t) => t.in_cluster).map((t) => t.r));
    const saved = cluster.n > 0 ? post.mean_r - cluster.mean_r : 0;
    const deltaPre = (post.mean_r - pre.mean_r).toFixed(3);
    console.log(
      `${algo.padEnd(28)}  ${String(pre.n).padStart(4)}  ${pre.mean_r.toFixed(3).padStart(7)}    ${String(post.n).padStart(4)}  ${post.mean_r.toFixed(3).padStart(7)} (Δ${deltaPre.padStart(7)})    ${String(cluster.n).padStart(4)}  ${cluster.mean_r.toFixed(3).padStart(7)}    ${saved.toFixed(3).padStart(7)}R`
    );
  }

  console.log("\n=== Verdict per algo ===");
  for (const algo of Array.from(DEPLOYED)) {
    const algoTrades = all.filter((t) => t.algo === algo);
    const pre = agg(algoTrades.map((t) => t.r));
    const post = agg(algoTrades.filter((t) => !t.in_cluster).map((t) => t.r));
    const cluster = agg(algoTrades.filter((t) => t.in_cluster).map((t) => t.r));
    let verdict = "";
    if (pre.mean_r > 0 && post.mean_r > 0) verdict = "already positive, gate confirms";
    else if (pre.mean_r < 0 && post.mean_r > 0) verdict = "✓ GATE RESCUES (flip-to-enforce justified)";
    else if (pre.mean_r < 0 && post.mean_r < 0) verdict = "✗ gate insufficient — still negative";
    else if (pre.mean_r > 0 && post.mean_r < 0) verdict = "unexpected — gate REMOVES winners";
    if (cluster.n === 0) verdict = "no cluster trades — gate doesn't trigger on this algo";
    console.log(`  ${algo.padEnd(28)} ${verdict}`);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  writeFileSync(
    `scripts/discovery-deployed-algo-cluster-filter-${ts}.json`,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        tickers: TICKERS,
        per_algo: Array.from(DEPLOYED).map((algo) => {
          const algoTrades = all.filter((t) => t.algo === algo);
          return {
            algo,
            pre_filter: agg(algoTrades.map((t) => t.r)),
            post_filter: agg(algoTrades.filter((t) => !t.in_cluster).map((t) => t.r)),
            cluster_only: agg(algoTrades.filter((t) => t.in_cluster).map((t) => t.r)),
          };
        }),
      },
      null, 2
    )
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
