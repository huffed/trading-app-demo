/**
 * R/R achieved vs targeted, decomposed by exit_reason.
 * Closes #243 (Tier-1 value-multiplier sharpening V1.2 interpretation).
 *
 * Question driving this screen:
 *   When the V1.2 shadow gate refuses an entry, is it preventing
 *   ~1R bleed or ~5R bleed per refusal? The mean R per cluster (-0.76)
 *   doesn't tell us — it pools full-SL hits (each -1R) with stagnant
 *   cuts (small magnitude) with the rare big runner that turned over.
 *
 * Approach:
 *   - Replicate V1.2's trade-corpus generation (same TICKERS, same algo
 *     specs, same chunk window, same RISK_DOLLARS denominator), but skip
 *     the ChoCh/OTE/multi-feature bucketization — only need the 3
 *     V1.2-cluster features (entry_zone, entry_hour_bucket, range).
 *   - For each trade also capture `exit_reason` (this is the new field
 *     vs V1.2).
 *   - Tag cluster membership: `discount ∩ london(7-13) ∩ compressed`.
 *   - Aggregate per (cluster_member?, exit_reason): n, mean_R, p25/p50/
 *     p75, max_loss_R, achievement share.
 *
 * Why standalone (vs importing from V1.2):
 *   V1.2 is a pre-registered locked design. Touching it forces a re-run
 *   to verify cluster signatures unchanged. The corpus-generation
 *   helpers here are a literal subset of V1.2's — if V1.2's spec table
 *   evolves we re-sync, but until then we leave it alone.
 *
 * Output: writes `scripts/discovery-rr-achievement-<ts>.json` with the
 * full aggregation. Prints a console summary.
 *
 * Usage:
 *   pnpm dlx tsx scripts/discovery-rr-achievement.ts
 *   TICKERS=XAU/USD pnpm dlx tsx scripts/discovery-rr-achievement.ts
 */
import { writeFileSync } from "fs";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import type { MarketStateSeries } from "../src/lib/market-data/portfolio-backtest";
import type { BacktestExitReason, BacktestTrade } from "../src/lib/market-data/types";
import {
  computeMarketState4h,
  type MarketStateInputs,
} from "../src/lib/market-data/market-state";
import type { AlgorithmRules } from "../src/types/algorithm";
import { loadCorpus, type Corpus } from "./llm-trader-backtest";

// ----- Constants must mirror V1.2 so the trade corpus matches. -----
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

function lastIdxAtOrBefore(bars: { date: string }[], targetDate: string): number {
  return findBarIdx(bars, targetDate);
}

function positionInRange(
  corpusBars: { date: string; high: number; low: number; close: number }[],
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
type EntryHourBucket = "asia(0-7)" | "london(7-13)" | "ny(13-21)" | "late(21-24)";

function entryZoneOf(posPct: number | null): EntryZone {
  if (posPct === null) return "n/a";
  if (posPct < 33) return "discount";
  if (posPct < 67) return "equilibrium";
  return "premium";
}

function entryHourBucketOf(hour: number): EntryHourBucket {
  if (hour < 7) return "asia(0-7)";
  if (hour < 13) return "london(7-13)";
  if (hour < 21) return "ny(13-21)";
  return "late(21-24)";
}

interface TaggedTrade {
  ticker: string;
  algo: string;
  side: "long" | "short";
  pnl: number;
  r: number;
  entry_date: string;
  exit_date: string;
  exit_reason: BacktestExitReason | "unknown";
  entry_zone: EntryZone;
  entry_hour_bucket: EntryHourBucket;
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
      const entryHour = new Date(t.entry_date).getUTCHours();

      // range state at entry comes from the 4h market state. Use the
      // last 4h bar at-or-before the entry — same lookup V1.2 uses.
      const ms4hIdx = lastIdxAtOrBefore(inputs.bars4h, t.entry_date);
      const range = ms4hIdx >= 0 ? computeMarketState4h(inputs, ms4hIdx).range : "n/a";

      const entry_zone = entryZoneOf(posInRange);
      const entry_hour_bucket = entryHourBucketOf(entryHour);
      const in_v12_cluster =
        entry_zone === "discount" &&
        entry_hour_bucket === "london(7-13)" &&
        range === "compressed";

      tickerTrades.push({
        ticker,
        algo: s.key,
        side: t.side,
        pnl: t.pnl,
        r: t.pnl / RISK_DOLLARS,
        entry_date: t.entry_date,
        exit_date: t.exit_date,
        exit_reason: t.exit_reason ?? "unknown",
        entry_zone,
        entry_hour_bucket,
        range,
        in_v12_cluster,
      });
    }

    console.log(`  ${s.key.padEnd(28)} → ${trades.length} trades`);
  }

  return tickerTrades;
}

// ----- Aggregation -----

interface Aggregate {
  n: number;
  mean_r: number;
  p25_r: number;
  p50_r: number;
  p75_r: number;
  max_loss_r: number;
  max_win_r: number;
  win_pct: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function aggregate(rs: number[]): Aggregate {
  if (rs.length === 0) {
    return { n: 0, mean_r: 0, p25_r: 0, p50_r: 0, p75_r: 0, max_loss_r: 0, max_win_r: 0, win_pct: 0 };
  }
  const sorted = [...rs].sort((a, b) => a - b);
  const sum = rs.reduce((s, x) => s + x, 0);
  const wins = rs.filter((x) => x > 0).length;
  return {
    n: rs.length,
    mean_r: sum / rs.length,
    p25_r: quantile(sorted, 0.25),
    p50_r: quantile(sorted, 0.5),
    p75_r: quantile(sorted, 0.75),
    max_loss_r: sorted[0],
    max_win_r: sorted[sorted.length - 1],
    win_pct: (wins * 100) / rs.length,
  };
}

interface SegmentReport {
  segment: string;
  by_exit_reason: Record<string, Aggregate>;
  overall: Aggregate;
  exit_reason_share_pct: Record<string, number>;
}

function buildSegment(label: string, trades: TaggedTrade[]): SegmentReport {
  const groups = new Map<string, number[]>();
  for (const t of trades) {
    const key = t.exit_reason;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t.r);
  }
  const by_exit_reason: Record<string, Aggregate> = {};
  const exit_reason_share_pct: Record<string, number> = {};
  for (const [key, rs] of groups) {
    by_exit_reason[key] = aggregate(rs);
    exit_reason_share_pct[key] = (rs.length * 100) / Math.max(1, trades.length);
  }
  return {
    segment: label,
    by_exit_reason,
    overall: aggregate(trades.map((t) => t.r)),
    exit_reason_share_pct,
  };
}

function printSegment(seg: SegmentReport): void {
  console.log(`\n=== ${seg.segment} ===`);
  console.log(`Overall: n=${seg.overall.n} mean_R=${seg.overall.mean_r.toFixed(3)} win%=${seg.overall.win_pct.toFixed(1)}`);
  console.log(
    `  p25/p50/p75 R: ${seg.overall.p25_r.toFixed(2)} / ${seg.overall.p50_r.toFixed(2)} / ${seg.overall.p75_r.toFixed(2)}`
  );
  console.log(`  max_loss_R=${seg.overall.max_loss_r.toFixed(2)}  max_win_R=${seg.overall.max_win_r.toFixed(2)}`);
  console.log("\n  By exit_reason:");
  const rows = Object.entries(seg.by_exit_reason).sort((a, b) => b[1].n - a[1].n);
  for (const [reason, agg] of rows) {
    const share = seg.exit_reason_share_pct[reason].toFixed(1);
    console.log(
      `    ${reason.padEnd(16)} n=${String(agg.n).padStart(4)} (${share.padStart(5)}%) mean_R=${agg.mean_r.toFixed(3).padStart(7)}  p50=${agg.p50_r.toFixed(2).padStart(6)}  max_loss=${agg.max_loss_r.toFixed(2).padStart(6)}`
    );
  }
}

async function main() {
  console.log("Discovery — R/R achievement decomposed by exit_reason");
  console.log(`Tickers: ${TICKERS.join(", ")}`);
  console.log("V1.2 cluster: entry_zone=discount AND entry_hour_bucket=london(7-13) AND range=compressed");

  const allTrades: TaggedTrade[] = [];
  for (const ticker of TICKERS) {
    const tickerTrades = await processOneTicker(ticker);
    allTrades.push(...tickerTrades);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Total pooled trades: ${allTrades.length}`);
  console.log(`V1.2-cluster members: ${allTrades.filter((t) => t.in_v12_cluster).length}`);
  console.log(`${"=".repeat(60)}`);

  const clusterMembers = allTrades.filter((t) => t.in_v12_cluster);
  const nonClusterMembers = allTrades.filter((t) => !t.in_v12_cluster);

  const segments: SegmentReport[] = [
    buildSegment("V1.2 cluster (discount ∩ london ∩ compressed)", clusterMembers),
    buildSegment("Non-cluster (everything else)", nonClusterMembers),
    buildSegment("All pooled", allTrades),
  ];

  for (const seg of segments) printSegment(seg);

  // Cluster-vs-non headline.
  if (clusterMembers.length > 0 && nonClusterMembers.length > 0) {
    const c = aggregate(clusterMembers.map((t) => t.r));
    const nc = aggregate(nonClusterMembers.map((t) => t.r));
    console.log("\n=== Cluster bleed decomposition (the headline #243 number) ===");
    console.log(`Cluster mean R = ${c.mean_r.toFixed(3)} (n=${c.n})`);
    console.log(`Non-cluster mean R = ${nc.mean_r.toFixed(3)} (n=${nc.n})`);
    console.log(`Delta per cluster refusal (if shadow→enforce): saves ~${(nc.mean_r - c.mean_r).toFixed(3)} R per refused trade`);

    const slHitInCluster = clusterMembers.filter((t) => t.exit_reason === "stop_loss_hit");
    const slShare = (slHitInCluster.length * 100) / Math.max(1, clusterMembers.length);
    const slMeanR =
      slHitInCluster.length > 0
        ? slHitInCluster.reduce((s, t) => s + t.r, 0) / slHitInCluster.length
        : 0;
    console.log(`Of cluster trades: ${slShare.toFixed(1)}% hit full SL (mean R ${slMeanR.toFixed(2)})`);
    console.log("→ Higher full-SL share = simpler shadow→enforce decision (refusal almost always saves ~1R).");
    console.log("→ Lower full-SL share = murkier (refusals may interrupt trades that would have stagnant-cut anyway).");
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/discovery-rr-achievement-${ts}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        tickers: TICKERS,
        v12_cluster_definition: {
          entry_zone: "discount",
          entry_hour_bucket: "london(7-13)",
          range: "compressed",
        },
        total_trades: allTrades.length,
        cluster_n: clusterMembers.length,
        segments,
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
