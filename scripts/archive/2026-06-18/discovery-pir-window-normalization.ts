/**
 * position_in_range (PIR) window normalization screen — closes #241.
 *
 * V1.2 cluster mining + the live `entry_zone` gate primitive both compute
 * PIR as "where is price in the last 20-bar high-low range." But 20 bars
 * means a different real-time horizon per TF:
 *
 *   30m algo: 20 bars = 10 hours
 *   1h  algo: 20 bars = 20 hours
 *   4h  algo: 20 bars = 3.3 days
 *
 * V1.2's discount-cluster pools across algos with all three TFs. Each
 * algo's contribution uses a different definition of "discount." This
 * screen tests whether normalizing PIR to a TIME-based window (24 hours
 * regardless of TF) sharpens or blurs the V1.2 cluster signature.
 *
 * Method:
 *   For every trade in the V1.2-style corpus, compute:
 *     - entry_zone_legacy:  20-bar window per TF (V1.2's definition)
 *     - entry_zone_24h:     24-hour window per TF (normalized)
 *   Cluster filter: entry_zone ∈ {discount} AND london(7-13) AND range=compressed.
 *   Compare:
 *     - cluster size (n) legacy vs normalized
 *     - cluster mean R legacy vs normalized
 *     - overlap (trades in both clusters)
 *     - diff sets (trades in legacy-only, normalized-only) with their R
 *
 * What we DON'T do:
 *   Change the live gate definition. The deployed shadow gates accumulate
 *   data on the legacy definition; switching definitions mid-stream would
 *   invalidate the accumulation. This is a forward-looking proposal for
 *   V1.3 mining if normalization sharpens.
 *
 * Output: writes `scripts/discovery-pir-window-normalization-<ts>.json`.
 *
 * Usage:
 *   pnpm dlx tsx scripts/discovery-pir-window-normalization.ts
 *   TICKERS=XAU/USD pnpm dlx tsx scripts/discovery-pir-window-normalization.ts
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

// ----- Constants must mirror V1.2. -----
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

/** PIR computed over a sliding window of `windowBars` bars ending at the
 *  entry bar. This is V1.2's definition with the window count
 *  parametrized. */
function positionInRangeBars(
  corpusBars: { date: string; high: number; low: number }[],
  entryDate: string,
  entryPrice: number,
  windowBars: number
): number | null {
  const idx = findBarIdx(corpusBars, entryDate);
  if (idx < windowBars) return null;
  let hiV = -Infinity, loV = Infinity;
  for (let i = idx - (windowBars - 1); i <= idx; i++) {
    hiV = Math.max(hiV, corpusBars[i].high);
    loV = Math.min(loV, corpusBars[i].low);
  }
  if (hiV <= loV) return null;
  const pct = ((entryPrice - loV) / (hiV - loV)) * 100;
  return Math.max(0, Math.min(100, pct));
}

/** Map TF → bars-per-24h (assumes continuous market hours; gold + forex
 *  effectively run 24/5 so this approximation is fine for the screen). */
function barsPer24h(tf: "4h" | "1h" | "30m"): number {
  if (tf === "4h") return 6;
  if (tf === "1h") return 24;
  return 48; // 30m
}

type EntryZone = "discount" | "equilibrium" | "premium" | "n/a";

function entryZoneOf(posPct: number | null): EntryZone {
  if (posPct === null) return "n/a";
  if (posPct < 33) return "discount";
  if (posPct < 67) return "equilibrium";
  return "premium";
}

type EntryHourBucket = "asia(0-7)" | "london(7-13)" | "ny(13-21)" | "late(21-24)";
function entryHourBucketOf(hour: number): EntryHourBucket {
  if (hour < 7) return "asia(0-7)";
  if (hour < 13) return "london(7-13)";
  if (hour < 21) return "ny(13-21)";
  return "late(21-24)";
}

interface TaggedTrade {
  ticker: string;
  algo: string;
  timeframe: "4h" | "1h" | "30m";
  side: "long" | "short";
  pnl: number;
  r: number;
  entry_date: string;
  exit_date: string;
  entry_zone_legacy: EntryZone;
  entry_zone_24h: EntryZone;
  entry_hour_bucket: EntryHourBucket;
  range: string;
  pir_legacy: number | null;
  pir_24h: number | null;
  in_cluster_legacy: boolean;
  in_cluster_24h: boolean;
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
    const window24h = barsPer24h(s.timeframe);

    for (const t of trades) {
      const tfBars = corpus.bars as { date: string; high: number; low: number; close: number; open: number; volume: number }[];
      const pirLegacy = positionInRangeBars(tfBars, t.entry_date, t.entry_price, 20);
      const pir24h = positionInRangeBars(tfBars, t.entry_date, t.entry_price, window24h);
      const entryHour = new Date(t.entry_date).getUTCHours();

      const ms4hIdx = findBarIdx(inputs.bars4h, t.entry_date);
      const range = ms4hIdx >= 0 ? computeMarketState4h(inputs, ms4hIdx).range : "n/a";

      const entry_zone_legacy = entryZoneOf(pirLegacy);
      const entry_zone_24h = entryZoneOf(pir24h);
      const entry_hour_bucket = entryHourBucketOf(entryHour);

      const baseClusterMatch =
        entry_hour_bucket === "london(7-13)" && range === "compressed";

      tickerTrades.push({
        ticker,
        algo: s.key,
        timeframe: s.timeframe,
        side: t.side,
        pnl: t.pnl,
        r: t.pnl / RISK_DOLLARS,
        entry_date: t.entry_date,
        exit_date: t.exit_date,
        entry_zone_legacy,
        entry_zone_24h,
        entry_hour_bucket,
        range,
        pir_legacy: pirLegacy,
        pir_24h: pir24h,
        in_cluster_legacy: baseClusterMatch && entry_zone_legacy === "discount",
        in_cluster_24h: baseClusterMatch && entry_zone_24h === "discount",
      });
    }

    console.log(`  ${s.key.padEnd(28)} → ${trades.length} trades`);
  }

  return tickerTrades;
}

interface Agg {
  n: number;
  mean_r: number;
  win_pct: number;
}

function aggregate(rs: number[]): Agg {
  if (rs.length === 0) return { n: 0, mean_r: 0, win_pct: 0 };
  const sum = rs.reduce((s, x) => s + x, 0);
  const wins = rs.filter((x) => x > 0).length;
  return { n: rs.length, mean_r: sum / rs.length, win_pct: (wins * 100) / rs.length };
}

function printAgg(label: string, agg: Agg): void {
  console.log(`  ${label.padEnd(35)} n=${String(agg.n).padStart(4)}  mean_R=${agg.mean_r.toFixed(3).padStart(7)}  win%=${agg.win_pct.toFixed(1).padStart(5)}`);
}

async function main() {
  console.log("Discovery — position_in_range window normalization");
  console.log(`Tickers: ${TICKERS.join(", ")}`);
  console.log("Comparing legacy (20-bar) vs 24h-normalized PIR on V1.2 cluster");

  const allTrades: TaggedTrade[] = [];
  for (const ticker of TICKERS) {
    const tickerTrades = await processOneTicker(ticker);
    allTrades.push(...tickerTrades);
  }
  console.log(`\nTotal pooled trades: ${allTrades.length}`);

  // ----- Cluster comparison -----
  const legacyMembers = allTrades.filter((t) => t.in_cluster_legacy);
  const normMembers = allTrades.filter((t) => t.in_cluster_24h);
  const bothMembers = allTrades.filter((t) => t.in_cluster_legacy && t.in_cluster_24h);
  const legacyOnly = allTrades.filter((t) => t.in_cluster_legacy && !t.in_cluster_24h);
  const normOnly = allTrades.filter((t) => !t.in_cluster_legacy && t.in_cluster_24h);
  const inEither = allTrades.filter((t) => t.in_cluster_legacy || t.in_cluster_24h);
  const inNeither = allTrades.filter((t) => !t.in_cluster_legacy && !t.in_cluster_24h);

  console.log("\n=== Cluster signature comparison ===");
  printAgg("Legacy cluster (20-bar):", aggregate(legacyMembers.map((t) => t.r)));
  printAgg("Normalized cluster (24h):", aggregate(normMembers.map((t) => t.r)));
  printAgg("Both definitions overlap:", aggregate(bothMembers.map((t) => t.r)));
  printAgg("Legacy-only (NOT in 24h):", aggregate(legacyOnly.map((t) => t.r)));
  printAgg("Normalized-only (NOT in legacy):", aggregate(normOnly.map((t) => t.r)));
  printAgg("In either cluster (union):", aggregate(inEither.map((t) => t.r)));
  printAgg("In neither (non-cluster):", aggregate(inNeither.map((t) => t.r)));

  // ----- Per-TF decomposition (the real question) -----
  console.log("\n=== Per-TF: who actually gets shifted by normalization ===");
  for (const tf of ["30m", "1h", "4h"] as const) {
    const tfTrades = allTrades.filter((t) => t.timeframe === tf);
    const tfLegacy = tfTrades.filter((t) => t.in_cluster_legacy);
    const tfNorm = tfTrades.filter((t) => t.in_cluster_24h);
    const tfBoth = tfTrades.filter((t) => t.in_cluster_legacy && t.in_cluster_24h);
    console.log(`\n  ${tf} (${tfTrades.length} trades total):`);
    printAgg(`    legacy in cluster:`, aggregate(tfLegacy.map((t) => t.r)));
    printAgg(`    24h in cluster:`, aggregate(tfNorm.map((t) => t.r)));
    printAgg(`    overlap:`, aggregate(tfBoth.map((t) => t.r)));
  }

  // ----- Sharper signature scoring -----
  const legacyAgg = aggregate(legacyMembers.map((t) => t.r));
  const normAgg = aggregate(normMembers.map((t) => t.r));
  console.log("\n=== Headline ===");
  console.log(`Legacy cluster:     n=${legacyAgg.n}  mean_R=${legacyAgg.mean_r.toFixed(3)}`);
  console.log(`Normalized cluster: n=${normAgg.n}  mean_R=${normAgg.mean_r.toFixed(3)}`);
  if (normAgg.n > 0 && legacyAgg.n > 0) {
    if (Math.abs(normAgg.mean_r) > Math.abs(legacyAgg.mean_r) * 1.05) {
      console.log(`→ Normalized is SHARPER (|R| ${Math.abs(normAgg.mean_r).toFixed(2)} vs ${Math.abs(legacyAgg.mean_r).toFixed(2)})`);
    } else if (Math.abs(normAgg.mean_r) < Math.abs(legacyAgg.mean_r) * 0.95) {
      console.log(`→ Legacy is SHARPER (|R| ${Math.abs(legacyAgg.mean_r).toFixed(2)} vs ${Math.abs(normAgg.mean_r).toFixed(2)})`);
    } else {
      console.log(`→ Comparable signature (|R| within 5%). Normalization neither helps nor hurts.`);
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/discovery-pir-window-normalization-${ts}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        tickers: TICKERS,
        method: "Compare entry_zone = discount derived from PIR over 20-bar window (legacy) vs 24h window (normalized). Cluster filter: entry_zone=discount AND entry_hour_bucket=london(7-13) AND range=compressed.",
        total_trades: allTrades.length,
        clusters: {
          legacy: aggregate(legacyMembers.map((t) => t.r)),
          normalized_24h: aggregate(normMembers.map((t) => t.r)),
          overlap: aggregate(bothMembers.map((t) => t.r)),
          legacy_only: aggregate(legacyOnly.map((t) => t.r)),
          normalized_only: aggregate(normOnly.map((t) => t.r)),
          union: aggregate(inEither.map((t) => t.r)),
          non_cluster: aggregate(inNeither.map((t) => t.r)),
        },
        per_tf: ["30m", "1h", "4h"].map((tf) => {
          const tfTrades = allTrades.filter((t) => t.timeframe === tf);
          return {
            timeframe: tf,
            total: tfTrades.length,
            legacy: aggregate(tfTrades.filter((t) => t.in_cluster_legacy).map((t) => t.r)),
            normalized_24h: aggregate(tfTrades.filter((t) => t.in_cluster_24h).map((t) => t.r)),
          };
        }),
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
