/**
 * MFE/MAE trade-anatomy analysis (issue #226, audit priority #1).
 *
 * For every trade in the multi-pair library backtest corpus, walks the
 * bars from entry to exit and computes:
 *   - MFE (Maximum Favorable Excursion): how far in our direction did
 *     price go before exit
 *   - MAE (Maximum Adverse Excursion): how far against us did price go
 *     before reversing / exit
 *
 * Normalized to ATR(14) at entry bar so the result is instrument-
 * agnostic (XAU/USD's $30 vs EUR/USD's 0.003 are comparable).
 *
 * ============================================================
 * PRE-REGISTERED DESIGN — LOCKED 2026-06-16
 * Do NOT edit constants after seeing results.
 * ============================================================
 *
 *  Decision      | Pick
 *  --------------|----------------------------------------------
 *  1. Trade source | Same 8 algos × 4 pairs as V1.1 winner mining
 *                  | (library + mean_reversion variants under comboC
 *                  | geometry on XAU + EUR + GBP + JPY)
 *  2. MFE/MAE units | ATR(14) at entry bar — instrument-agnostic
 *  3. Outcome cuts | WIN (pnl > 0) vs LOSS (pnl < 0). Ties dropped.
 *  4. Aggregations | Pool · per algo · per V1.1 robust cluster
 *                  | (entry_zone=equilibrium + dxy=usd_down)
 *                  | · per outcome (WIN/LOSS)
 *  5. Statistics  | Mean · median · p25 · p75 · p90 of MFE_atr,
 *                 | MAE_atr per slice
 *  6. No retroactive filtering. No "ship/no-ship" threshold.
 *     This is DESCRIPTIVE analysis, not a decision rule.
 *
 * Friction: same realistic (0.5 / 0.4 bps) as V1.1.
 *
 * What this should answer:
 *   - Winners: how close to the 3R TP target did they actually reach
 *     (mean MFE / 3 ≈ TP fullness ratio)? Did winners go red first
 *     (negative MAE on winners → BE-trigger candidate)?
 *   - Losers: did they go favorable before reversing (positive MFE on
 *     losers → earlier exit could've saved R)? How close to SL (mean
 *     MAE on losers as %SL hit)?
 *   - Per cluster: does the V1.1 winning cluster have systematically
 *     different MFE/MAE characteristics?
 *
 * Out of scope for V1 of this analysis (note for future work):
 *   - exit_reason categorization (would need BacktestTrade.exit_reason
 *     which isn't emitted today)
 *   - Intra-bar precision (we use bar-level MFE/MAE only)
 *   - Bar-count of position life by category
 */
import { writeFileSync } from "fs";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import type { MarketStateSeries } from "../src/lib/market-data/portfolio-backtest";
import type { BacktestTrade, PriceBar } from "../src/lib/market-data/types";
import type { AlgorithmRules } from "../src/types/algorithm";
import { loadCorpus, type Corpus } from "./llm-trader-backtest";
import {
  computeMarketState4h,
  swingRegime,
  lastIdxAtOrBefore,
  atr14,
  type MarketStateInputs,
  type MarketState,
} from "../src/lib/market-data/market-state";

const CAPITAL = 100_000;
const RISK_PCT = 0.6;
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

interface TaggedTrade {
  algo: string;
  ticker: string;
  side: "long" | "short";
  pnl: number;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  mfeAtr: number; // signed: positive = favorable
  maeAtr: number; // signed: positive = adverse (magnitude)
  mfeRaw: number; // dollars (price units)
  maeRaw: number;
  atrAtEntry: number;
  features: {
    side: string;
    ticker: string;
    entry_zone: string;
    mtf: string;
    vol: string;
    range: string;
    dxy: string;
  };
}

function findBarIdx(bars: PriceBar[], targetDate: string): number {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= targetDate) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function positionInRangeBucket(bars: PriceBar[], entryIdx: number, entryPrice: number): string {
  if (entryIdx < 20) return "n/a";
  let hiV = -Infinity, loV = Infinity;
  for (let i = entryIdx - 19; i <= entryIdx; i++) {
    hiV = Math.max(hiV, bars[i].high);
    loV = Math.min(loV, bars[i].low);
  }
  if (hiV <= loV) return "n/a";
  const pct = ((entryPrice - loV) / (hiV - loV)) * 100;
  if (pct < 33) return "discount";
  if (pct < 67) return "equilibrium";
  return "premium";
}

function computeMfeMae(
  bars: PriceBar[],
  entryIdx: number,
  exitIdx: number,
  entryPrice: number,
  side: "long" | "short"
): { mfeRaw: number; maeRaw: number } {
  let maxFavorable = 0;
  let maxAdverse = 0;
  // Walk from entry+1 (the bar AFTER entry, since entry happens at entry bar's close)
  // to exitIdx inclusive (the bar where the position closed).
  for (let i = entryIdx + 1; i <= exitIdx && i < bars.length; i++) {
    const bar = bars[i];
    if (side === "long") {
      const favorable = bar.high - entryPrice; // positive when price went up
      const adverse = entryPrice - bar.low; // positive when price went down
      if (favorable > maxFavorable) maxFavorable = favorable;
      if (adverse > maxAdverse) maxAdverse = adverse;
    } else {
      const favorable = entryPrice - bar.low; // positive when price went down
      const adverse = bar.high - entryPrice; // positive when price went up
      if (favorable > maxFavorable) maxFavorable = favorable;
      if (adverse > maxAdverse) maxAdverse = adverse;
    }
  }
  return { mfeRaw: maxFavorable, maeRaw: maxAdverse };
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

  const specs = buildSpecs(assetClass);
  const tickerTrades: TaggedTrade[] = [];

  for (const s of specs) {
    const corpus = s.timeframe === "4h" ? corpus4h : s.timeframe === "1h" ? corpus1h : corpus30m;
    const trades = chunkedBacktest(s.rules, corpus, s.gate ? series : null, ticker);

    // For each trade, walk corpus.bars to compute MFE/MAE.
    const bars = corpus.bars;
    let processed = 0, skipped = 0;
    for (const t of trades) {
      const entryIdx = findBarIdx(bars, t.entry_date);
      const exitIdx = findBarIdx(bars, t.exit_date);
      if (entryIdx < 0 || exitIdx < 0 || exitIdx < entryIdx) { skipped++; continue; }

      // ATR(14) at entry bar — use the algo's own TF for the ATR
      const atr = atr14(bars, entryIdx);
      if (atr === null || atr <= 0) { skipped++; continue; }

      const { mfeRaw, maeRaw } = computeMfeMae(bars, entryIdx, exitIdx, t.entry_price, t.side);
      const mfeAtr = mfeRaw / atr;
      const maeAtr = maeRaw / atr;

      // State features at entry — use 4h market state same as V1.1
      const stateIdx = lastIdxAtOrBefore(inputs.bars4h, t.entry_date);
      const st: MarketState = stateIdx >= 0
        ? computeMarketState4h(inputs, stateIdx)
        : { mtf: "n/a", vol: "n/a", range: "n/a", dxy: "n/a" };
      const entryZone = positionInRangeBucket(bars, entryIdx, t.entry_price);

      tickerTrades.push({
        algo: s.key,
        ticker,
        side: t.side,
        pnl: t.pnl,
        entryDate: t.entry_date,
        exitDate: t.exit_date,
        entryPrice: t.entry_price,
        exitPrice: t.exit_price,
        mfeRaw,
        maeRaw,
        mfeAtr,
        maeAtr,
        atrAtEntry: atr,
        features: {
          side: t.side,
          ticker,
          entry_zone: entryZone,
          mtf: st.mtf,
          vol: st.vol,
          range: st.range,
          dxy: st.dxy,
        },
      });
      processed++;
    }
    console.log(`  ${s.key.padEnd(22)} ${trades.length} trades (${processed} processed, ${skipped} skipped — missing entry/exit bar or ATR)`);
  }
  return tickerTrades;
}

interface SliceStats {
  n: number;
  meanPnl: number;
  meanMfeAtr: number;
  medianMfeAtr: number;
  p25MfeAtr: number;
  p75MfeAtr: number;
  p90MfeAtr: number;
  meanMaeAtr: number;
  medianMaeAtr: number;
  p25MaeAtr: number;
  p75MaeAtr: number;
  p90MaeAtr: number;
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function statsFor(trades: TaggedTrade[]): SliceStats {
  if (trades.length === 0) {
    return {
      n: 0, meanPnl: 0,
      meanMfeAtr: 0, medianMfeAtr: 0, p25MfeAtr: 0, p75MfeAtr: 0, p90MfeAtr: 0,
      meanMaeAtr: 0, medianMaeAtr: 0, p25MaeAtr: 0, p75MaeAtr: 0, p90MaeAtr: 0,
    };
  }
  const mfes = trades.map((t) => t.mfeAtr);
  const maes = trades.map((t) => t.maeAtr);
  const pnl = trades.reduce((s, t) => s + t.pnl, 0) / trades.length;
  return {
    n: trades.length,
    meanPnl: pnl,
    meanMfeAtr: mfes.reduce((s, v) => s + v, 0) / mfes.length,
    medianMfeAtr: pct(mfes, 50),
    p25MfeAtr: pct(mfes, 25),
    p75MfeAtr: pct(mfes, 75),
    p90MfeAtr: pct(mfes, 90),
    meanMaeAtr: maes.reduce((s, v) => s + v, 0) / maes.length,
    medianMaeAtr: pct(maes, 50),
    p25MaeAtr: pct(maes, 25),
    p75MaeAtr: pct(maes, 75),
    p90MaeAtr: pct(maes, 90),
  };
}

function fmtStats(label: string, s: SliceStats): string {
  if (s.n === 0) return `  ${label.padEnd(46)}  (no trades)`;
  return (
    `  ${label.padEnd(46)}  n=${String(s.n).padStart(4)}` +
    `  MFE_atr mean=${s.meanMfeAtr.toFixed(2).padStart(5)} med=${s.medianMfeAtr.toFixed(2).padStart(5)} p25=${s.p25MfeAtr.toFixed(2).padStart(5)} p75=${s.p75MfeAtr.toFixed(2).padStart(5)} p90=${s.p90MfeAtr.toFixed(2).padStart(5)}` +
    `  MAE_atr mean=${s.meanMaeAtr.toFixed(2).padStart(5)} med=${s.medianMaeAtr.toFixed(2).padStart(5)} p75=${s.p75MaeAtr.toFixed(2).padStart(5)} p90=${s.p90MaeAtr.toFixed(2).padStart(5)}`
  );
}

async function main() {
  console.log("MFE/MAE trade-anatomy analysis — PRE-REGISTERED design");
  console.log(`Tickers: ${TICKERS.join(", ")}`);
  console.log("Units: ATR(14) at entry bar (instrument-agnostic).");
  console.log("Locked constants: see file header. Do NOT edit post-results.\n");

  const allTrades: TaggedTrade[] = [];
  for (const ticker of TICKERS) {
    const tickerTrades = await processOneTicker(ticker);
    allTrades.push(...tickerTrades);
  }

  console.log(`\nTotal pooled trades (with valid MFE/MAE): ${allTrades.length}`);
  const winners = allTrades.filter((t) => t.pnl > 0);
  const losers = allTrades.filter((t) => t.pnl < 0);
  console.log(`  WIN: ${winners.length}  LOSS: ${losers.length}`);

  console.log("\n=== Pool aggregates by outcome ===");
  console.log(fmtStats("ALL", statsFor(allTrades)));
  console.log(fmtStats("WIN  (pnl>0)", statsFor(winners)));
  console.log(fmtStats("LOSS (pnl<0)", statsFor(losers)));

  console.log("\n=== Per algo, WIN/LOSS split ===");
  const algos = [...new Set(allTrades.map((t) => t.algo))].sort();
  for (const algo of algos) {
    const algoTrades = allTrades.filter((t) => t.algo === algo);
    const algoWins = algoTrades.filter((t) => t.pnl > 0);
    const algoLosses = algoTrades.filter((t) => t.pnl < 0);
    console.log(fmtStats(`${algo} WIN`, statsFor(algoWins)));
    console.log(fmtStats(`${algo} LOSS`, statsFor(algoLosses)));
  }

  console.log("\n=== Per V1.1 robust winner cluster (entry_zone=equilibrium + dxy=usd_down) ===");
  const v1Cluster = allTrades.filter((t) => t.features.entry_zone === "equilibrium" && t.features.dxy === "usd_down");
  console.log(fmtStats("V1.1-equilibrium+usd_down ALL", statsFor(v1Cluster)));
  console.log(fmtStats("V1.1-cluster WIN", statsFor(v1Cluster.filter((t) => t.pnl > 0))));
  console.log(fmtStats("V1.1-cluster LOSS", statsFor(v1Cluster.filter((t) => t.pnl < 0))));

  console.log("\n=== Loser-mining cluster (late(21-24) + usd_flip) ===");
  // Recompute the entry_hour_bucket for this slice
  const lateHourFlip = allTrades.filter((t) => {
    const hr = new Date(t.entryDate).getUTCHours();
    const lateBucket = hr >= 21;
    return lateBucket && t.features.dxy === "usd_flip";
  });
  console.log(fmtStats("late(21-24)+usd_flip ALL", statsFor(lateHourFlip)));
  console.log(fmtStats("late+flip WIN", statsFor(lateHourFlip.filter((t) => t.pnl > 0))));
  console.log(fmtStats("late+flip LOSS", statsFor(lateHourFlip.filter((t) => t.pnl < 0))));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/discovery-mfe-mae-${stamp}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        locked_design: {
          capital: CAPITAL,
          risk_pct: RISK_PCT,
          friction: { slippage_bps: FRICTION_SLIPPAGE_BPS, spread_bps: FRICTION_SPREAD_BPS },
          units: "ATR(14) at entry bar",
          tickers: TICKERS,
          algos: algos,
        },
        total_trades: allTrades.length,
        pool_all: statsFor(allTrades),
        pool_win: statsFor(winners),
        pool_loss: statsFor(losers),
        per_algo: Object.fromEntries(
          algos.map((a) => [
            a,
            {
              WIN: statsFor(allTrades.filter((t) => t.algo === a && t.pnl > 0)),
              LOSS: statsFor(allTrades.filter((t) => t.algo === a && t.pnl < 0)),
            },
          ])
        ),
        v1_winner_cluster: {
          ALL: statsFor(v1Cluster),
          WIN: statsFor(v1Cluster.filter((t) => t.pnl > 0)),
          LOSS: statsFor(v1Cluster.filter((t) => t.pnl < 0)),
        },
        loser_cluster: {
          ALL: statsFor(lateHourFlip),
          WIN: statsFor(lateHourFlip.filter((t) => t.pnl > 0)),
          LOSS: statsFor(lateHourFlip.filter((t) => t.pnl < 0)),
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
