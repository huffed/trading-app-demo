/**
 * V1.2 — Discovery: symmetric cluster mining with 3-feature combos +
 * ChoCh/OTE features + time-aware split + Bonferroni multiple-testing
 * correction.
 *
 * Closes #229. Builds on V1 (winning trades, PR #223) and V1
 * loser-mining (PR #230). Three methodology gaps from the 2026-06-16
 * discovery-gaps audit are closed here:
 *
 *   1. **3-feature combos** — V1.1 was bivariate (C(11,2)=55). V1.2
 *      adds trivariate (C(11,3)=165) with STRICTER hard gates to keep
 *      curve-fit risk in check. Bivariate retained for comparability.
 *
 *   2. **Symmetric mining** — winners and losers in one run. Winner
 *      gate (pooledR ≥ thresh) and loser gate (pooledR ≤ -thresh) are
 *      both evaluated per cluster; output groups by direction.
 *
 *   3. **Time-aware split** — V1.1's per-algo midpoint clusters early
 *      and late trades by INDEX, mixing time periods across algos.
 *      V1.2 splits by CALENDAR MONTH PARITY: even months → TRAIN,
 *      odd → TEST. Same date range for both halves; reduces clustering
 *      bias from one hot streak skewing a half.
 *
 *   4. **ChoCh + OTE pattern co-occurrence features** — per #224 these
 *      detectors now exist. Each trade is tagged with whether
 *      ChoCh/OTE fired in the trade's direction at the entry bar.
 *      Binary features (yes/no) added to the feature set.
 *
 *   5. **Multiple-testing correction** — Bonferroni-adjusted p-value
 *      reported per surviving cluster (one-sample t against 0).
 *      Doesn't drive the ship decision — that's still the hard-gate
 *      + TRAIN/TEST agreement table — but quantifies the
 *      multiple-testing exposure so the operator can see when a +0.6
 *      meanR is significant after correction and when it isn't.
 *
 * ============================================================
 * PRE-REGISTERED DESIGN — LOCKED 2026-06-16
 * Do NOT edit constants after seeing results.
 * Editing post-hoc invalidates the experiment per
 * feedback_audit_proposals_rigorously_before_presenting +
 * feedback_dont_optimize_on_n1.
 * ============================================================
 *
 *  Decision      | Pick
 *  --------------|----------------------------------------------
 *  1. Features   | 11 features:
 *                |   side, ticker, regime, entry_zone,
 *                |   entry_hour_bucket, mtf, vol, range, dxy,
 *                |   choch_aligned, ote_aligned
 *  2. Corpus     | 8 deployed library configs × 4 tickers
 *                |   (XAU/USD + EUR/USD + GBP/USD + USD/JPY)
 *  3. Combinatorics | Bivariate (C(11,2)=55) AND trivariate
 *                  | (C(11,3)=165). Each cluster tested independently.
 *  4. Bivariate gates | pooledN ≥ 20, halfN ≥ 8 each
 *                    | |pooledR| ≥ 0.4, TRAIN/TEST agree in sign
 *  5. Trivariate gates | STRICTER:
 *                     | pooledN ≥ 30, halfN ≥ 12 each
 *                     | |pooledR| ≥ 0.6
 *                     | TRAIN/TEST |R| ≥ 0.2 each, same sign
 *  6. Split       | Calendar-month parity (even=TRAIN, odd=TEST)
 *  7. Aggregation | Pooled across all algos + tickers
 *  8. Output      | Symmetric: winner clusters AND loser clusters,
 *                |  grouped, ranked by |meanR| × pooledN
 *  9. Significance| Bonferroni-adjusted p (reported, not enforced)
 *  10. Position-in-range| 20-bar window on the ALGO's native TF
 *                      | (matches V1.1 — standardization moved to
 *                      | follow-up to keep V1.2 scope manageable)
 *
 * Friction: realistic (slippage 0.5 bps, spread 0.4 bps) — matches
 * V1.1 + live config.
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
import { detectChoch } from "../src/lib/patterns/choch";
import { detectOte } from "../src/lib/patterns/ote";

// ----- PRE-REGISTERED CONSTANTS (locked) -----
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

// Bivariate gates — match V1.1 winner/loser thresholds for direct
// comparability of bivariate findings.
const BIVAR_GATES = {
  MIN_POOLED_N: 20,
  MIN_HALF_N: 8,
  MIN_ABS_POOLED_R: 0.4,
  MIN_ABS_HALF_R: 0, // each half must just agree in sign
} as const;

// Trivariate gates — stricter to control curve-fit risk on 165 combos
// × many bucket triples.
const TRIVAR_GATES = {
  MIN_POOLED_N: 30,
  MIN_HALF_N: 12,
  MIN_ABS_POOLED_R: 0.6,
  MIN_ABS_HALF_R: 0.2,
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
  "choch_aligned",
  "ote_aligned",
] as const;
type Feature = (typeof FEATURES)[number];

const TOP_N_OUTPUT = 15;

// ----- Algo specs — same 8 as V1.1 -----
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

// ----- Feature extraction -----
function findBarIdx(bars: { date: string }[], targetDate: string): number {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= targetDate) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
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

function bucketize(features: {
  side: "long" | "short";
  ticker: string;
  regime: string;
  positionInRangePct: number | null;
  entryHourUtc: number;
  state: MarketState;
  chochAligned: "yes" | "no" | "n/a";
  oteAligned: "yes" | "no" | "n/a";
}): Record<Feature, string> {
  const entryZone =
    features.positionInRangePct === null
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
    choch_aligned: features.chochAligned,
    ote_aligned: features.oteAligned,
  };
}

interface TaggedTrade {
  algo: string;
  side: "long" | "short";
  pnl: number;
  r: number;
  entryDate: string;
  features: Record<Feature, string>;
  half: "TRAIN" | "TEST";
}

/** Calendar-month parity. UTC month index (0-11). Even=TRAIN, odd=TEST. */
function splitHalf(entryDate: string): "TRAIN" | "TEST" {
  const month = new Date(entryDate).getUTCMonth();
  return month % 2 === 0 ? "TRAIN" : "TEST";
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

    let processed = 0;
    for (const t of trades) {
      const ms4hIdx = lastIdxAtOrBefore(inputs.bars4h, t.entry_date);
      if (ms4hIdx < 0) continue;
      const st = computeMarketState4h(inputs, ms4hIdx);

      const d1Idx = lastIdxAtOrBefore(corpus4h.dailyBars, t.entry_date.slice(0, 10) + " 00:00:00") - 1;
      const regimeRaw = d1Idx >= 7 ? swingRegime(corpus4h.dailyBars, d1Idx) : null;
      const regime = regimeRaw ?? "n/a";

      const tfBars = corpus.bars as { date: string; high: number; low: number; close: number; open: number; volume: number }[];
      const posInRange = positionInRange(tfBars, t.entry_date, t.entry_price);
      const entryHour = new Date(t.entry_date).getUTCHours();

      // ChoCh + OTE co-occurrence at entry bar (algo's native TF).
      // Map trade.side (long/short) to pattern direction (bullish/bearish).
      const entryIdx = findBarIdx(tfBars, t.entry_date);
      const tradeDir = t.side === "long" ? "bullish" : "bearish";
      let chochAligned: "yes" | "no" | "n/a" = "n/a";
      let oteAligned: "yes" | "no" | "n/a" = "n/a";
      if (entryIdx >= 11) {
        const ch = detectChoch(tfBars, entryIdx, 5);
        chochAligned = ch.detected && ch.details?.direction === tradeDir ? "yes" : "no";
        const ot = detectOte(tfBars, entryIdx, 5);
        oteAligned = ot.detected && ot.details?.direction === tradeDir ? "yes" : "no";
      }

      const features = bucketize({
        side: t.side,
        ticker,
        regime,
        positionInRangePct: posInRange,
        entryHourUtc: entryHour,
        state: st,
        chochAligned,
        oteAligned,
      });

      tickerTrades.push({
        algo: s.key,
        side: t.side,
        pnl: t.pnl,
        r: t.pnl / RISK_DOLLARS,
        entryDate: t.entry_date,
        features,
        half: splitHalf(t.entry_date),
      });
      processed++;
    }
    console.log(`  ${s.key.padEnd(22)} ${processed} trades`);
  }

  return tickerTrades;
}

// ----- Bonferroni-adjusted p-value -----
/** One-sample t-test: H0 = mean R is 0. Approximation via normal
 *  CDF for two-tailed p (good enough at n ≥ 20). bonferroni_n is the
 *  number of clusters tested (the correction factor). */
function bonferroniP(mean: number, sd: number, n: number, totalTests: number): number {
  if (n < 2 || sd === 0) return 1;
  const t = mean / (sd / Math.sqrt(n));
  // Two-tailed normal CDF via Abramowitz approx:
  const z = Math.abs(t);
  const p1 = 0.5 * Math.exp(-z * z / 2) / (1.0 + 0.0498673470 * z + 0.0211410061 * z * z);
  const pTwoTailed = 2 * Math.min(p1, 0.5);
  return Math.min(1, pTwoTailed * totalTests);
}

interface Stats { sum: number; sumsq: number; n: number; }

function stdDev(s: Stats): number {
  if (s.n < 2) return 0;
  const mean = s.sum / s.n;
  const variance = s.sumsq / s.n - mean * mean;
  return Math.sqrt(Math.max(0, variance) * s.n / (s.n - 1));
}

interface ClusterRow {
  features: Feature[];
  buckets: string[];
  pooledN: number;
  pooledMeanR: number;
  trainN: number;
  trainMeanR: number;
  testN: number;
  testMeanR: number;
  algos: string[];
  score: number;
  direction: "winner" | "loser" | "neither";
  passed: boolean;
  fail_reason?: string;
  bonferroni_p: number;
}

function evaluateCluster(
  featuresUsed: Feature[],
  buckets: string[],
  pool: Stats,
  train: Stats,
  test: Stats,
  algos: Set<string>,
  gates: { MIN_POOLED_N: number; MIN_HALF_N: number; MIN_ABS_POOLED_R: number; MIN_ABS_HALF_R: number },
  totalTests: number
): ClusterRow {
  const pooledMeanR = pool.n > 0 ? pool.sum / pool.n : 0;
  const trainMeanR = train.n > 0 ? train.sum / train.n : 0;
  const testMeanR = test.n > 0 ? test.sum / test.n : 0;

  let direction: "winner" | "loser" | "neither" = "neither";
  if (pooledMeanR >= gates.MIN_ABS_POOLED_R) direction = "winner";
  else if (pooledMeanR <= -gates.MIN_ABS_POOLED_R) direction = "loser";

  let passed = direction !== "neither";
  let fail_reason: string | undefined;
  if (pool.n < gates.MIN_POOLED_N) { passed = false; fail_reason = `pooledN ${pool.n} < ${gates.MIN_POOLED_N}`; }
  else if (train.n < gates.MIN_HALF_N) { passed = false; fail_reason = `trainN ${train.n} < ${gates.MIN_HALF_N}`; }
  else if (test.n < gates.MIN_HALF_N) { passed = false; fail_reason = `testN ${test.n} < ${gates.MIN_HALF_N}`; }
  else if (direction === "neither") { passed = false; fail_reason = `|pooledMeanR| ${Math.abs(pooledMeanR).toFixed(2)} < ${gates.MIN_ABS_POOLED_R}`; }
  else if (direction === "winner" && (trainMeanR < gates.MIN_ABS_HALF_R || testMeanR < gates.MIN_ABS_HALF_R)) {
    passed = false; fail_reason = `winner halves disagree/under-threshold (TRAIN ${trainMeanR.toFixed(2)}, TEST ${testMeanR.toFixed(2)})`;
  }
  else if (direction === "loser" && (trainMeanR > -gates.MIN_ABS_HALF_R || testMeanR > -gates.MIN_ABS_HALF_R)) {
    passed = false; fail_reason = `loser halves disagree/under-threshold (TRAIN ${trainMeanR.toFixed(2)}, TEST ${testMeanR.toFixed(2)})`;
  }

  const sd = stdDev(pool);
  const bonferroni_p = bonferroniP(pooledMeanR, sd, pool.n, totalTests);

  return {
    features: featuresUsed,
    buckets,
    pooledN: pool.n,
    pooledMeanR,
    trainN: train.n,
    trainMeanR,
    testN: test.n,
    testMeanR,
    algos: [...algos].sort(),
    score: Math.abs(pooledMeanR) * pool.n,
    direction,
    passed,
    fail_reason,
    bonferroni_p,
  };
}

async function main() {
  console.log("V1.2 symmetric cluster mining — PRE-REGISTERED design");
  console.log(`Tickers: ${TICKERS.join(", ")}`);
  console.log("Locked constants: see file header. Do NOT edit post-results.\n");

  const allTrades: TaggedTrade[] = [];
  for (const ticker of TICKERS) {
    const tickerTrades = await processOneTicker(ticker);
    allTrades.push(...tickerTrades);
  }

  console.log(`\nTotal pooled trades: ${allTrades.length}`);
  const winners = allTrades.filter((t) => t.r > 0).length;
  const losers = allTrades.length - winners;
  const trainN = allTrades.filter((t) => t.half === "TRAIN").length;
  const testN = allTrades.length - trainN;
  console.log(`Winners: ${winners}, Losers: ${losers}, TRAIN: ${trainN}, TEST: ${testN}`);
  console.log(`Pool meanR overall: ${(allTrades.reduce((s, t) => s + t.r, 0) / Math.max(1, allTrades.length)).toFixed(3)}`);

  // ----- Bivariate -----
  const bivarRows: ClusterRow[] = [];
  const bivarCount =
    (FEATURES.length * (FEATURES.length - 1)) / 2;

  for (let i = 0; i < FEATURES.length; i++) {
    for (let j = i + 1; j < FEATURES.length; j++) {
      const f1 = FEATURES[i];
      const f2 = FEATURES[j];
      const cells = new Map<
        string,
        { pool: Stats; train: Stats; test: Stats; algos: Set<string> }
      >();
      for (const t of allTrades) {
        const key = `${t.features[f1]}|${t.features[f2]}`;
        let c = cells.get(key);
        if (!c) {
          c = {
            pool: { sum: 0, sumsq: 0, n: 0 },
            train: { sum: 0, sumsq: 0, n: 0 },
            test: { sum: 0, sumsq: 0, n: 0 },
            algos: new Set(),
          };
          cells.set(key, c);
        }
        c.pool.sum += t.r; c.pool.sumsq += t.r * t.r; c.pool.n++;
        c.algos.add(t.algo);
        if (t.half === "TRAIN") { c.train.sum += t.r; c.train.sumsq += t.r * t.r; c.train.n++; }
        else { c.test.sum += t.r; c.test.sumsq += t.r * t.r; c.test.n++; }
      }
      // Total cells across all bivariate pairs — used for Bonferroni.
      // Conservative: use sum of cells across all pairs.
      const totalTests = bivarCount * cells.size;
      for (const [key, c] of cells) {
        const buckets = key.split("|");
        bivarRows.push(
          evaluateCluster([f1, f2], buckets, c.pool, c.train, c.test, c.algos, BIVAR_GATES, totalTests)
        );
      }
    }
  }

  // ----- Trivariate -----
  const trivarRows: ClusterRow[] = [];
  const trivarCount =
    (FEATURES.length * (FEATURES.length - 1) * (FEATURES.length - 2)) / 6;

  for (let i = 0; i < FEATURES.length; i++) {
    for (let j = i + 1; j < FEATURES.length; j++) {
      for (let k = j + 1; k < FEATURES.length; k++) {
        const f1 = FEATURES[i], f2 = FEATURES[j], f3 = FEATURES[k];
        const cells = new Map<
          string,
          { pool: Stats; train: Stats; test: Stats; algos: Set<string> }
        >();
        for (const t of allTrades) {
          const key = `${t.features[f1]}|${t.features[f2]}|${t.features[f3]}`;
          let c = cells.get(key);
          if (!c) {
            c = {
              pool: { sum: 0, sumsq: 0, n: 0 },
              train: { sum: 0, sumsq: 0, n: 0 },
              test: { sum: 0, sumsq: 0, n: 0 },
              algos: new Set(),
            };
            cells.set(key, c);
          }
          c.pool.sum += t.r; c.pool.sumsq += t.r * t.r; c.pool.n++;
          c.algos.add(t.algo);
          if (t.half === "TRAIN") { c.train.sum += t.r; c.train.sumsq += t.r * t.r; c.train.n++; }
          else { c.test.sum += t.r; c.test.sumsq += t.r * t.r; c.test.n++; }
        }
        const totalTests = trivarCount * cells.size;
        for (const [key, c] of cells) {
          const buckets = key.split("|");
          trivarRows.push(
            evaluateCluster([f1, f2, f3], buckets, c.pool, c.train, c.test, c.algos, TRIVAR_GATES, totalTests)
          );
        }
      }
    }
  }

  console.log(`\nBivariate clusters generated: ${bivarRows.length}`);
  console.log(`Trivariate clusters generated: ${trivarRows.length}`);

  const printSurvivors = (label: string, rows: ClusterRow[]) => {
    const winners = rows.filter((r) => r.passed && r.direction === "winner").sort((a, b) => b.score - a.score);
    const losers = rows.filter((r) => r.passed && r.direction === "loser").sort((a, b) => b.score - a.score);
    console.log(`\n=== ${label} — winners (${winners.length}) ===`);
    for (const r of winners) {
      const combo = r.features.map((f, idx) => `${f}=${r.buckets[idx]}`).join(" ∩ ");
      console.log(
        `  ✓ ${combo.padEnd(60)}  n=${String(r.pooledN).padStart(3)}  R=${r.pooledMeanR.toFixed(2).padStart(5)}  trn=${String(r.trainN).padStart(2)}/${r.trainMeanR.toFixed(2).padStart(5)}  tst=${String(r.testN).padStart(2)}/${r.testMeanR.toFixed(2).padStart(5)}  pBonf=${r.bonferroni_p.toFixed(3)}  algos=[${r.algos.join(",")}]`
      );
    }
    console.log(`\n=== ${label} — losers (${losers.length}) ===`);
    for (const r of losers) {
      const combo = r.features.map((f, idx) => `${f}=${r.buckets[idx]}`).join(" ∩ ");
      console.log(
        `  ✗ ${combo.padEnd(60)}  n=${String(r.pooledN).padStart(3)}  R=${r.pooledMeanR.toFixed(2).padStart(5)}  trn=${String(r.trainN).padStart(2)}/${r.trainMeanR.toFixed(2).padStart(5)}  tst=${String(r.testN).padStart(2)}/${r.testMeanR.toFixed(2).padStart(5)}  pBonf=${r.bonferroni_p.toFixed(3)}  algos=[${r.algos.join(",")}]`
      );
    }
  };

  printSurvivors("BIVARIATE", bivarRows);
  printSurvivors("TRIVARIATE", trivarRows);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/discovery-v1-2-${stamp}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        version: "v1.2",
        locked_design: {
          capital: CAPITAL,
          risk_pct: RISK_PCT,
          chunk_days: CHUNK_DAYS,
          friction: { slippage_bps: FRICTION_SLIPPAGE_BPS, spread_bps: FRICTION_SPREAD_BPS },
          features: FEATURES,
          bivar_gates: BIVAR_GATES,
          trivar_gates: TRIVAR_GATES,
          split: "calendar-month parity (even=TRAIN, odd=TEST)",
          aggregation: "pooled across all algos + tickers",
          tickers: TICKERS,
        },
        total_trades: allTrades.length,
        total_winners: winners,
        total_losers: losers,
        train_n: trainN,
        test_n: testN,
        pool_mean_r:
          allTrades.reduce((s, t) => s + t.r, 0) / Math.max(1, allTrades.length),
        bivariate: {
          generated: bivarRows.length,
          winners: bivarRows.filter((r) => r.passed && r.direction === "winner").length,
          losers: bivarRows.filter((r) => r.passed && r.direction === "loser").length,
          rows: bivarRows.filter((r) => r.passed),
          top_unpassed: bivarRows
            .filter((r) => !r.passed)
            .sort((a, b) => b.score - a.score)
            .slice(0, TOP_N_OUTPUT),
        },
        trivariate: {
          generated: trivarRows.length,
          winners: trivarRows.filter((r) => r.passed && r.direction === "winner").length,
          losers: trivarRows.filter((r) => r.passed && r.direction === "loser").length,
          rows: trivarRows.filter((r) => r.passed),
          top_unpassed: trivarRows
            .filter((r) => !r.passed)
            .sort((a, b) => b.score - a.score)
            .slice(0, TOP_N_OUTPUT),
        },
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
