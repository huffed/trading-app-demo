/**
 * Trailing-stop test (engine-mechanic version).
 *
 * Re-runs the trailing-stop test (PR #235) using the ENGINE's actual
 * `updateTrailingState` primitive + `computeSlDistance` instead of
 * the simulated approximation. This validates:
 *
 *   1. The engine's mechanic matches the simulated finding (same
 *      qualifying algos, similar magnitude of improvement)
 *   2. The deploy parameters are precise — engine uses R-units
 *      (initialSlDistance), not the "1 ATR ≈ 1 R" approximation
 *
 * Why it matters: PR #235 showed trail@3.0 ATR roughly doubles total
 * R for coil_breakout_1h + fvg_long_30m + breakdown_rider_4h. But:
 *   - The engine uses R-units, not ATR-units
 *   - For swing_anchor 0.10/4 SL, typical R ≈ 1.2-1.5x ATR
 *   - So "trail@3.0 ATR" in the simulation translates to engine
 *     params something like activate_at_r=2.0-2.2, trail_distance_r=2.0
 *   - We need to TEST the engine values directly to pick precise
 *     deploy params
 *
 * ============================================================
 * PRE-REGISTERED DESIGN — LOCKED 2026-06-16
 * ============================================================
 *
 *  Decision      | Pick
 *  --------------|----------------------------------------------
 *  1. Trade source | Same multi-pair (XAU+EUR+GBP+JPY).
 *  2. Algos under test | Same 5 trend-followers as PR #235:
 *                      |   coil_breakout_1h, coil_breakout_4h,
 *                      |   bear_short_4h, breakdown_rider_4h,
 *                      |   fvg_long_30m
 *  3. activate_at_r grid | {0.5, 1.0, 1.5, 2.0, 2.5, 3.0}
 *  4. trail_distance_r grid | {0.5, 1.0, 1.5, 2.0, 2.5, 3.0}
 *  5. Total combinations | 6 × 6 = 36 per algo × 5 algos = 180
 *  6. SL distance per trade | computeSlDistance() with swing_anchor
 *                           | 0.10/4 — same as engine uses at entry
 *  7. Trailing logic | engine's updateTrailingState() called per bar
 *  8. Exit detection | pickBacktestExitPrice-style check: long SL hit
 *                    | if bar.low <= currentSlPrice; short SL hit if
 *                    | bar.high >= currentSlPrice. Friction -0.05 R.
 *  9. TRAIN/TEST | Per-algo midpoint split (same as PR #235).
 *  10. Ship gate | Net R improvement ≥ 5% in BOTH halves.
 *
 * If the engine-mechanic finding matches PR #235's simulated finding
 * (same algos qualify, similar magnitude), the deploy decision is
 * confident. If it differs, the discrepancy tells us about the
 * simulation's approximation error.
 */
import { writeFileSync } from "fs";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import type { MarketStateSeries } from "../src/lib/market-data/portfolio-backtest";
import type { BacktestTrade, PriceBar } from "../src/lib/market-data/types";
import type { AlgorithmRules } from "../src/types/algorithm";
import { loadCorpus, type Corpus } from "./llm-trader-backtest";
import { computeSlDistance } from "../src/lib/algorithm/structural-sl";
import {
  initTrailingState,
  updateTrailingState,
  type TrailingState,
} from "../src/lib/algorithm/trailing-stop";

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

const ACTIVATE_R_GRID = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0] as const;
const TRAIL_DIST_R_GRID = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0] as const;
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
  initialSlPrice: number;
  initialSlDistance: number;
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

/** Simulate trailing-stop using the engine's updateTrailingState
 *  directly. Returns the R-multiple. */
function simulateEngineTrail(
  t: TestTrade,
  activateAtR: number,
  trailDistanceR: number
): number {
  let state: TrailingState = initTrailingState({
    entryPrice: t.entryPrice,
    initialSlPrice: t.initialSlPrice,
  });
  const trailingStop: AlgorithmRules["trailing_stop"] = {
    enabled: true,
    activate_at_r: activateAtR,
    trail_distance_r: trailDistanceR,
  };
  for (const bar of t.bars) {
    state = updateTrailingState({
      side: t.side,
      entryPrice: t.entryPrice,
      initialSlDistance: t.initialSlDistance,
      currentBar: bar,
      state,
      trailingStop,
    });
    // Check if this bar's adverse touches the (possibly trailed) SL.
    if (t.side === "long") {
      if (bar.low <= state.currentSlPrice) {
        const exitR = (state.currentSlPrice - t.entryPrice) / t.initialSlDistance;
        return exitR + TRAIL_EXIT_FRICTION_R;
      }
    } else {
      if (bar.high >= state.currentSlPrice) {
        const exitR = (t.entryPrice - state.currentSlPrice) / t.initialSlDistance;
        return exitR + TRAIL_EXIT_FRICTION_R;
      }
    }
  }
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
      // Use the ENGINE's exact SL computation
      const slDistance = computeSlDistance(
        s.rules.stop_loss,
        t.side,
        t.entry_price,
        ticker,
        corpus.bars,
        entryIdx
      );
      if (slDistance <= 0) { skipped++; continue; }
      const initialSlPrice = t.side === "long" ? t.entry_price - slDistance : t.entry_price + slDistance;
      tickerTrades.push({
        algo: s.key,
        ticker,
        side: t.side,
        entryDate: t.entry_date,
        entryPrice: t.entry_price,
        exitDate: t.exit_date,
        actualR: t.pnl / RISK_DOLLARS,
        bars: corpus.bars.slice(entryIdx + 1, exitIdx + 1),
        initialSlPrice,
        initialSlDistance: slDistance,
      });
      processed++;
    }
    console.log(`  ${s.key.padEnd(22)} ${trades.length} trades (${processed} processed, ${skipped} skipped)`);
  }
  return tickerTrades;
}

interface ResultRow {
  algo: string;
  activateR: number;
  trailDistR: number;
  totalN: number;
  baselineTotalR: number;
  trailTotalR: number;
  baselineTrainR: number;
  baselineTestR: number;
  trailTrainR: number;
  trailTestR: number;
  trainImprovementPct: number;
  testImprovementPct: number;
  firedOnWinners: number;
  firedOnLosers: number;
  qualifies: boolean;
}

async function main() {
  console.log("Trailing-stop test (ENGINE MECHANIC) — PRE-REGISTERED");
  console.log(`Tickers: ${TICKERS.join(", ")}`);
  console.log(`activate_at_r grid: ${ACTIVATE_R_GRID.join(", ")}`);
  console.log(`trail_distance_r grid: ${TRAIL_DIST_R_GRID.join(", ")}`);
  console.log("Uses engine's updateTrailingState + computeSlDistance directly.\n");

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

    for (const activateR of ACTIVATE_R_GRID) {
      for (const trailDistR of TRAIL_DIST_R_GRID) {
        const trailR = trades.map((t) => simulateEngineTrail(t, activateR, trailDistR));
        const trailTotal = trailR.reduce((s, r) => s + r, 0);
        const trailTrainR = trailR.slice(0, mid).reduce((s, r) => s + r, 0);
        const trailTestR = trailR.slice(mid).reduce((s, r) => s + r, 0);
        let firedOnWinners = 0, firedOnLosers = 0;
        for (let i = 0; i < trades.length; i++) {
          if (Math.abs(trailR[i] - trades[i].actualR) > 0.01) {
            if (trades[i].actualR > 0) firedOnWinners++;
            else firedOnLosers++;
          }
        }
        const trainImpPct = baselineTrain !== 0 ? ((trailTrainR - baselineTrain) / Math.abs(baselineTrain)) * 100 : 0;
        const testImpPct = baselineTest !== 0 ? ((trailTestR - baselineTest) / Math.abs(baselineTest)) * 100 : 0;
        const qualifies = trainImpPct >= MIN_IMPROVEMENT_PCT && testImpPct >= MIN_IMPROVEMENT_PCT;
        rows.push({
          algo, activateR, trailDistR,
          totalN: trades.length,
          baselineTotalR: baselineTotal,
          trailTotalR: trailTotal,
          baselineTrainR: baselineTrain,
          baselineTestR: baselineTest,
          trailTrainR, trailTestR,
          trainImprovementPct: trainImpPct,
          testImprovementPct: testImpPct,
          firedOnWinners, firedOnLosers,
          qualifies,
        });
      }
    }
  }

  console.log("\n=== Top qualifying (algo, activate_at_r, trail_distance_r) pairs by improvement ===");
  const qualifyingRows = rows.filter((r) => r.qualifies);
  qualifyingRows.sort((a, b) => (b.trailTotalR - b.baselineTotalR) - (a.trailTotalR - a.baselineTotalR));
  for (const r of qualifyingRows.slice(0, 20)) {
    console.log(
      `  ✓ ${r.algo.padEnd(22)}  act=${r.activateR.toFixed(1)} tdist=${r.trailDistR.toFixed(1)}  ` +
        `${r.baselineTotalR.toFixed(2).padStart(7)} → ${r.trailTotalR.toFixed(2).padStart(7)}  ` +
        `TRAIN +${r.trainImprovementPct.toFixed(1).padStart(5)}%  TEST +${r.testImprovementPct.toFixed(1).padStart(5)}%  ` +
        `W/L ${r.firedOnWinners}/${r.firedOnLosers}`
    );
  }
  console.log(`\nTotal qualifying pairs across all algos: ${qualifyingRows.length}`);

  console.log("\n=== Best per-algo configuration ===");
  for (const algo of algos) {
    const algoRows = qualifyingRows.filter((r) => r.algo === algo);
    if (algoRows.length === 0) {
      const algoAll = rows.filter((r) => r.algo === algo);
      const best = algoAll.sort((a, b) => (b.trailTotalR - b.baselineTotalR) - (a.trailTotalR - a.baselineTotalR))[0];
      console.log(`  ✗ ${algo.padEnd(22)}  NO QUALIFYING PAIR (best: act=${best.activateR} tdist=${best.trailDistR} TRAIN +${best.trainImprovementPct.toFixed(1)}% TEST +${best.testImprovementPct.toFixed(1)}%)`);
    } else {
      const best = algoRows[0]; // already sorted by improvement
      console.log(
        `  ✓ ${algo.padEnd(22)}  BEST: act=${best.activateR.toFixed(1)} tdist=${best.trailDistR.toFixed(1)}  ` +
          `${best.baselineTotalR.toFixed(2)} → ${best.trailTotalR.toFixed(2)}  ` +
          `(TRAIN +${best.trainImprovementPct.toFixed(1)}%, TEST +${best.testImprovementPct.toFixed(1)}%)  ` +
          `${algoRows.length} of ${ACTIVATE_R_GRID.length * TRAIL_DIST_R_GRID.length} configs qualify`
      );
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/discovery-trailing-stop-engine-${stamp}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        locked_design: {
          capital: CAPITAL, risk_pct: RISK_PCT,
          friction: { slippage_bps: FRICTION_SLIPPAGE_BPS, spread_bps: FRICTION_SPREAD_BPS },
          trail_exit_friction_r: TRAIL_EXIT_FRICTION_R,
          activate_r_grid: ACTIVATE_R_GRID,
          trail_dist_r_grid: TRAIL_DIST_R_GRID,
          algos_under_test: [...ALGOS_UNDER_TEST].sort(),
          tickers: TICKERS,
          min_improvement_pct: MIN_IMPROVEMENT_PCT,
          mechanic_source: "engine's updateTrailingState + computeSlDistance",
        },
        total_trades: allTrades.length,
        results: rows,
        qualifying: qualifyingRows,
      },
      null, 2
    )
  );
  console.log(`\nSaved: ${outPath}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
