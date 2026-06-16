/**
 * V1 — Discovery: LOSER-pattern cluster mining (issue #227).
 *
 * Symmetric to discovery-v1-winning-trade-clusters.ts. Same harness,
 * same features, same TRAIN/TEST discipline — but the hard gates are
 * inverted to surface clusters where LOSING trades concentrate.
 *
 * Why this exists: V1.1 surfaced what WINNERS share. The symmetric
 * blind spot was never run. Per the 2026-06-16 discovery-gaps audit
 * (project_discovery_gaps_audit_2026_06 memory), this is the
 * cheapest-highest-leverage audit gap to close. Each robust losing
 * cluster suggests a state-gate to ADD on existing algos (block when
 * these conditions co-occur) — one-line config change per algo if a
 * cluster survives.
 *
 * ============================================================
 * PRE-REGISTERED DESIGN — LOCKED 2026-06-16 (separate from V1.1)
 * Do NOT edit constants after seeing results.
 * Editing post-hoc invalidates the experiment per
 * feedback_audit_proposals_rigorously_before_presenting.
 * ============================================================
 *
 *  Decision      | Pick (mirrors V1.1 except where INVERTED for losers)
 *  --------------|----------------------------------------------
 *  1. Features   | Same 9 features as V1.1 (cohort schema):
 *                |   side, ticker, regime, entry_zone,
 *                |   entry_hour_bucket, mtf, vol, range, dxy
 *  2. Corpus     | Same library + mean_reversion configs as V1.1
 *  3. Combinatorics | Bivariate (same as V1.1)
 *  4. Hard gates | INVERTED:
 *                |   pool meanR ≤ -0.4 (negative; was ≥ +0.4 for winners)
 *                |   n ≥ 20 (same)
 *                |   n ≥ 8 in TRAIN, n ≥ 8 in TEST (same)
 *                |   TRAIN mean R < 0 (was > 0 for winners)
 *                |   TEST mean R < 0 (was > 0 for winners)
 *  5. Split      | Per-algo midpoint by trade count (same)
 *  6. Aggregation| Pooled across all algos (same)
 *  7. Output     | Top-15 LOSING clusters ranked by |pool_meanR| × pool_n
 *                | (same magnitude × confidence ordering)
 *
 * Friction: realistic (slippage 0.5 bps, spread 0.4 bps) — matches
 * V1.1 + live config.
 *
 * Three possible outcomes (all useful):
 *   - No clusters survive → loss patterns are evenly distributed; no
 *     systematic block-gate candidates surface. Confirmation that
 *     existing state gates may be sufficient.
 *   - Surviving clusters MATCH features already in existing block-mode
 *     gates (e.g., we already block dip_buyer on `fast_div_bull` and
 *     it shows up as a losing cluster) → validates existing gate config.
 *   - Surviving clusters DON'T match existing block-mode gates → genuine
 *     "what to avoid" candidates. Each robust losing cluster becomes a
 *     candidate state-gate block on the algos that traded in it.
 */
import { writeFileSync } from "fs";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import type { MarketStateSeries } from "../src/lib/market-data/portfolio-backtest";
import type { BacktestTrade } from "../src/lib/market-data/types";
import type { AlgorithmRules } from "../src/types/algorithm";
import { loadCorpus, type Corpus } from "./llm-trader-backtest";
import {
  computeMarketState4h,
  swingRegime,
  lastIdxAtOrBefore,
  type MarketStateInputs,
  type MarketState,
} from "../src/lib/market-data/market-state";

// ----- PRE-REGISTERED CONSTANTS (locked) -----
const CAPITAL = 100_000;
const RISK_PCT = 0.6;
const RISK_DOLLARS = (CAPITAL * RISK_PCT) / 100;
const CHUNK_DAYS = 90;
const DAY_MS = 86_400_000;
const TICKERS = (process.env.TICKERS ?? process.env.TICKER ?? "XAU/USD")
  .split(",")
  .map((s) => s.trim());
const FRICTION_SLIPPAGE_BPS = 0.5;
const FRICTION_SPREAD_BPS = 0.4;

function assetClassFor(ticker: string): "commodity" | "forex" {
  return ticker.startsWith("XAU") || ticker.startsWith("XAG") ? "commodity" : "forex";
}

// INVERTED for losers
const HARD_GATES = {
  MIN_POOLED_N: 20,
  MIN_HALF_N: 8,
  MAX_POOLED_MEAN_R: -0.4, // pooled meanR must be ≤ this (negative)
  MAX_TRAIN_MEAN_R: 0.0, // TRAIN meanR must be < 0
  MAX_TEST_MEAN_R: 0.0, // TEST meanR must be < 0
} as const;

const FEATURES = [
  "side",
  "ticker",
  "regime",
  "entry_zone",
  "entry_hour_bucket",
  "mtf",
  "vol",
  "range",
  "dxy",
] as const;
type Feature = (typeof FEATURES)[number];

const TOP_N_OUTPUT = 15;

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
  // Identical spec list to V1.1 — same library configs + mean_reversion
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

function entryBarIndex(inputs: MarketStateInputs, entryDate: string): number {
  return lastIdxAtOrBefore(inputs.bars4h, entryDate);
}

function positionInRange(
  corpusBars: { date: string; high: number; low: number; close: number }[],
  entryDate: string,
  side: "long" | "short",
  entryPrice: number
): number | null {
  let idx = -1;
  let lo = 0,
    hi = corpusBars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (corpusBars[mid].date <= entryDate) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (idx < 20) return null;
  let hiV = -Infinity,
    loV = Infinity;
  for (let i = idx - 19; i <= idx; i++) {
    hiV = Math.max(hiV, corpusBars[i].high);
    loV = Math.min(loV, corpusBars[i].low);
  }
  if (hiV <= loV) return null;
  const pct = ((entryPrice - loV) / (hiV - loV)) * 100;
  return Math.max(0, Math.min(100, pct));
}

function bucketize(features: {
  side: "long" | "short";
  ticker: string;
  regime: string;
  positionInRangePct: number | null;
  entryHourUtc: number;
  state: MarketState;
}) {
  const entryZone = features.positionInRangePct === null
    ? "n/a"
    : features.positionInRangePct < 33 ? "discount"
    : features.positionInRangePct < 67 ? "equilibrium"
    : "premium";
  const entryHourBucket =
    features.entryHourUtc < 7 ? "asia(0-7)"
    : features.entryHourUtc < 13 ? "london(7-13)"
    : features.entryHourUtc < 21 ? "ny(13-21)"
    : "late(21-24)";
  return {
    side: features.side,
    ticker: features.ticker,
    regime: features.regime,
    entry_zone: entryZone,
    entry_hour_bucket: entryHourBucket,
    mtf: features.state.mtf,
    vol: features.state.vol,
    range: features.state.range,
    dxy: features.state.dxy,
  } as Record<Feature, string>;
}

interface TaggedTrade {
  algo: string;
  side: "long" | "short";
  pnl: number;
  r: number;
  entryDate: string;
  features: Record<Feature, string>;
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

  const localChunked = (
    rules: AlgorithmRules,
    corpus: Corpus,
    srs: MarketStateSeries | null
  ): BacktestTrade[] => {
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

    const algoTrades: TaggedTrade[] = [];
    for (const t of trades) {
      const barIdx = entryBarIndex(inputs, t.entry_date);
      if (barIdx < 0) continue;
      const st = computeMarketState4h(inputs, barIdx);
      const d1Idx = lastIdxAtOrBefore(corpus4h.dailyBars, t.entry_date.slice(0, 10) + " 00:00:00") - 1;
      const regimeRaw = d1Idx >= 7 ? swingRegime(corpus4h.dailyBars, d1Idx) : null;
      const regime = regimeRaw ?? "n/a";
      const tfBars = corpus.bars as { date: string; high: number; low: number; close: number }[];
      const posInRange = positionInRange(tfBars, t.entry_date, t.side, t.entry_price);
      const entryHour = new Date(t.entry_date).getUTCHours();

      const features = bucketize({
        side: t.side,
        ticker,
        regime,
        positionInRangePct: posInRange,
        entryHourUtc: entryHour,
        state: st,
      });

      algoTrades.push({
        algo: s.key,
        side: t.side,
        pnl: t.pnl,
        r: t.pnl / RISK_DOLLARS,
        entryDate: t.entry_date,
        features,
      });
    }

    algoTrades.sort((a, b) => a.entryDate.localeCompare(b.entryDate));
    const mid = Math.floor(algoTrades.length / 2);
    for (let i = 0; i < algoTrades.length; i++) {
      (algoTrades[i] as unknown as { half: "TRAIN" | "TEST" }).half = i < mid ? "TRAIN" : "TEST";
    }
    console.log(
      `  ${s.key.padEnd(22)} ${algoTrades.length} trades (${mid} train / ${algoTrades.length - mid} test)`
    );
    tickerTrades.push(...algoTrades);
  }

  return tickerTrades;
}

async function main() {
  console.log("V1 LOSER-pattern cluster mining — PRE-REGISTERED design");
  console.log(`Tickers: ${TICKERS.join(", ")}`);
  console.log("Locked constants: see file header. Do NOT edit post-results.\n");

  const allTrades: TaggedTrade[] = [];
  for (const ticker of TICKERS) {
    const tickerTrades = await processOneTicker(ticker);
    allTrades.push(...tickerTrades);
  }

  console.log(`\nTotal pooled trades: ${allTrades.length}`);
  console.log(`Total losers (r<0):  ${allTrades.filter((t) => t.r < 0).length}`);
  console.log(`Total winners (r>0): ${allTrades.filter((t) => t.r > 0).length}`);
  console.log(
    `Pool meanR overall: ${(allTrades.reduce((s, t) => s + t.r, 0) / Math.max(1, allTrades.length)).toFixed(3)}`
  );

  type Stats = { sum: number; n: number };
  interface ClusterRow {
    f1: Feature;
    f2: Feature;
    b1: string;
    b2: string;
    pooledN: number;
    pooledMeanR: number;
    trainN: number;
    trainMeanR: number;
    testN: number;
    testMeanR: number;
    algos: string[];
    /** Magnitude × confidence score. For losers: |pool_meanR| × pool_n. */
    score: number;
    passed: boolean;
    fail_reason?: string;
  }
  const rows: ClusterRow[] = [];

  for (let i = 0; i < FEATURES.length; i++) {
    for (let j = i + 1; j < FEATURES.length; j++) {
      const f1 = FEATURES[i];
      const f2 = FEATURES[j];
      const cells = new Map<
        string,
        { pool: Stats; train: Stats; test: Stats; algos: Set<string> }
      >();
      for (const t of allTrades) {
        const half = (t as unknown as { half: "TRAIN" | "TEST" }).half;
        const key = `${t.features[f1]}|${t.features[f2]}`;
        let c = cells.get(key);
        if (!c) {
          c = {
            pool: { sum: 0, n: 0 },
            train: { sum: 0, n: 0 },
            test: { sum: 0, n: 0 },
            algos: new Set(),
          };
          cells.set(key, c);
        }
        c.pool.sum += t.r;
        c.pool.n++;
        c.algos.add(t.algo);
        if (half === "TRAIN") {
          c.train.sum += t.r;
          c.train.n++;
        } else {
          c.test.sum += t.r;
          c.test.n++;
        }
      }
      for (const [key, c] of cells) {
        const [b1, b2] = key.split("|");
        const pooledMeanR = c.pool.n > 0 ? c.pool.sum / c.pool.n : 0;
        const trainMeanR = c.train.n > 0 ? c.train.sum / c.train.n : 0;
        const testMeanR = c.test.n > 0 ? c.test.sum / c.test.n : 0;
        let passed = true;
        let fail_reason: string | undefined;
        if (c.pool.n < HARD_GATES.MIN_POOLED_N) {
          passed = false;
          fail_reason = `pooledN ${c.pool.n} < ${HARD_GATES.MIN_POOLED_N}`;
        } else if (c.train.n < HARD_GATES.MIN_HALF_N) {
          passed = false;
          fail_reason = `trainN ${c.train.n} < ${HARD_GATES.MIN_HALF_N}`;
        } else if (c.test.n < HARD_GATES.MIN_HALF_N) {
          passed = false;
          fail_reason = `testN ${c.test.n} < ${HARD_GATES.MIN_HALF_N}`;
        } else if (pooledMeanR > HARD_GATES.MAX_POOLED_MEAN_R) {
          passed = false;
          fail_reason = `pooledMeanR ${pooledMeanR.toFixed(2)} > ${HARD_GATES.MAX_POOLED_MEAN_R}`;
        } else if (trainMeanR >= HARD_GATES.MAX_TRAIN_MEAN_R) {
          passed = false;
          fail_reason = `trainMeanR ${trainMeanR.toFixed(2)} ≥ ${HARD_GATES.MAX_TRAIN_MEAN_R}`;
        } else if (testMeanR >= HARD_GATES.MAX_TEST_MEAN_R) {
          passed = false;
          fail_reason = `testMeanR ${testMeanR.toFixed(2)} ≥ ${HARD_GATES.MAX_TEST_MEAN_R}`;
        }
        rows.push({
          f1, f2, b1, b2,
          pooledN: c.pool.n, pooledMeanR,
          trainN: c.train.n, trainMeanR,
          testN: c.test.n, testMeanR,
          algos: [...c.algos].sort(),
          score: Math.abs(pooledMeanR) * c.pool.n,
          passed,
          fail_reason,
        });
      }
    }
  }

  const survivors = rows.filter((r) => r.passed).sort((a, b) => b.score - a.score);
  const allRanked = rows.slice().sort((a, b) => b.score - a.score);
  const topAll = allRanked.slice(0, TOP_N_OUTPUT);

  console.log(`\n=== Surviving LOSING clusters (passed all hard gates): ${survivors.length} ===`);
  if (survivors.length === 0) {
    console.log("(none — loss patterns evenly distributed; existing gate config may be sufficient)");
  } else {
    for (const r of survivors) {
      const combo = `${r.f1}=${r.b1}, ${r.f2}=${r.b2}`;
      console.log(
        `  ✓ ${combo.padEnd(40)}  n=${String(r.pooledN).padStart(3)}  R=${r.pooledMeanR.toFixed(2).padStart(5)}  trn=${String(r.trainN).padStart(3)}/${r.trainMeanR.toFixed(2).padStart(5)}  tst=${String(r.testN).padStart(3)}/${r.testMeanR.toFixed(2).padStart(5)}  algos=[${r.algos.join(",")}]`
      );
    }
  }

  console.log(`\n=== Top-${TOP_N_OUTPUT} by score (|pool_R| × pool_n), regardless of pass ===`);
  for (const r of topAll) {
    const combo = `${r.f1}=${r.b1}, ${r.f2}=${r.b2}`;
    const mark = r.passed ? "✓" : r.fail_reason ? "✗" : "?";
    console.log(
      `  ${mark} ${combo.padEnd(40)}  n=${String(r.pooledN).padStart(3)}  R=${r.pooledMeanR.toFixed(2).padStart(5)}  trn=${String(r.trainN).padStart(3)}/${r.trainMeanR.toFixed(2).padStart(5)}  tst=${String(r.testN).padStart(3)}/${r.testMeanR.toFixed(2).padStart(5)}  algos=[${r.algos.join(",")}]${r.passed ? "" : `  fail: ${r.fail_reason}`}`
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/discovery-v1-losers-${stamp}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        mode: "losers",
        locked_design: {
          capital: CAPITAL,
          risk_pct: RISK_PCT,
          chunk_days: CHUNK_DAYS,
          friction: { slippage_bps: FRICTION_SLIPPAGE_BPS, spread_bps: FRICTION_SPREAD_BPS },
          features: FEATURES,
          hard_gates: HARD_GATES,
          split: "per-algo midpoint by trade count",
          aggregation: "pooled across configs and tickers",
          tickers: TICKERS,
        },
        total_trades: allTrades.length,
        total_losers: allTrades.filter((t) => t.r < 0).length,
        pool_mean_r: allTrades.reduce((s, t) => s + t.r, 0) / Math.max(1, allTrades.length),
        survivors: survivors.length,
        survivor_rows: survivors,
        all_ranked_top: topAll,
      },
      null,
      2
    )
  );
  console.log(`\nSaved: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
