/**
 * V1 — Discovery: winning-trade cluster mining.
 *
 * Hypothesis-driven discovery (theory/prompt/ICT → pattern → test) has
 * dominated our research workflow. This script is the orthogonal
 * approach: data-driven discovery. Take all winning trades from the
 * library deployed configs, cluster them by entry features, surface
 * the feature combinations that consistently produce winners.
 *
 * If clusters survive TRAIN/TEST split → candidate setups grounded in
 * empirical winners, not theory. Each surviving cluster becomes a
 * candidate algo (operator-driven deploy, never auto).
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
 *  1. Features   | 9 features from existing cohort schema:
 *                |   side, regime, entry_zone,
 *                |   position_in_range_bucket, entry_hour_bucket,
 *                |   market_state.{mtf, vol, range, dxy}
 *  2. Corpus     | Library WF trade output ONLY (6 deployed configs)
 *                |   — pure comboC geometry, no variant grid noise
 *  3. Combinatorics | Bivariate (2-feature combinations) — C(9,2)=36
 *  4. Hard gates | mean R ≥ 0.4 (pooled)
 *                | n ≥ 20 (pooled)
 *                | n ≥ 8 in TRAIN, n ≥ 8 in TEST
 *                | TRAIN mean R > 0
 *                | TEST mean R > 0
 *  5. Split      | Per-algo midpoint (trade-count split per algo)
 *                | — fixed-date split unusable: 4 of 6 algos have no
 *                |   pre-2024 trades. Per-algo gives every algo fair
 *                |   contribution.
 *  6. Aggregation| Pool trades across all 6 algos for cluster stats
 *  7. Output     | Top-15 clusters ranked by (mean R × n)
 *
 * Friction: realistic (slippage 0.5 bps, spread 0.4 bps) — matches
 * the live config and the comboC validation defaults.
 *
 * Three possible outcomes (all useful):
 *   - No clusters survive → hypothesis-driven was right; data-mining
 *     adds nothing. Confirmation.
 *   - Surviving clusters MATCH existing library algos (e.g.
 *     "side=short, mtf=aligned_LH" ≈ bear_short_4h) → validates the
 *     existing library is well-targeted; no new deployment needed.
 *   - Surviving clusters DON'T match existing algos → genuine alpha
 *     mining hit. Build the rule, smoke-test friction, deploy
 *     paper-only following FVG-Long pattern.
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
const RISK_PCT = 0.6; // per-trade risk, matches live + library
const RISK_DOLLARS = (CAPITAL * RISK_PCT) / 100; // $600
const CHUNK_DAYS = 90; // WF chunk size, workaround for runPortfolioBacktest bug
const DAY_MS = 86_400_000;
const TICKERS = (process.env.TICKERS ?? process.env.TICKER ?? "XAU/USD")
  .split(",")
  .map((s) => s.trim());
const FRICTION_SLIPPAGE_BPS = 0.5;
const FRICTION_SPREAD_BPS = 0.4;

function assetClassFor(ticker: string): "commodity" | "forex" {
  return ticker.startsWith("XAU") || ticker.startsWith("XAG") ? "commodity" : "forex";
}

const HARD_GATES = {
  MIN_POOLED_N: 20,
  MIN_HALF_N: 8,
  MIN_POOLED_MEAN_R: 0.4,
  MIN_TRAIN_MEAN_R: 0.0, // > 0
  MIN_TEST_MEAN_R: 0.0, // > 0
} as const;

// V1.1 (2026-06-16): drop `position_in_range_bucket` (was aliased to
// entry_zone — same field bucketized once). Add `ticker` so multi-pair
// pooling can surface "X works on FX but not gold" patterns directly.
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

// ----- Algo specs (match live deploys) -----
function baseRules(timeframe: "4h" | "1h" | "30m", side: "long" | "short" = "long", assetClass: "commodity" | "forex" = "commodity"): AlgorithmRules {
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

  // Mean-reversion candidates added 2026-06-16 (Tier 1 extension).
  // Pure pattern firing, no bias filter — let the pattern be the entry.
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

// chunkedBacktest moved INSIDE processOneTicker (as localChunked) — needs
// the ticker name for the prices Map, which varies per processed ticker.

// ----- Feature extraction at entry -----
function entryBarIndex(inputs: MarketStateInputs, entryDate: string): number {
  return lastIdxAtOrBefore(inputs.bars4h, entryDate);
}

function positionInRange(corpusBars: { date: string; high: number; low: number; close: number }[], entryDate: string, side: "long" | "short", entryPrice: number): number | null {
  // Find the bar at-or-before entryDate in the algo's TF corpus
  let idx = -1;
  let lo = 0, hi = corpusBars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (corpusBars[mid].date <= entryDate) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
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
}) {
  // Pre-registered bucket definitions
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

  // Patch the chunked backtest to use the right ticker symbol in its Map.
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

    // Tag each trade with features.
    const algoTrades: TaggedTrade[] = [];
    for (const t of trades) {
      const barIdx = entryBarIndex(inputs, t.entry_date);
      if (barIdx < 0) continue;
      const st = computeMarketState4h(inputs, barIdx);

      // Regime: use D1 swingRegime at the day before entry
      const d1Idx = lastIdxAtOrBefore(corpus4h.dailyBars, t.entry_date.slice(0, 10) + " 00:00:00") - 1;
      const regimeRaw = d1Idx >= 7 ? swingRegime(corpus4h.dailyBars, d1Idx) : null;
      const regime = regimeRaw ?? "n/a";

      // Position-in-range from algo TF
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

    // Sort by entryDate (already done) and tag train/test per-(ticker,algo) midpoint
    algoTrades.sort((a, b) => a.entryDate.localeCompare(b.entryDate));
    const mid = Math.floor(algoTrades.length / 2);
    for (let i = 0; i < algoTrades.length; i++) {
      // tagging done downstream via index
      (algoTrades[i] as unknown as { half: "TRAIN" | "TEST" }).half = i < mid ? "TRAIN" : "TEST";
    }
    console.log(`  ${s.key.padEnd(22)} ${algoTrades.length} trades (${mid} train / ${algoTrades.length - mid} test)`);
    tickerTrades.push(...algoTrades);
  }

  return tickerTrades;
}

async function main() {
  console.log("V1 winning-trade cluster mining — PRE-REGISTERED design");
  console.log(`Tickers: ${TICKERS.join(", ")}`);
  console.log("Locked constants: see file header. Do NOT edit post-results.\n");

  const allTrades: TaggedTrade[] = [];
  for (const ticker of TICKERS) {
    const tickerTrades = await processOneTicker(ticker);
    allTrades.push(...tickerTrades);
  }

  console.log(`\nTotal pooled trades: ${allTrades.length}`);
  console.log(`Total winners (r>0): ${allTrades.filter((t) => t.r > 0).length}`);
  console.log(`Pool meanR overall: ${(allTrades.reduce((s, t) => s + t.r, 0) / allTrades.length).toFixed(3)}`);

  // ----- Bivariate cluster analysis -----
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
    score: number;
    passed: boolean;
    fail_reason?: string;
  }
  const rows: ClusterRow[] = [];

  for (let i = 0; i < FEATURES.length; i++) {
    for (let j = i + 1; j < FEATURES.length; j++) {
      const f1 = FEATURES[i];
      const f2 = FEATURES[j];
      // V1.1: aliased feature removed from FEATURES — no skip needed.
      const cells = new Map<string, { pool: Stats; train: Stats; test: Stats; algos: Set<string> }>();
      for (const t of allTrades) {
        const half = (t as unknown as { half: "TRAIN" | "TEST" }).half;
        const key = `${t.features[f1]}|${t.features[f2]}`;
        let c = cells.get(key);
        if (!c) {
          c = { pool: { sum: 0, n: 0 }, train: { sum: 0, n: 0 }, test: { sum: 0, n: 0 }, algos: new Set() };
          cells.set(key, c);
        }
        c.pool.sum += t.r; c.pool.n++;
        c.algos.add(t.algo);
        if (half === "TRAIN") { c.train.sum += t.r; c.train.n++; }
        else { c.test.sum += t.r; c.test.n++; }
      }
      for (const [key, c] of cells) {
        const [b1, b2] = key.split("|");
        const pooledMeanR = c.pool.n > 0 ? c.pool.sum / c.pool.n : 0;
        const trainMeanR = c.train.n > 0 ? c.train.sum / c.train.n : 0;
        const testMeanR = c.test.n > 0 ? c.test.sum / c.test.n : 0;
        let passed = true;
        let fail_reason: string | undefined;
        if (c.pool.n < HARD_GATES.MIN_POOLED_N) { passed = false; fail_reason = `pooledN ${c.pool.n} < ${HARD_GATES.MIN_POOLED_N}`; }
        else if (c.train.n < HARD_GATES.MIN_HALF_N) { passed = false; fail_reason = `trainN ${c.train.n} < ${HARD_GATES.MIN_HALF_N}`; }
        else if (c.test.n < HARD_GATES.MIN_HALF_N) { passed = false; fail_reason = `testN ${c.test.n} < ${HARD_GATES.MIN_HALF_N}`; }
        else if (pooledMeanR < HARD_GATES.MIN_POOLED_MEAN_R) { passed = false; fail_reason = `pooledMeanR ${pooledMeanR.toFixed(2)} < ${HARD_GATES.MIN_POOLED_MEAN_R}`; }
        else if (trainMeanR <= HARD_GATES.MIN_TRAIN_MEAN_R) { passed = false; fail_reason = `trainMeanR ${trainMeanR.toFixed(2)} ≤ ${HARD_GATES.MIN_TRAIN_MEAN_R}`; }
        else if (testMeanR <= HARD_GATES.MIN_TEST_MEAN_R) { passed = false; fail_reason = `testMeanR ${testMeanR.toFixed(2)} ≤ ${HARD_GATES.MIN_TEST_MEAN_R}`; }
        rows.push({
          f1, f2, b1, b2,
          pooledN: c.pool.n, pooledMeanR,
          trainN: c.train.n, trainMeanR,
          testN: c.test.n, testMeanR,
          algos: [...c.algos].sort(),
          score: pooledMeanR * c.pool.n,
          passed,
          fail_reason,
        });
      }
    }
  }

  // Report all surviving clusters; also top-15 by score regardless of survival for context
  const survivors = rows.filter((r) => r.passed).sort((a, b) => b.score - a.score);
  const allRanked = rows.slice().sort((a, b) => b.score - a.score);
  const topAll = allRanked.slice(0, TOP_N_OUTPUT);

  console.log(`\n=== Surviving clusters (passed all hard gates): ${survivors.length} ===`);
  if (survivors.length === 0) {
    console.log("(none — hypothesis-driven discovery may already capture available patterns)");
  } else {
    console.log("    " + ["feature_combo", "pool_n", "pool_R", "trn_n", "trn_R", "tst_n", "tst_R", "algos"].map((s) => s.padEnd(s.length === 13 ? 32 : 7)).join(" "));
    for (const r of survivors) {
      const combo = `${r.f1}=${r.b1}, ${r.f2}=${r.b2}`;
      console.log(
        `  ✓ ${combo.padEnd(40)}  n=${String(r.pooledN).padStart(3)}  R=${r.pooledMeanR.toFixed(2).padStart(5)}  trn=${String(r.trainN).padStart(2)}/${r.trainMeanR.toFixed(2).padStart(5)}  tst=${String(r.testN).padStart(2)}/${r.testMeanR.toFixed(2).padStart(5)}  algos=[${r.algos.join(",")}]`
      );
    }
  }

  console.log(`\n=== Top-${TOP_N_OUTPUT} by score (pool_R × pool_n), regardless of pass ===`);
  for (const r of topAll) {
    const combo = `${r.f1}=${r.b1}, ${r.f2}=${r.b2}`;
    const mark = r.passed ? "✓" : r.fail_reason ? "✗" : "?";
    console.log(
      `  ${mark} ${combo.padEnd(40)}  n=${String(r.pooledN).padStart(3)}  R=${r.pooledMeanR.toFixed(2).padStart(5)}  trn=${String(r.trainN).padStart(2)}/${r.trainMeanR.toFixed(2).padStart(5)}  tst=${String(r.testN).padStart(2)}/${r.testMeanR.toFixed(2).padStart(5)}  algos=[${r.algos.join(",")}]${r.passed ? "" : `  fail: ${r.fail_reason}`}`
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/discovery-v1-${stamp}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        locked_design: {
          capital: CAPITAL,
          risk_pct: RISK_PCT,
          chunk_days: CHUNK_DAYS,
          friction: { slippage_bps: FRICTION_SLIPPAGE_BPS, spread_bps: FRICTION_SPREAD_BPS },
          features: FEATURES,
          hard_gates: HARD_GATES,
          split: "per-algo midpoint by trade count",
          aggregation: "pooled across 6 deployed configs",
          algos: [...new Set(allTrades.map((t) => t.algo))].sort(),
          tickers: TICKERS,
        },
        total_trades: allTrades.length,
        total_winners: allTrades.filter((t) => t.r > 0).length,
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

main().catch((e) => { console.error(e); process.exit(1); });
