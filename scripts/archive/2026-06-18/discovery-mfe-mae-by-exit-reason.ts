/**
 * MFE/MAE × exit_reason cross-tabulation analysis.
 *
 * Extension of discovery-mfe-mae-analysis.ts (PR #231) using the
 * exit_reason field enabled by PR #233. Same harness, same MFE/MAE
 * computation, same pool — but adds per-exit-reason slicing on top of
 * WIN/LOSS.
 *
 * Questions this answers that simple WIN/LOSS couldn't:
 *   - Do TP-hit winners have systematically higher MFE than
 *     signal-exit/stagnant winners? (TP hit means full 3R, signal-exit
 *     may exit at any positive R)
 *   - Stagnant-cut losses vs full-SL losses: very different MAE
 *     distributions? (If stagnant cuts have small MAE, the stagnant
 *     gate is doing real defensive work)
 *   - Per-algo exit-reason MIX: which algos rely on which mechanic?
 *     Are mean-reversion algos stagnant-cut-dominated? Are trend-
 *     followers TP-hit dominated?
 *
 * ============================================================
 * PRE-REGISTERED DESIGN — LOCKED 2026-06-16
 * ============================================================
 *
 *  Decision      | Pick
 *  --------------|----------------------------------------------
 *  1. Trade source | Same 8 algos × 4 pairs as MFE/MAE (PR #231)
 *                  | + BE-trigger test (PR #232).
 *  2. MFE/MAE units | ATR(14) at entry bar (same).
 *  3. Outcome cuts | (a) WIN/LOSS × exit_reason cross-tab (pool)
 *                  | (b) per-algo × exit_reason mix table
 *                  | (c) per-exit-reason MFE/MAE percentiles
 *  4. Force_close handling | REPORTED but FLAGGED as backtest artifact
 *                          | (chunk boundary force-closes are not real
 *                          | exit decisions). NOT used in headline
 *                          | "real exit" stats.
 *  5. Statistics  | Same as PR #231: mean · median · p25 · p75 · p90
 *  6. No retroactive filtering. Descriptive analysis.
 *
 * Friction: realistic 0.5/0.4 bps as before.
 *
 * Out of scope (would need separate test):
 *   - Re-running BE-trigger with exit_reason-aware filtering (e.g.,
 *     only apply BE to trades that would have ended as SL-hit)
 *   - Per-cluster (V1.1 features) × exit_reason 3-way table
 *   - Cross-instrument variation per exit_reason
 */
import { writeFileSync } from "fs";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import type { MarketStateSeries } from "../src/lib/market-data/portfolio-backtest";
import type { BacktestExitReason, BacktestTrade, PriceBar } from "../src/lib/market-data/types";
import type { AlgorithmRules } from "../src/types/algorithm";
import { loadCorpus, type Corpus } from "./llm-trader-backtest";
import { atr14 } from "../src/lib/market-data/market-state";

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
  exitReason: BacktestExitReason | "unknown";
  mfeAtr: number;
  maeAtr: number;
}

function findBarIdx(bars: PriceBar[], targetDate: string): number {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= targetDate) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function computeMfeMae(
  bars: PriceBar[],
  entryIdx: number,
  exitIdx: number,
  entryPrice: number,
  side: "long" | "short"
): { mfeRaw: number; maeRaw: number } {
  let maxFavorable = 0, maxAdverse = 0;
  for (let i = entryIdx + 1; i <= exitIdx && i < bars.length; i++) {
    const bar = bars[i];
    if (side === "long") {
      const fav = bar.high - entryPrice;
      const adv = entryPrice - bar.low;
      if (fav > maxFavorable) maxFavorable = fav;
      if (adv > maxAdverse) maxAdverse = adv;
    } else {
      const fav = entryPrice - bar.low;
      const adv = bar.high - entryPrice;
      if (fav > maxFavorable) maxFavorable = fav;
      if (adv > maxAdverse) maxAdverse = adv;
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
  const tickerTrades: TaggedTrade[] = [];
  for (const s of specs) {
    const corpus = s.timeframe === "4h" ? corpus4h : s.timeframe === "1h" ? corpus1h : corpus30m;
    const trades = chunkedBacktest(s.rules, corpus, s.gate ? series : null, ticker);
    let processed = 0, skipped = 0;
    for (const t of trades) {
      const entryIdx = findBarIdx(corpus.bars, t.entry_date);
      const exitIdx = findBarIdx(corpus.bars, t.exit_date);
      if (entryIdx < 0 || exitIdx < 0 || exitIdx < entryIdx) { skipped++; continue; }
      const atr = atr14(corpus.bars, entryIdx);
      if (atr === null || atr <= 0) { skipped++; continue; }
      const { mfeRaw, maeRaw } = computeMfeMae(corpus.bars, entryIdx, exitIdx, t.entry_price, t.side);
      tickerTrades.push({
        algo: s.key,
        ticker,
        side: t.side,
        pnl: t.pnl,
        exitReason: t.exit_reason ?? "unknown",
        mfeAtr: mfeRaw / atr,
        maeAtr: maeRaw / atr,
      });
      processed++;
    }
    console.log(`  ${s.key.padEnd(22)} ${trades.length} trades (${processed} processed, ${skipped} skipped)`);
  }
  return tickerTrades;
}

interface SliceStats {
  n: number;
  meanPnl: number;
  meanMfeAtr: number;
  medianMfeAtr: number;
  p75MfeAtr: number;
  p90MfeAtr: number;
  meanMaeAtr: number;
  medianMaeAtr: number;
  p75MaeAtr: number;
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function statsFor(trades: TaggedTrade[]): SliceStats {
  if (trades.length === 0) {
    return { n: 0, meanPnl: 0, meanMfeAtr: 0, medianMfeAtr: 0, p75MfeAtr: 0, p90MfeAtr: 0, meanMaeAtr: 0, medianMaeAtr: 0, p75MaeAtr: 0 };
  }
  const mfes = trades.map((t) => t.mfeAtr);
  const maes = trades.map((t) => t.maeAtr);
  return {
    n: trades.length,
    meanPnl: trades.reduce((s, t) => s + t.pnl, 0) / trades.length,
    meanMfeAtr: mfes.reduce((s, v) => s + v, 0) / mfes.length,
    medianMfeAtr: pct(mfes, 50),
    p75MfeAtr: pct(mfes, 75),
    p90MfeAtr: pct(mfes, 90),
    meanMaeAtr: maes.reduce((s, v) => s + v, 0) / maes.length,
    medianMaeAtr: pct(maes, 50),
    p75MaeAtr: pct(maes, 75),
  };
}

function fmt(label: string, s: SliceStats): string {
  if (s.n === 0) return `  ${label.padEnd(42)}  (none)`;
  return (
    `  ${label.padEnd(42)}  n=${String(s.n).padStart(4)}` +
    `  MFE  mean=${s.meanMfeAtr.toFixed(2).padStart(5)} med=${s.medianMfeAtr.toFixed(2).padStart(5)} p75=${s.p75MfeAtr.toFixed(2).padStart(5)} p90=${s.p90MfeAtr.toFixed(2).padStart(5)}` +
    `  MAE  mean=${s.meanMaeAtr.toFixed(2).padStart(5)} med=${s.medianMaeAtr.toFixed(2).padStart(5)} p75=${s.p75MaeAtr.toFixed(2).padStart(5)}`
  );
}

async function main() {
  console.log("MFE/MAE × exit_reason analysis — PRE-REGISTERED");
  console.log(`Tickers: ${TICKERS.join(", ")}`);
  console.log("Units: ATR(14) at entry bar.\n");

  const allTrades: TaggedTrade[] = [];
  for (const ticker of TICKERS) {
    const tickerTrades = await processOneTicker(ticker);
    allTrades.push(...tickerTrades);
  }

  const real = allTrades.filter((t) => t.exitReason !== "force_close" && t.exitReason !== "unknown");
  const forceClose = allTrades.filter((t) => t.exitReason === "force_close");
  const unknown = allTrades.filter((t) => t.exitReason === "unknown");

  console.log(`\nTotal pooled trades: ${allTrades.length}`);
  console.log(`  REAL exits (TP/SL/signal/stagnant): ${real.length}`);
  console.log(`  force_close (chunk boundary artifacts): ${forceClose.length}`);
  console.log(`  unknown (no exit_reason — legacy?): ${unknown.length}`);

  const realExitReasons: BacktestExitReason[] = ["take_profit_hit", "stop_loss_hit", "signal_exit", "stagnant_exit"];

  console.log("\n=== POOL × exit_reason (real exits only) ===");
  for (const er of realExitReasons) {
    const slice = real.filter((t) => t.exitReason === er);
    if (slice.length === 0) continue;
    console.log(fmt(`ALL ${er}`, statsFor(slice)));
    console.log(fmt(`  ${er} WIN`, statsFor(slice.filter((t) => t.pnl > 0))));
    console.log(fmt(`  ${er} LOSS`, statsFor(slice.filter((t) => t.pnl < 0))));
  }
  console.log(fmt("force_close (BACKTEST ARTIFACT)", statsFor(forceClose)));

  console.log("\n=== Per algo × exit_reason MIX (count, %% of algo total) ===");
  const algos = [...new Set(real.map((t) => t.algo))].sort();
  const header = "  algo                    total" +
    realExitReasons.map((er) => er.replace("_hit", "").replace("_exit", "").padStart(11)).join("") +
    "       fc";
  console.log(header);
  for (const algo of algos) {
    const algoAll = allTrades.filter((t) => t.algo === algo);
    const algoReal = real.filter((t) => t.algo === algo);
    const algoFc = forceClose.filter((t) => t.algo === algo);
    const total = algoAll.length;
    const cells = realExitReasons.map((er) => {
      const n = algoReal.filter((t) => t.exitReason === er).length;
      return total > 0 ? `${String(n).padStart(3)}(${((n / total) * 100).toFixed(0).padStart(2)}%)` : "    ·    ";
    }).map((s) => s.padStart(11)).join("");
    const fcCell = total > 0 ? `${String(algoFc.length).padStart(3)}(${((algoFc.length / total) * 100).toFixed(0).padStart(2)}%)` : "  ·  ";
    console.log(`  ${algo.padEnd(22)}  ${String(total).padStart(4)}${cells}  ${fcCell}`);
  }

  console.log("\n=== Per algo: WIN/LOSS by exit_reason (most informative) ===");
  for (const algo of algos) {
    console.log(`\n  ${algo}:`);
    for (const er of realExitReasons) {
      const slice = real.filter((t) => t.algo === algo && t.exitReason === er);
      if (slice.length < 5) continue;
      const wins = slice.filter((t) => t.pnl > 0);
      const losses = slice.filter((t) => t.pnl < 0);
      console.log(fmt(`    ${er} ALL`, statsFor(slice)));
      if (wins.length > 0) console.log(fmt(`    ${er} WIN`, statsFor(wins)));
      if (losses.length > 0) console.log(fmt(`    ${er} LOSS`, statsFor(losses)));
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/discovery-mfe-mae-by-exit-${stamp}.json`;
  const perAlgoBreakdown: Record<string, Record<string, SliceStats>> = {};
  for (const algo of algos) {
    perAlgoBreakdown[algo] = {};
    for (const er of realExitReasons) {
      const slice = real.filter((t) => t.algo === algo && t.exitReason === er);
      perAlgoBreakdown[algo][er] = statsFor(slice);
      perAlgoBreakdown[algo][`${er}_WIN`] = statsFor(slice.filter((t) => t.pnl > 0));
      perAlgoBreakdown[algo][`${er}_LOSS`] = statsFor(slice.filter((t) => t.pnl < 0));
    }
  }
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        locked_design: {
          capital: CAPITAL,
          risk_pct: RISK_PCT,
          friction: { slippage_bps: FRICTION_SLIPPAGE_BPS, spread_bps: FRICTION_SPREAD_BPS },
          tickers: TICKERS,
          algos,
        },
        totals: {
          all: allTrades.length,
          real_exits: real.length,
          force_close_artifacts: forceClose.length,
          unknown: unknown.length,
        },
        pool_by_exit_reason: Object.fromEntries(
          realExitReasons.map((er) => {
            const slice = real.filter((t) => t.exitReason === er);
            return [er, {
              ALL: statsFor(slice),
              WIN: statsFor(slice.filter((t) => t.pnl > 0)),
              LOSS: statsFor(slice.filter((t) => t.pnl < 0)),
            }];
          })
        ),
        per_algo_by_exit_reason: perAlgoBreakdown,
      },
      null,
      2
    )
  );
  console.log(`\nSaved: ${outPath}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
