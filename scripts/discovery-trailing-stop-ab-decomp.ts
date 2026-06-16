/**
 * Trailing-stop A/B decomposition.
 *
 * Per-trade side-by-side of PR #235's simulation mechanic vs the
 * engine's bar-by-bar mechanic at the EXACT headline config:
 *   activate_at = trail_distance = 3.0 ATR (single-knob in sim).
 *
 * Goal: figure out which of the three suspects explains why the
 * simulation said "+100% R" while the engine says 0 qualifying:
 *
 *   1. Same-bar trail-then-stop (engine kills on the same bar that
 *      sets the new SL via the bar's adverse extreme)
 *   2. R ≠ ATR (simulation exit R divides by atrAtEntry, but baseline
 *      actualR = pnl / RISK_DOLLARS — units mismatch)
 *   3. Sample / overfit (independent of mechanic)
 *
 * Algo: coil_breakout_1h (PR #235's headline). Multi-pair pooled.
 */
import { writeFileSync } from "fs";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import type { MarketStateSeries } from "../src/lib/market-data/portfolio-backtest";
import type { BacktestTrade, PriceBar } from "../src/lib/market-data/types";
import type { AlgorithmRules } from "../src/types/algorithm";
import { loadCorpus, type Corpus } from "./llm-trader-backtest";
import { computeSlDistance } from "../src/lib/algorithm/structural-sl";
import { atr14 } from "../src/lib/market-data/market-state";
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
const TICKERS = ["XAU/USD", "EUR/USD", "GBP/USD", "USD/JPY"];
const FRICTION_SLIPPAGE_BPS = 0.5;
const FRICTION_SPREAD_BPS = 0.4;
const TRAIL_EXIT_FRICTION_R = -0.05;

// Headline config from PR #235.
const ACTIVATE_ATR = 3.0;
const TRAIL_DISTANCE_ATR = 3.0;

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
  initialSlDistance: number; // engine's actual 1R, in price units
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
  series: MarketStateSeries,
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
    const m = runPortfolioBacktest(
      rules,
      new Map([[ticker, chunk]]),
      CAPITAL,
      [],
      series.eurusd4h ?? null,
      series
    );
    trades.push(...m.trades);
  }
  trades.sort((a, b) => new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime());
  return trades;
}

/** SIMULATION mechanic (verbatim from discovery-trailing-stop-test.ts).
 *  Single-knob: activate threshold == trail distance == trailThresholdAtr.
 *  Exit R is computed in ATR-units (divide by atrAtEntry). */
function simulateExitR(t: TestTrade, trailThresholdAtr: number):
  { exitR: number; firedBarIdx: number | null; trailSlPrice: number | null } {
  const trailDollars = trailThresholdAtr * t.atrAtEntry;
  let mfePeakPrice = t.entryPrice;
  for (let i = 0; i < t.bars.length; i++) {
    const bar = t.bars[i];
    if (t.side === "long") {
      if (bar.high > mfePeakPrice) mfePeakPrice = bar.high;
      const favorableAtPeak = mfePeakPrice - t.entryPrice;
      if (favorableAtPeak >= trailDollars) {
        const trailSlPrice = mfePeakPrice - trailDollars;
        if (bar.low <= trailSlPrice) {
          const exitR = (trailSlPrice - t.entryPrice) / t.atrAtEntry + TRAIL_EXIT_FRICTION_R;
          return { exitR, firedBarIdx: i, trailSlPrice };
        }
      }
    } else {
      if (bar.low < mfePeakPrice) mfePeakPrice = bar.low;
      const favorableAtPeak = t.entryPrice - mfePeakPrice;
      if (favorableAtPeak >= trailDollars) {
        const trailSlPrice = mfePeakPrice + trailDollars;
        if (bar.high >= trailSlPrice) {
          const exitR = (t.entryPrice - trailSlPrice) / t.atrAtEntry + TRAIL_EXIT_FRICTION_R;
          return { exitR, firedBarIdx: i, trailSlPrice };
        }
      }
    }
  }
  return { exitR: t.actualR, firedBarIdx: null, trailSlPrice: null };
}

/** ENGINE mechanic — calls the actual updateTrailingState primitive
 *  with the ATR-variant fields, exit R in real-R-units (divide by
 *  initialSlDistance, not ATR). */
function engineExitR(t: TestTrade, activateAtr: number, trailDistanceAtr: number):
  { exitR: number; firedBarIdx: number | null; trailSlPrice: number | null } {
  const initialSlPrice =
    t.side === "long" ? t.entryPrice - t.initialSlDistance : t.entryPrice + t.initialSlDistance;
  let state: TrailingState = initTrailingState({
    entryPrice: t.entryPrice,
    initialSlPrice,
    initialAtr: t.atrAtEntry,
  });
  const trailingStop: AlgorithmRules["trailing_stop"] = {
    enabled: true,
    activate_at_atr: activateAtr,
    trail_distance_atr: trailDistanceAtr,
  };
  for (let i = 0; i < t.bars.length; i++) {
    const bar = t.bars[i];
    state = updateTrailingState({
      side: t.side,
      entryPrice: t.entryPrice,
      initialSlDistance: t.initialSlDistance,
      currentBar: bar,
      state,
      trailingStop,
    });
    if (t.side === "long") {
      if (bar.low <= state.currentSlPrice) {
        const exitR =
          (state.currentSlPrice - t.entryPrice) / t.initialSlDistance + TRAIL_EXIT_FRICTION_R;
        return { exitR, firedBarIdx: i, trailSlPrice: state.currentSlPrice };
      }
    } else {
      if (bar.high >= state.currentSlPrice) {
        const exitR =
          (t.entryPrice - state.currentSlPrice) / t.initialSlDistance + TRAIL_EXIT_FRICTION_R;
        return { exitR, firedBarIdx: i, trailSlPrice: state.currentSlPrice };
      }
    }
  }
  return { exitR: t.actualR, firedBarIdx: null, trailSlPrice: null };
}

/** CONTROL — same-mechanic engine logic but exit R reported in
 *  ATR-units (divide by atrAtEntry instead of initialSlDistance).
 *  Isolates the units-mismatch culprit. */
function engineExitR_AtrUnits(t: TestTrade, activateAtr: number, trailDistanceAtr: number):
  { exitR: number } {
  const initialSlPrice =
    t.side === "long" ? t.entryPrice - t.initialSlDistance : t.entryPrice + t.initialSlDistance;
  let state: TrailingState = initTrailingState({
    entryPrice: t.entryPrice,
    initialSlPrice,
    initialAtr: t.atrAtEntry,
  });
  const trailingStop: AlgorithmRules["trailing_stop"] = {
    enabled: true,
    activate_at_atr: activateAtr,
    trail_distance_atr: trailDistanceAtr,
  };
  for (let i = 0; i < t.bars.length; i++) {
    const bar = t.bars[i];
    state = updateTrailingState({
      side: t.side,
      entryPrice: t.entryPrice,
      initialSlDistance: t.initialSlDistance,
      currentBar: bar,
      state,
      trailingStop,
    });
    if (t.side === "long") {
      if (bar.low <= state.currentSlPrice) {
        const exitR =
          (state.currentSlPrice - t.entryPrice) / t.atrAtEntry + TRAIL_EXIT_FRICTION_R;
        return { exitR };
      }
    } else {
      if (bar.high >= state.currentSlPrice) {
        const exitR =
          (t.entryPrice - state.currentSlPrice) / t.atrAtEntry + TRAIL_EXIT_FRICTION_R;
        return { exitR };
      }
    }
  }
  return { exitR: t.actualR };
}

function buildRules(assetClass: "commodity" | "forex"): AlgorithmRules {
  return {
    entry_conditions: [
      { type: "pattern", pattern: "bos", direction: "bullish", lookback: 5, timeframe: "1h" },
    ],
    exit_conditions: [],
    stop_loss: { type: "swing_anchor", value: 0.1, lookback: 4 },
    take_profit: { type: "rr_multiple", value: 3 },
    position_sizing: { type: "risk_per_trade", value: RISK_PCT },
    max_positions: 1,
    leverage: 9,
    timeframe: "1h",
    asset_class: assetClass,
    side: "long",
    stagnant_exit: { enabled: true },
    prop_firm: { slippage_bps: FRICTION_SLIPPAGE_BPS, spread_bps: FRICTION_SPREAD_BPS },
  } as unknown as AlgorithmRules;
}

function assetClassFor(t: string): "commodity" | "forex" {
  return t === "XAU/USD" ? "commodity" : "forex";
}

async function loadAllTrades(): Promise<TestTrade[]> {
  const all: TestTrade[] = [];
  for (const ticker of TICKERS) {
    const assetClass = assetClassFor(ticker);
    const rules = buildRules(assetClass);
    console.log(`\n--- ${ticker} ---`);
    const corpus = await loadCorpus("1h", ticker);
    const series: MarketStateSeries = {
      bars4h: new Map(),
      oneHour: new Map([[ticker, corpus.bars]]),
      daily: new Map([[ticker, corpus.dailyBars]]),
      eurusd4h: corpus.eurusd4h,
    };
    const trades = chunkedBacktest(rules, corpus, series, ticker);
    let kept = 0, skipped = 0;
    for (const t of trades) {
      const entryIdx = findBarIdx(corpus.bars, t.entry_date);
      const exitIdx = findBarIdx(corpus.bars, t.exit_date);
      if (entryIdx < 0 || exitIdx < 0 || exitIdx <= entryIdx) { skipped++; continue; }
      const atr = atr14(corpus.bars, entryIdx);
      if (atr == null || atr <= 0) { skipped++; continue; }
      const slDistance = computeSlDistance(
        rules.stop_loss as AlgorithmRules["stop_loss"],
        t.side, t.entry_price, ticker, corpus.bars, entryIdx
      );
      if (slDistance <= 0) { skipped++; continue; }
      all.push({
        algo: "coil_breakout_1h",
        ticker,
        side: t.side,
        entryDate: t.entry_date,
        entryPrice: t.entry_price,
        exitDate: t.exit_date,
        actualR: t.pnl / RISK_DOLLARS,
        bars: corpus.bars.slice(entryIdx + 1, exitIdx + 1),
        atrAtEntry: atr,
        initialSlDistance: slDistance,
      });
      kept++;
    }
    console.log(`  kept=${kept}, skipped=${skipped}`);
  }
  return all;
}

async function main() {
  console.log("Trailing-stop A/B decomposition (coil_breakout_1h, multi-pair pooled)");
  console.log(`Config: activate=${ACTIVATE_ATR} ATR, trail_distance=${TRAIL_DISTANCE_ATR} ATR`);
  console.log("Sim uses ATR-units throughout; engine uses real-R-units (initialSlDistance).\n");

  const trades = await loadAllTrades();
  console.log(`\nTotal trades pooled: ${trades.length}`);

  // Ratio of SL distance to ATR (the "1 ATR ≈ 1 R" approximation error).
  const slToAtrRatios = trades.map((t) => t.initialSlDistance / t.atrAtEntry);
  const slToAtrMean = slToAtrRatios.reduce((s, x) => s + x, 0) / slToAtrRatios.length;
  const slToAtrMedian = [...slToAtrRatios].sort((a, b) => a - b)[Math.floor(slToAtrRatios.length / 2)];
  console.log(
    `SL/ATR ratio: mean=${slToAtrMean.toFixed(3)}, median=${slToAtrMedian.toFixed(3)} ` +
      `(simulation assumed 1.000 — every captured R inflated by this factor)`
  );

  // 4-way decomposition.
  let baselineR = 0, simR = 0, engineR = 0, engineAtrR = 0;
  let agreeFire = 0, simOnlyFire = 0, engineOnlyFire = 0, neitherFire = 0;
  let simEarlier = 0, engineEarlier = 0, sameBar = 0;
  let simBaseline_pos = 0, simBaseline_neg = 0;
  let engineBaseline_pos = 0, engineBaseline_neg = 0;

  const rowsLog: Array<{
    ticker: string; entryDate: string; actualR: number;
    simExitR: number; engineExitR: number; engineAtrExitR: number;
    simFiredBar: number | null; engineFiredBar: number | null;
    deltaSimVsActual: number; deltaEngineVsActual: number;
  }> = [];

  for (const t of trades) {
    baselineR += t.actualR;
    const sim = simulateExitR(t, ACTIVATE_ATR);
    const eng = engineExitR(t, ACTIVATE_ATR, TRAIL_DISTANCE_ATR);
    const engAtr = engineExitR_AtrUnits(t, ACTIVATE_ATR, TRAIL_DISTANCE_ATR);
    simR += sim.exitR;
    engineR += eng.exitR;
    engineAtrR += engAtr.exitR;

    if (sim.firedBarIdx !== null && eng.firedBarIdx !== null) {
      agreeFire++;
      if (sim.firedBarIdx < eng.firedBarIdx) simEarlier++;
      else if (sim.firedBarIdx > eng.firedBarIdx) engineEarlier++;
      else sameBar++;
    } else if (sim.firedBarIdx !== null) simOnlyFire++;
    else if (eng.firedBarIdx !== null) engineOnlyFire++;
    else neitherFire++;

    const dSim = sim.exitR - t.actualR;
    const dEng = eng.exitR - t.actualR;
    if (dSim >= 0) simBaseline_pos++; else simBaseline_neg++;
    if (dEng >= 0) engineBaseline_pos++; else engineBaseline_neg++;

    rowsLog.push({
      ticker: t.ticker, entryDate: t.entryDate, actualR: t.actualR,
      simExitR: sim.exitR, engineExitR: eng.exitR, engineAtrExitR: engAtr.exitR,
      simFiredBar: sim.firedBarIdx, engineFiredBar: eng.firedBarIdx,
      deltaSimVsActual: dSim, deltaEngineVsActual: dEng,
    });
  }

  console.log("\n=== Totals ===");
  console.log(`Baseline (no trail)         total R: ${baselineR.toFixed(2)}`);
  console.log(`Simulation mechanic         total R: ${simR.toFixed(2)}   (Δ ${(simR - baselineR).toFixed(2)})`);
  console.log(`Engine mechanic, R-units    total R: ${engineR.toFixed(2)}   (Δ ${(engineR - baselineR).toFixed(2)})`);
  console.log(`Engine mechanic, ATR-units  total R: ${engineAtrR.toFixed(2)}   (Δ ${(engineAtrR - baselineR).toFixed(2)})`);

  const simGain = simR - baselineR;
  const engGain = engineR - baselineR;
  const engAtrGain = engineAtrR - baselineR;
  console.log("\n=== Decomposition of sim → engine gap ===");
  console.log(`Sim gain over baseline:               ${simGain.toFixed(2)} R`);
  console.log(`Engine ATR-units gain over baseline:  ${engAtrGain.toFixed(2)} R  (sim minus this = mechanic-only gap = ${(simGain - engAtrGain).toFixed(2)})`);
  console.log(`Engine R-units gain over baseline:    ${engGain.toFixed(2)} R  (engine ATR minus this = units-only gap = ${(engAtrGain - engGain).toFixed(2)})`);
  const mechanicGap = simGain - engAtrGain;
  const unitsGap = engAtrGain - engGain;
  const totalGap = simGain - engGain;
  console.log("");
  console.log(`Total sim→engine gap:                 ${totalGap.toFixed(2)} R`);
  console.log(`  attributable to MECHANIC:           ${mechanicGap.toFixed(2)} R  (${((mechanicGap / totalGap) * 100).toFixed(1)}%)`);
  console.log(`  attributable to UNITS:              ${unitsGap.toFixed(2)} R  (${((unitsGap / totalGap) * 100).toFixed(1)}%)`);

  console.log("\n=== Fire timing ===");
  console.log(`Both fired (same trade):     ${agreeFire}`);
  console.log(`  sim fired earlier:         ${simEarlier}`);
  console.log(`  engine fired earlier:      ${engineEarlier}`);
  console.log(`  same bar:                  ${sameBar}`);
  console.log(`Sim only fired:              ${simOnlyFire}`);
  console.log(`Engine only fired:           ${engineOnlyFire}`);
  console.log(`Neither fired:               ${neitherFire}`);

  console.log("\n=== Per-trade Δ-vs-baseline sign ===");
  console.log(`Sim improved over actual:    ${simBaseline_pos}    Sim worse: ${simBaseline_neg}`);
  console.log(`Engine improved over actual: ${engineBaseline_pos}    Engine worse: ${engineBaseline_neg}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/discovery-trailing-stop-ab-${stamp}.json`;
  writeFileSync(outPath, JSON.stringify({
    config: { ACTIVATE_ATR, TRAIL_DISTANCE_ATR, RISK_DOLLARS },
    sl_to_atr: { mean: slToAtrMean, median: slToAtrMedian },
    totals: { baselineR, simR, engineR, engineAtrR },
    decomposition: { mechanicGap, unitsGap, totalGap },
    fire_timing: { agreeFire, simEarlier, engineEarlier, sameBar, simOnlyFire, engineOnlyFire, neitherFire },
    rows: rowsLog,
  }, null, 2));
  console.log(`\nSaved: ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
