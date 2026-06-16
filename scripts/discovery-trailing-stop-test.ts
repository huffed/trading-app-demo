/**
 * Trailing-stop test — analogous to BE-trigger test (#226 follow-on
 * PR #232), but for the OPPOSITE end of the distribution. MFE/MAE ×
 * exit_reason (PR #234) revealed that TP-hit winners frequently run
 * 3-5× past our 3R TP target (MFE p90: bear_short 16.6 ATR, coil_1h
 * 13.7 ATR, fvg_30m 9.9 ATR). A trailing stop could capture more of
 * that winner tail.
 *
 * Asymmetry: BE rescued losses by sacrificing winners (failed). A
 * trailing stop tries to RIDE winners further by accepting that some
 * winners-that-just-tagged-TP will instead exit at a lower R via the
 * trail. The math is different — we're not asking "are losers'
 * favorable excursions bigger than winners' adverse excursions" but
 * "do winners run far enough past TP to make a trail-and-give-back
 * preferable to fixed 3R."
 *
 * ============================================================
 * PRE-REGISTERED DESIGN — LOCKED 2026-06-16
 * ============================================================
 *
 *  Decision      | Pick
 *  --------------|----------------------------------------------
 *  1. Trade source | Same multi-pair (XAU+EUR+GBP+JPY) as BE-test.
 *  2. Algos under test | 5 trend-followers per MFE/MAE finding:
 *                      |   coil_breakout_1h, coil_breakout_4h,
 *                      |   bear_short_4h, breakdown_rider_4h,
 *                      |   fvg_long_30m
 *                      | Excluded: dip_buyer + mean_reversion
 *                      | (compact MFE/MAE — trail won't help).
 *  3. Trail thresholds | {1.0, 1.5, 2.0, 2.5, 3.0, 4.0} ATR
 *                      | Distance the trail SL stays BEHIND the
 *                      | running MFE peak. Smaller = exits sooner
 *                      | (less giveback, more scratches); larger =
 *                      | rides further (more profit per winner,
 *                      | also more retracements take us out near 3R).
 *  4. Trail activation rule | Trail arms only after MFE reaches
 *                           | trail_threshold favorable (otherwise
 *                           | original SL/TP unchanged).
 *  5. Trail exit rule | Once armed: trailing_SL = MFE_peak −
 *                     | trail_threshold (ratchets up only). If a
 *                     | subsequent bar's adverse touches trailing_SL,
 *                     | exit at trailing_SL price. Otherwise actual
 *                     | recorded outcome.
 *  6. R conversion | Pre-registered approximation: 1 ATR = 1 R.
 *                  | This is what swing_anchor 0.10/4 SL typically
 *                  | resolves to under comboC geometry. Imperfect
 *                  | but consistent. Friction on trail exit: -0.05 R.
 *  7. TRAIN/TEST | Per-algo midpoint split (same as BE-test).
 *  8. Ship gate | Net R improvement ≥ 5% in BOTH halves to qualify.
 *
 * Replays each trade against each trail threshold. Pre-registered
 * order of within-bar events: MFE peak updates FIRST (using bar.high
 * for long), THEN adverse check. Slightly optimistic for trail; matches
 * the BE-test's lucky-order convention.
 *
 * Out of scope (would need separate pre-registered tests):
 *   - Trail activation at NON-threshold MFE level (e.g., trail only
 *     after MFE > 3R = "trail past TP")
 *   - Chandelier-style trail (high − K*ATR with K independent of
 *     MFE)
 *   - Structural-trail (trail to swing lows)
 */
import { writeFileSync } from "fs";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import type { MarketStateSeries } from "../src/lib/market-data/portfolio-backtest";
import type { BacktestTrade, PriceBar } from "../src/lib/market-data/types";
import type { AlgorithmRules } from "../src/types/algorithm";
import { loadCorpus, type Corpus } from "./llm-trader-backtest";
import { atr14 } from "../src/lib/market-data/market-state";

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
const TRAIL_EXIT_FRICTION_R = -0.05;

const TRAIL_THRESHOLDS_ATR = [1.0, 1.5, 2.0, 2.5, 3.0, 4.0] as const;
const MIN_IMPROVEMENT_PCT = 5;
const ALGOS_UNDER_TEST = new Set([
  "coil_breakout_1h",
  "coil_breakout_4h",
  "bear_short_4h",
  "breakdown_rider_4h",
  "fvg_long_30m",
]);

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

  return [
    { key: "coil_breakout_4h", timeframe: "4h", rules: cb4, gate: true },
    { key: "coil_breakout_1h", timeframe: "1h", rules: cb1, gate: false },
    { key: "bear_short_4h", timeframe: "4h", rules: bs, gate: true },
    { key: "breakdown_rider_4h", timeframe: "4h", rules: br, gate: true },
    { key: "fvg_long_30m", timeframe: "30m", rules: fv, gate: false },
  ];
}

interface TestTrade {
  algo: string;
  ticker: string;
  side: "long" | "short";
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  actualR: number;
  bars: PriceBar[];
  atrAtEntry: number;
}

function findBarIdx(bars: PriceBar[], targetDate: string): number {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= targetDate) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function chunkedBacktest(
  rules: AlgorithmRules,
  corpus: Corpus,
  series: MarketStateSeries | null,
  ticker: string
): BacktestTrade[] {
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
    const m = runPortfolioBacktest(rules, new Map([[ticker, chunk]]), CAPITAL, [], null, series);
    trades.push(...m.trades);
  }
  trades.sort((a, b) => new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime());
  return trades;
}

/** Simulate trailing-stop replay on a single trade.
 *
 * Pre-registered conversion: 1 ATR favorable ≈ 1 R favorable. Trail
 * exit R = (MFE_peak_atr - trail_threshold_atr) + friction.
 *
 * Within a bar, MFE peak updates FIRST (lucky order for trail), then
 * adverse touch check. */
function simulateTrailingStop(t: TestTrade, trailThresholdAtr: number): number {
  const trailDollars = trailThresholdAtr * t.atrAtEntry;
  let mfePeakPrice = t.entryPrice;
  for (const bar of t.bars) {
    if (t.side === "long") {
      // Update MFE peak (lucky-order convention)
      if (bar.high > mfePeakPrice) mfePeakPrice = bar.high;
      // Trail arms only after MFE has reached trail_threshold favorable
      const favorableAtPeak = mfePeakPrice - t.entryPrice;
      if (favorableAtPeak >= trailDollars) {
        const trailSlPrice = mfePeakPrice - trailDollars;
        // Check if THIS bar's low touched the (newly-updated) trail SL.
        if (bar.low <= trailSlPrice) {
          const trailExitAtr = (trailSlPrice - t.entryPrice) / t.atrAtEntry;
          return trailExitAtr + TRAIL_EXIT_FRICTION_R;
        }
      }
    } else {
      // Short — mirrored
      if (bar.low < mfePeakPrice) mfePeakPrice = bar.low;
      const favorableAtPeak = t.entryPrice - mfePeakPrice;
      if (favorableAtPeak >= trailDollars) {
        const trailSlPrice = mfePeakPrice + trailDollars;
        if (bar.high >= trailSlPrice) {
          const trailExitAtr = (t.entryPrice - trailSlPrice) / t.atrAtEntry;
          return trailExitAtr + TRAIL_EXIT_FRICTION_R;
        }
      }
    }
  }
  // Trail never fired — use actual recorded R
  return t.actualR;
}

async function processOneTicker(ticker: string): Promise<TestTrade[]> {
  const assetClass = assetClassFor(ticker);
  console.log(`\n--- ${ticker} ---`);
  const corpus4h = await loadCorpus("4h", ticker);
  const corpus1h = await loadCorpus("1h", ticker);
  const corpus30m = await loadCorpus("30m", ticker);
  const series: MarketStateSeries = {
    bars4h: new Map([[ticker, corpus4h.bars]]),
    oneHour: new Map([[ticker, corpus1h.bars]]),
    daily: new Map([[ticker, corpus4h.dailyBars]]),
    eurusd4h: corpus4h.eurusd4h,
  };
  const specs = buildSpecs(assetClass);
  const tickerTrades: TestTrade[] = [];
  for (const s of specs) {
    if (!ALGOS_UNDER_TEST.has(s.key)) continue;
    const corpus = s.timeframe === "4h" ? corpus4h : s.timeframe === "1h" ? corpus1h : corpus30m;
    const trades = chunkedBacktest(s.rules, corpus, s.gate ? series : null, ticker);
    let processed = 0, skipped = 0;
    for (const t of trades) {
      const entryIdx = findBarIdx(corpus.bars, t.entry_date);
      const exitIdx = findBarIdx(corpus.bars, t.exit_date);
      if (entryIdx < 0 || exitIdx < 0 || exitIdx <= entryIdx) { skipped++; continue; }
      const atr = atr14(corpus.bars, entryIdx);
      if (atr === null || atr <= 0) { skipped++; continue; }
      const subBars = corpus.bars.slice(entryIdx + 1, exitIdx + 1);
      tickerTrades.push({
        algo: s.key,
        ticker,
        side: t.side,
        entryDate: t.entry_date,
        entryPrice: t.entry_price,
        exitDate: t.exit_date,
        actualR: t.pnl / RISK_DOLLARS,
        bars: subBars,
        atrAtEntry: atr,
      });
      processed++;
    }
    console.log(`  ${s.key.padEnd(22)} ${trades.length} trades (${processed} processed, ${skipped} skipped)`);
  }
  return tickerTrades;
}

interface ResultRow {
  algo: string;
  threshold: number;
  totalN: number;
  baselineTotalR: number;
  trailTotalR: number;
  baselineTrainR: number;
  baselineTestR: number;
  trailTrainR: number;
  trailTestR: number;
  trainImprovementPct: number;
  testImprovementPct: number;
  trailFiredOnWinners: number;
  trailFiredOnLosers: number;
  qualifies: boolean;
}

async function main() {
  console.log("Trailing-stop test — PRE-REGISTERED design");
  console.log(`Tickers: ${TICKERS.join(", ")}`);
  console.log(`Algos under test (trend-followers): ${[...ALGOS_UNDER_TEST].sort().join(", ")}`);
  console.log(`Trail thresholds: ${TRAIL_THRESHOLDS_ATR.join(", ")} ATR`);
  console.log("Locked constants: see file header. Do NOT edit post-results.\n");

  const allTrades: TestTrade[] = [];
  for (const ticker of TICKERS) {
    const tickerTrades = await processOneTicker(ticker);
    allTrades.push(...tickerTrades);
  }

  console.log(`\nTotal trades under test: ${allTrades.length}`);

  const algos = [...new Set(allTrades.map((t) => t.algo))].sort();
  const tradesByAlgo = new Map<string, TestTrade[]>();
  for (const algo of algos) {
    const a = allTrades.filter((t) => t.algo === algo);
    a.sort((x, y) => x.entryDate.localeCompare(y.entryDate));
    tradesByAlgo.set(algo, a);
  }

  const rows: ResultRow[] = [];
  for (const algo of algos) {
    const trades = tradesByAlgo.get(algo)!;
    const mid = Math.floor(trades.length / 2);
    const baselineTotal = trades.reduce((s, t) => s + t.actualR, 0);
    const baselineTrain = trades.slice(0, mid).reduce((s, t) => s + t.actualR, 0);
    const baselineTest = trades.slice(mid).reduce((s, t) => s + t.actualR, 0);

    for (const threshold of TRAIL_THRESHOLDS_ATR) {
      const trailR = trades.map((t) => simulateTrailingStop(t, threshold));
      const trailTotal = trailR.reduce((s, r) => s + r, 0);
      const trailTrainR = trailR.slice(0, mid).reduce((s, r) => s + r, 0);
      const trailTestR = trailR.slice(mid).reduce((s, r) => s + r, 0);

      let firedOnWinners = 0, firedOnLosers = 0;
      for (let i = 0; i < trades.length; i++) {
        // "Fired" = the trail-result differs from the actual (within
        // floating-point tolerance), meaning the trail exit replaced
        // the actual exit.
        if (Math.abs(trailR[i] - trades[i].actualR) > 0.01) {
          if (trades[i].actualR > 0) firedOnWinners++;
          else firedOnLosers++;
        }
      }

      const trainImpPct = baselineTrain !== 0 ? ((trailTrainR - baselineTrain) / Math.abs(baselineTrain)) * 100 : 0;
      const testImpPct = baselineTest !== 0 ? ((trailTestR - baselineTest) / Math.abs(baselineTest)) * 100 : 0;
      const qualifies = trainImpPct >= MIN_IMPROVEMENT_PCT && testImpPct >= MIN_IMPROVEMENT_PCT;
      rows.push({
        algo,
        threshold,
        totalN: trades.length,
        baselineTotalR: baselineTotal,
        trailTotalR: trailTotal,
        baselineTrainR: baselineTrain,
        baselineTestR: baselineTest,
        trailTrainR,
        trailTestR,
        trainImprovementPct: trainImpPct,
        testImprovementPct: testImpPct,
        trailFiredOnWinners: firedOnWinners,
        trailFiredOnLosers: firedOnLosers,
        qualifies,
      });
    }
  }

  console.log("\n=== Per algo × trail threshold ===");
  console.log(
    "  algo                   thr  n     baseR    trailR    trainΔ%   testΔ%  fired W/L  qualifies"
  );
  for (const r of rows) {
    const tag = r.qualifies ? "✓ SHIP" : "·";
    console.log(
      `  ${r.algo.padEnd(22)}  ${r.threshold.toFixed(1)}  ${String(r.totalN).padStart(3)}  ` +
        `${r.baselineTotalR.toFixed(2).padStart(7)}  ${r.trailTotalR.toFixed(2).padStart(7)}  ` +
        `${r.trainImprovementPct.toFixed(1).padStart(7)}%  ${r.testImprovementPct.toFixed(1).padStart(6)}%  ` +
        `${String(r.trailFiredOnWinners).padStart(3)}/${String(r.trailFiredOnLosers).padStart(3)}  ${tag}`
    );
  }

  console.log("\n=== Qualifying (algo, threshold) pairs ===");
  const winners = rows.filter((r) => r.qualifies);
  if (winners.length === 0) {
    console.log("(none qualified)");
  } else {
    for (const r of winners) {
      console.log(
        `  ✓ ${r.algo}  trail@${r.threshold.toFixed(1)} ATR  ` +
          `baseline ${r.baselineTotalR.toFixed(2)}R → trail ${r.trailTotalR.toFixed(2)}R  ` +
          `(TRAIN +${r.trainImprovementPct.toFixed(1)}%, TEST +${r.testImprovementPct.toFixed(1)}%)  ` +
          `fired on ${r.trailFiredOnWinners} winners + ${r.trailFiredOnLosers} losers`
      );
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/discovery-trailing-stop-${stamp}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        locked_design: {
          capital: CAPITAL,
          risk_pct: RISK_PCT,
          friction: { slippage_bps: FRICTION_SLIPPAGE_BPS, spread_bps: FRICTION_SPREAD_BPS },
          trail_exit_friction_r: TRAIL_EXIT_FRICTION_R,
          trail_thresholds_atr: TRAIL_THRESHOLDS_ATR,
          algos_under_test: [...ALGOS_UNDER_TEST].sort(),
          tickers: TICKERS,
          min_improvement_pct: MIN_IMPROVEMENT_PCT,
          r_atr_assumption: "1 ATR = 1 R (pre-registered approximation)",
        },
        total_trades: allTrades.length,
        results: rows,
        qualifying: winners,
      },
      null,
      2
    )
  );
  console.log(`\nSaved: ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
