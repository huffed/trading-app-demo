/**
 * BE-trigger test — per-algo retest of break-even-stop rescue mechanic
 * against the recorded multi-pair trade corpus (issue #226 follow-on).
 *
 * Motivation: MFE/MAE analysis surfaced that trend-following algos'
 * losers reach 1.6-2.7 ATR favorable BEFORE reversing into a loss. A
 * BE-trigger at threshold X ATR could rescue some of those losses.
 * BUT the aggregate `feedback_structural_sl_tp_finding` said
 * "BE/partials SUBTRACT R" across all algos. This test asks whether
 * the aggregate finding holds PER ALGO for the trend-followers
 * specifically.
 *
 * ============================================================
 * PRE-REGISTERED DESIGN — LOCKED 2026-06-16
 * ============================================================
 *
 *  Decision      | Pick
 *  --------------|----------------------------------------------
 *  1. Trade source | Same multi-pair backtest corpus (XAU+EUR+GBP+JPY)
 *                  | as MFE/MAE analysis. Same library + mean_reversion
 *                  | configs.
 *  2. Algos under test | The 5 TREND-FOLLOWING algos identified by
 *                      | MFE/MAE: coil_breakout_1h, coil_breakout_4h,
 *                      | bear_short_4h, breakdown_rider_4h, fvg_long_30m
 *                      | Excluded by MFE/MAE: dip_buyer, mean_reversion_*
 *                      | (their LOSS MFE < 1.0 ATR; BE-trigger would
 *                      | scratch winners without saving losses)
 *  3. BE thresholds | {0.5, 1.0, 1.5, 2.0, 2.5, 3.0} ATR favorable
 *  4. Replay rule | For each trade, walk bars after entry. Track
 *                 | running MFE. When MFE first reaches X ATR
 *                 | favorable: BE armed. After BE armed, if any
 *                 | subsequent bar's adverse touches entry_price:
 *                 | exit at entry (R = -0.05 for friction cost).
 *                 | Otherwise use actual recorded outcome.
 *  5. TRAIN/TEST | Per-algo midpoint split (same as V1.x discipline).
 *  6. Hard ship  | Net R improvement ≥ 5% in BOTH halves for an
 *                | (algo, threshold) pair to qualify as candidate.
 *  7. Output     | Per-algo × per-threshold table: baseline R · BE R
 *                | (TRAIN/TEST/total) · delta · scratched winners ·
 *                | rescued losses · qualifies for ship
 *
 * Friction cost at BE exit: R = -0.05 (conservative estimate; round-
 * trip 1.8 bps spread+slippage on $100k notional ≈ $18 / $600 risk).
 *
 * Out of scope: testing trailing stops, partial TP, BE at price
 * (instead of ATR). Each would need its own pre-registered test.
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
const BE_EXIT_R = -0.05; // friction cost on BE-rescue exit (pre-registered)

const BE_THRESHOLDS_ATR = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0] as const;
const MIN_IMPROVEMENT_PCT = 5; // ≥5% net R improvement in BOTH halves required
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
  const db = baseRules("4h", "long", assetClass);
  db.entry_conditions = [
    { type: "pattern", pattern: "liquidity_sweep", direction: "bullish", lookback: 5, timeframe: "4h" },
    { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "4h" },
  ];
  db.market_state_gate = { mode: "block", states: { mtf: ["fast_div_bull"], dxy: ["usd_down"] }, on_unreadable: "allow" };
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
    { key: "dip_buyer_4h", timeframe: "4h", rules: db, gate: true },
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
  exitPrice: number;
  pnl: number;
  actualR: number;
  bars: PriceBar[]; // bars between entry and exit (inclusive of entry+1 to exit)
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

/** For a given trade with bars after entry, simulate the BE-trigger at
 *  threshold X ATR. Returns the would-be R-multiple. */
function simulateBeRescue(t: TestTrade, beThresholdAtr: number): number {
  const beTriggerDollars = beThresholdAtr * t.atrAtEntry;
  let beArmed = false;
  for (const bar of t.bars) {
    if (t.side === "long") {
      // Check if BE arms on this bar
      if (!beArmed) {
        const favorableThisBar = bar.high - t.entryPrice;
        if (favorableThisBar >= beTriggerDollars) {
          beArmed = true;
          // Within the same bar: did price also touch entry? If yes,
          // we assume the favorable came BEFORE the adverse (lucky
          // order); BE arms but doesn't trigger this bar. Conservative
          // alt: assume worst-case order and trigger BE on same bar.
          // We use the lucky order — favorable hit first, BE armed,
          // next adverse touch in a subsequent bar triggers exit.
          continue;
        }
      } else {
        // BE armed: check if this bar's low touched entry → BE stop hits
        if (bar.low <= t.entryPrice) {
          return BE_EXIT_R;
        }
      }
    } else {
      // short
      if (!beArmed) {
        const favorableThisBar = t.entryPrice - bar.low;
        if (favorableThisBar >= beTriggerDollars) {
          beArmed = true;
          continue;
        }
      } else {
        if (bar.high >= t.entryPrice) {
          return BE_EXIT_R;
        }
      }
    }
  }
  // BE never triggered OR triggered but never came back to entry — use
  // the actual recorded R.
  return t.actualR;
}

async function processOneTicker(ticker: string): Promise<TestTrade[]> {
  const assetClass = assetClassFor(ticker);
  console.log(`\n--- Loading corpora for ${ticker} ---`);
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
      // Bars after entry up to and including the exit bar
      const subBars = corpus.bars.slice(entryIdx + 1, exitIdx + 1);
      tickerTrades.push({
        algo: s.key,
        ticker,
        side: t.side,
        entryDate: t.entry_date,
        entryPrice: t.entry_price,
        exitDate: t.exit_date,
        exitPrice: t.exit_price,
        pnl: t.pnl,
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
  beTotalR: number;
  beTrainR: number;
  beTestR: number;
  baselineTrainR: number;
  baselineTestR: number;
  trainImprovementPct: number;
  testImprovementPct: number;
  scratchedWinners: number; // winners that became BE = 0
  rescuedLosses: number; // losses that became BE = 0
  qualifies: boolean;
}

async function main() {
  console.log("BE-trigger test — PRE-REGISTERED design");
  console.log(`Tickers: ${TICKERS.join(", ")}`);
  console.log(`Algos under test (per MFE/MAE): ${[...ALGOS_UNDER_TEST].sort().join(", ")}`);
  console.log(`BE thresholds: ${BE_THRESHOLDS_ATR.join(", ")} ATR`);
  console.log("Locked constants: see file header. Do NOT edit post-results.\n");

  const allTrades: TestTrade[] = [];
  for (const ticker of TICKERS) {
    const tickerTrades = await processOneTicker(ticker);
    allTrades.push(...tickerTrades);
  }

  console.log(`\nTotal trades under test: ${allTrades.length}`);

  // Group trades by algo, then sort by entry date for per-algo midpoint split.
  const algosWithTrades = [...new Set(allTrades.map((t) => t.algo))].sort();
  const tradesByAlgo = new Map<string, TestTrade[]>();
  for (const algo of algosWithTrades) {
    const a = allTrades.filter((t) => t.algo === algo);
    a.sort((x, y) => x.entryDate.localeCompare(y.entryDate));
    tradesByAlgo.set(algo, a);
  }

  const rows: ResultRow[] = [];
  for (const algo of algosWithTrades) {
    const trades = tradesByAlgo.get(algo)!;
    const mid = Math.floor(trades.length / 2);
    const train = trades.slice(0, mid);
    const test = trades.slice(mid);
    const baselineTotal = trades.reduce((s, t) => s + t.actualR, 0);
    const baselineTrain = train.reduce((s, t) => s + t.actualR, 0);
    const baselineTest = test.reduce((s, t) => s + t.actualR, 0);

    for (const threshold of BE_THRESHOLDS_ATR) {
      const beR = trades.map((t) => simulateBeRescue(t, threshold));
      const beTotal = beR.reduce((s, r) => s + r, 0);
      const beTrainR = beR.slice(0, mid).reduce((s, r) => s + r, 0);
      const beTestR = beR.slice(mid).reduce((s, r) => s + r, 0);
      // Categorize each trade's changed outcome
      let scratched = 0, rescued = 0;
      for (let i = 0; i < trades.length; i++) {
        if (trades[i].actualR > 0 && beR[i] === BE_EXIT_R) scratched++;
        else if (trades[i].actualR < 0 && beR[i] === BE_EXIT_R) rescued++;
      }
      const trainImpPct = baselineTrain !== 0 ? ((beTrainR - baselineTrain) / Math.abs(baselineTrain)) * 100 : 0;
      const testImpPct = baselineTest !== 0 ? ((beTestR - baselineTest) / Math.abs(baselineTest)) * 100 : 0;
      const qualifies = trainImpPct >= MIN_IMPROVEMENT_PCT && testImpPct >= MIN_IMPROVEMENT_PCT;
      rows.push({
        algo,
        threshold,
        totalN: trades.length,
        baselineTotalR: baselineTotal,
        beTotalR: beTotal,
        baselineTrainR: baselineTrain,
        baselineTestR: baselineTest,
        beTrainR,
        beTestR,
        trainImprovementPct: trainImpPct,
        testImprovementPct: testImpPct,
        scratchedWinners: scratched,
        rescuedLosses: rescued,
        qualifies,
      });
    }
  }

  console.log("\n=== Per algo × BE threshold ===");
  console.log(
    "  algo                   thr  n  baseR     beR     trainΔ%  testΔ%  scr/res  qualifies"
  );
  for (const r of rows) {
    const tag = r.qualifies ? "✓ SHIP" : "·";
    console.log(
      `  ${r.algo.padEnd(22)}  ${r.threshold.toFixed(1)}  ${String(r.totalN).padStart(3)}  ` +
        `${r.baselineTotalR.toFixed(2).padStart(7)}  ${r.beTotalR.toFixed(2).padStart(7)}  ` +
        `${r.trainImprovementPct.toFixed(1).padStart(7)}%  ${r.testImprovementPct.toFixed(1).padStart(6)}%  ` +
        `${String(r.scratchedWinners).padStart(3)}/${String(r.rescuedLosses).padStart(3)}  ${tag}`
    );
  }

  console.log("\n=== Qualifying (algo, threshold) pairs ===");
  const winners = rows.filter((r) => r.qualifies);
  if (winners.length === 0) {
    console.log("(none qualified — feedback_structural_sl_tp_finding aggregate holds at per-algo level too)");
  } else {
    for (const r of winners) {
      console.log(
        `  ✓ ${r.algo}  BE@${r.threshold.toFixed(1)} ATR  ` +
          `baseline ${r.baselineTotalR.toFixed(2)}R → BE ${r.beTotalR.toFixed(2)}R  ` +
          `(TRAIN +${r.trainImprovementPct.toFixed(1)}%, TEST +${r.testImprovementPct.toFixed(1)}%)  ` +
          `${r.rescuedLosses} losses rescued, ${r.scratchedWinners} winners scratched`
      );
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/discovery-be-trigger-${stamp}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        locked_design: {
          capital: CAPITAL,
          risk_pct: RISK_PCT,
          friction: { slippage_bps: FRICTION_SLIPPAGE_BPS, spread_bps: FRICTION_SPREAD_BPS },
          be_exit_r: BE_EXIT_R,
          be_thresholds_atr: BE_THRESHOLDS_ATR,
          algos_under_test: [...ALGOS_UNDER_TEST].sort(),
          tickers: TICKERS,
          min_improvement_pct: MIN_IMPROVEMENT_PCT,
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
