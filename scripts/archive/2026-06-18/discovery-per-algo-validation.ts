/**
 * Per-algo validation aggregator across V1.2 corpus.
 *
 * The trade-flow diagnostic (2026-06-16 PM) showed library is regime-
 * fragmented — 4 deployed algos cover narrow regimes, generating ~1
 * trade/30d total. The V1.2 mining script (`scripts/discovery-v1-2-
 * symmetric-mining.ts`) runs backtests on 8 specs, but only 4 are
 * deployed live. This script extracts per-algo aggregates from the same
 * corpus to identify validated candidates for paper-only deploy.
 *
 * Validation gate (feedback_dd_validation_gate):
 *   - Peak-to-trough DD ≤ 5% of $100K capital on the full corpus
 *   - Mean R > 0 (positive expectancy)
 *   - n ≥ 30 trades (interpretable sample)
 *
 * Output: per-algo + per-(algo,ticker) + per-(algo,regime) aggregates
 *         with PASS/FAIL verdict. JSON file written for further analysis.
 *
 * Usage:
 *   pnpm dlx tsx scripts/discovery-per-algo-validation.ts
 *   TICKERS=XAU/USD pnpm dlx tsx scripts/discovery-per-algo-validation.ts
 */
import { writeFileSync } from "fs";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import type { MarketStateSeries } from "../src/lib/market-data/portfolio-backtest";
import type { BacktestTrade } from "../src/lib/market-data/types";
import {
  computeMarketState4h,
  swingRegime,
  type MarketStateInputs,
} from "../src/lib/market-data/market-state";
import type { AlgorithmRules } from "../src/types/algorithm";
import { loadCorpus, type Corpus } from "./llm-trader-backtest";

// Constants mirror V1.2 exactly.
const CAPITAL = 100_000;
const RISK_PCT = 0.6;
const RISK_DOLLARS = (CAPITAL * RISK_PCT) / 100;
const CHUNK_DAYS = 90;
const DAY_MS = 86_400_000;
const TICKERS = (process.env.TICKERS ?? "XAU/USD,EUR/USD,GBP/USD,USD/JPY")
  .split(",").map((s) => s.trim());
const FRICTION_SLIPPAGE_BPS = 0.5;
const FRICTION_SPREAD_BPS = 0.4;

// Validation gates (feedback_dd_validation_gate + reasonable defaults).
const DD_THRESHOLD_PCT = 5.0;
const MIN_N_TRADES = 30;
const MIN_MEAN_R = 0.0;

// Which specs are currently DEPLOYED live (queried at session start).
const DEPLOYED_SPEC_KEYS = new Set([
  "fvg_long_30m",       // Library: Gold FVG-Long 30m
  "coil_breakout_1h",   // Library: Gold Coil-Breakout 1h
  "bear_short_4h",      // Library: Gold Bear-Short Sentinel 4h
  "dip_buyer_4h",       // Library: Gold Dip-Buyer 4h
  // ote_long_4h deployed too, but isn't in V1.2 mining specs (no historic corpus).
]);

function assetClassFor(ticker: string): "commodity" | "forex" {
  return ticker.startsWith("XAU") || ticker.startsWith("XAG") ? "commodity" : "forex";
}

function baseRules(timeframe: "4h" | "1h" | "30m", side: "long" | "short" = "long", assetClass: "commodity" | "forex" = "commodity"): AlgorithmRules {
  return {
    entry_conditions: [], exit_conditions: [],
    stop_loss: { type: "swing_anchor", value: 0.1, lookback: 4 },
    take_profit: { type: "rr_multiple", value: 3 },
    position_sizing: { type: "risk_per_trade", value: RISK_PCT },
    max_positions: 1, leverage: 9, timeframe, asset_class: assetClass, side,
    stagnant_exit: { enabled: true },
    prop_firm: { slippage_bps: FRICTION_SLIPPAGE_BPS, spread_bps: FRICTION_SPREAD_BPS },
  } as unknown as AlgorithmRules;
}

interface AlgoSpec { key: string; timeframe: "4h" | "1h" | "30m"; rules: AlgorithmRules; gate: boolean; }
function buildSpecs(ac: "commodity" | "forex"): AlgoSpec[] {
  const db = baseRules("4h", "long", ac);
  db.entry_conditions = [
    { type: "pattern", pattern: "liquidity_sweep", direction: "bullish", lookback: 5, timeframe: "4h" },
    { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "4h" },
  ];
  db.market_state_gate = { mode: "block", states: { mtf: ["fast_div_bull"], dxy: ["usd_down"] }, on_unreadable: "allow" };
  const cb4 = baseRules("4h", "long", ac);
  cb4.entry_conditions = [
    { type: "pattern", pattern: "bos", direction: "bullish", lookback: 5, timeframe: "4h" },
    { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "4h" },
  ];
  cb4.market_state_gate = { mode: "allow", states: { range: ["compressed"] } };
  const cb1 = baseRules("1h", "long", ac);
  cb1.entry_conditions = [{ type: "pattern", pattern: "bos", direction: "bullish", lookback: 5, timeframe: "1h" }];
  const bs = baseRules("4h", "short", ac);
  bs.entry_conditions = [
    { type: "pattern", pattern: "bos", direction: "bearish", lookback: 5, timeframe: "4h" },
    { type: "pattern", pattern: "daily_bias", direction: "bearish", ma_period: 20, timeframe: "4h" },
  ];
  bs.market_state_gate = { mode: "allow", states: { mtf: ["aligned_LH"] } };
  const br = baseRules("4h", "short", ac);
  br.entry_conditions = [{ type: "pattern", pattern: "bos", direction: "bearish", lookback: 5, timeframe: "4h" }];
  br.market_state_gate = { mode: "allow", states: { mtf: ["fast_div_bear"] } };
  const fv = baseRules("30m", "long", ac);
  fv.entry_conditions = [{ type: "pattern", pattern: "fvg", direction: "bullish", timeframe: "30m" }];
  const mrL = baseRules("4h", "long", ac);
  mrL.entry_conditions = [{ type: "pattern", pattern: "mean_reversion", direction: "bullish", lookback: 20, timeframe: "4h" }];
  const mrS = baseRules("4h", "short", ac);
  mrS.entry_conditions = [{ type: "pattern", pattern: "mean_reversion", direction: "bearish", lookback: 20, timeframe: "4h" }];
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

interface TT {
  ticker: string; algo: string; tf: string; gate: boolean; side: "long" | "short";
  pnl: number; r: number; entry_date: string; entry_ms: number;
  regime: string; mtf: string;
}

async function processOneTicker(ticker: string): Promise<TT[]> {
  const ac = assetClassFor(ticker);
  console.log(`\n--- ${ticker} (${ac}) ---`);
  const c4 = await loadCorpus("4h", ticker);
  const c1 = await loadCorpus("1h", ticker);
  const c30 = await loadCorpus("30m", ticker);
  const series: MarketStateSeries = {
    bars4h: new Map([[ticker, c4.bars]]),
    oneHour: new Map([[ticker, c1.bars]]),
    daily: new Map([[ticker, c4.dailyBars]]),
    eurusd4h: c4.eurusd4h,
  };
  const inputs: MarketStateInputs = {
    bars4h: c4.bars, oneHourBars: c1.bars, dailyBars: c4.dailyBars, eurusd4h: c4.eurusd4h,
  };
  const localChunked = (rules: AlgorithmRules, corpus: Corpus, srs: MarketStateSeries | null): BacktestTrade[] => {
    const bars = corpus.bars;
    if (bars.length === 0) return [];
    const trades: BacktestTrade[] = [];
    const start = new Date(bars[0].date).getTime();
    const end = new Date(bars[bars.length - 1].date).getTime();
    for (let cur = start; cur < end; cur += CHUNK_DAYS * DAY_MS) {
      const ce = cur + CHUNK_DAYS * DAY_MS;
      const chunk = bars.filter((b) => {
        const t = new Date(b.date).getTime();
        return t >= cur && t < ce;
      });
      if (chunk.length < 30) continue;
      const m = runPortfolioBacktest(rules, new Map([[ticker, chunk]]), CAPITAL, [], null, srs);
      trades.push(...m.trades);
    }
    trades.sort((a, b) => new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime());
    return trades;
  };
  const specs = buildSpecs(ac);
  const out: TT[] = [];
  for (const s of specs) {
    const corpus = s.timeframe === "4h" ? c4 : s.timeframe === "1h" ? c1 : c30;
    const trades = localChunked(s.rules, corpus, s.gate ? series : null);
    for (const t of trades) {
      const ms4 = findBarIdx(inputs.bars4h, t.entry_date);
      const ms = ms4 >= 0 ? computeMarketState4h(inputs, ms4) : null;
      const d1Idx = findBarIdx(c4.dailyBars, t.entry_date.slice(0, 10) + " 00:00:00") - 1;
      const regimeRaw = d1Idx >= 7 ? swingRegime(c4.dailyBars, d1Idx) : null;
      out.push({
        ticker, algo: s.key, tf: s.timeframe, gate: s.gate, side: t.side,
        pnl: t.pnl, r: t.pnl / RISK_DOLLARS, entry_date: t.entry_date,
        entry_ms: new Date(t.entry_date).getTime(),
        regime: regimeRaw ?? "n/a",
        mtf: ms?.mtf ?? "n/a",
      });
    }
    console.log(`  ${s.key.padEnd(28)} → ${trades.length} trades`);
  }
  return out;
}

function peakToTroughDDPct(orderedTrades: TT[]): number {
  // Sort by entry_ms ascending.
  const sorted = [...orderedTrades].sort((a, b) => a.entry_ms - b.entry_ms);
  let equity = 0;
  let peak = 0;
  let maxDD = 0;
  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity; // dollar drawdown from peak
    if (dd > maxDD) maxDD = dd;
  }
  return (maxDD / CAPITAL) * 100;
}

interface AlgoAgg {
  algo: string;
  deployed: boolean;
  tf: string;
  n: number;
  mean_r: number;
  total_r: number;
  win_pct: number;
  total_pnl_usd: number;
  dd_pct: number;
  passes_gate: boolean;
  fail_reasons: string[];
  per_ticker: Record<string, { n: number; mean_r: number; win_pct: number }>;
  per_regime: Record<string, { n: number; mean_r: number; win_pct: number }>;
}

function aggOne(rs: number[]): { n: number; mean_r: number; win_pct: number } {
  if (rs.length === 0) return { n: 0, mean_r: 0, win_pct: 0 };
  const sum = rs.reduce((s, x) => s + x, 0);
  const wins = rs.filter((x) => x > 0).length;
  return { n: rs.length, mean_r: sum / rs.length, win_pct: (wins * 100) / rs.length };
}

function aggregateAlgo(algo: string, tf: string, trades: TT[]): AlgoAgg {
  const n = trades.length;
  const sum = trades.reduce((s, x) => s + x.r, 0);
  const wins = trades.filter((x) => x.r > 0).length;
  const totalPnl = trades.reduce((s, x) => s + x.pnl, 0);
  const dd = peakToTroughDDPct(trades);
  const meanR = n > 0 ? sum / n : 0;
  const winPct = n > 0 ? (wins * 100) / n : 0;

  const failures: string[] = [];
  if (n < MIN_N_TRADES) failures.push(`n=${n} < ${MIN_N_TRADES}`);
  if (meanR <= MIN_MEAN_R) failures.push(`mean_R=${meanR.toFixed(3)} ≤ ${MIN_MEAN_R}`);
  if (dd > DD_THRESHOLD_PCT) failures.push(`DD=${dd.toFixed(2)}% > ${DD_THRESHOLD_PCT}%`);

  const per_ticker: Record<string, { n: number; mean_r: number; win_pct: number }> = {};
  const per_regime: Record<string, { n: number; mean_r: number; win_pct: number }> = {};
  for (const tick of TICKERS) {
    per_ticker[tick] = aggOne(trades.filter((t) => t.ticker === tick).map((t) => t.r));
  }
  // Use mtf state (from computeMarketState4h), which is what the deployed
  // market_state_gates and V1.2 cluster definitions key on.
  const regimes = ["aligned_HH", "aligned_LH", "ranging_all", "fast_div_bull", "fast_div_bear", "mixed", "n/a"];
  for (const reg of regimes) {
    per_regime[reg] = aggOne(trades.filter((t) => t.mtf === reg).map((t) => t.r));
  }

  return {
    algo, deployed: DEPLOYED_SPEC_KEYS.has(algo), tf,
    n, mean_r: meanR, total_r: sum, win_pct: winPct,
    total_pnl_usd: totalPnl, dd_pct: dd,
    passes_gate: failures.length === 0,
    fail_reasons: failures,
    per_ticker, per_regime,
  };
}

async function main() {
  console.log("Per-algo validation across V1.2 corpus");
  console.log(`Tickers: ${TICKERS.join(", ")}`);
  console.log(`Gate: DD ≤ ${DD_THRESHOLD_PCT}% AND n ≥ ${MIN_N_TRADES} AND mean_R > ${MIN_MEAN_R}`);

  const all: TT[] = [];
  for (const t of TICKERS) all.push(...(await processOneTicker(t)));
  console.log(`\nTotal pooled trades: ${all.length}`);

  const algoKeys = [
    "dip_buyer_4h", "coil_breakout_4h", "coil_breakout_1h",
    "bear_short_4h", "breakdown_rider_4h", "fvg_long_30m",
    "mean_reversion_long_4h", "mean_reversion_short_4h",
  ];

  const aggs: AlgoAgg[] = algoKeys.map((k) => {
    const trades = all.filter((t) => t.algo === k);
    const tf = trades.length > 0 ? trades[0].tf : "?";
    return aggregateAlgo(k, tf, trades);
  });

  console.log("\n=== Per-algo headline ===");
  console.log("Algo                          TF   live  n     mean_R   win%   total$    DD%    VERDICT");
  for (const a of aggs) {
    const verdict = a.passes_gate ? "PASS" : "FAIL";
    const live = a.deployed ? "YES" : "NO ";
    console.log(
      `${a.algo.padEnd(28)}  ${a.tf.padEnd(3)}  ${live}   ${String(a.n).padStart(4)}  ${a.mean_r.toFixed(3).padStart(7)}  ${a.win_pct.toFixed(1).padStart(5)}  ${a.total_pnl_usd.toFixed(0).padStart(8)}  ${a.dd_pct.toFixed(2).padStart(5)}  ${verdict}${a.fail_reasons.length > 0 ? "  (" + a.fail_reasons.join("; ") + ")" : ""}`
    );
  }

  console.log("\n=== UNDEPLOYED specs that pass the validation gate ===");
  const candidates = aggs.filter((a) => !a.deployed && a.passes_gate);
  if (candidates.length === 0) {
    console.log("  None. The 4 undeployed V1.2 specs do NOT pass the validation gate.");
  } else {
    for (const c of candidates) {
      console.log(`  ${c.algo}: n=${c.n}, mean_R=${c.mean_r.toFixed(3)}, DD=${c.dd_pct.toFixed(2)}%`);
    }
  }

  console.log("\n=== Per-regime mean_R per algo (interpretation aid) ===");
  console.log("Algo                          |  HH_align  |  LH_align  |  ranging  |  fast_bull  |  fast_bear  |  mixed   ");
  for (const a of aggs) {
    const fmt = (key: string) => {
      const c = a.per_regime[key];
      if (c.n === 0) return "    -    ";
      const sign = c.mean_r >= 0 ? "+" : "";
      return `${sign}${c.mean_r.toFixed(2)} n=${c.n}`.padEnd(10);
    };
    console.log(
      `${a.algo.padEnd(28)} | ${fmt("aligned_HH")} | ${fmt("aligned_LH")} | ${fmt("ranging_all")} | ${fmt("fast_div_bull")} | ${fmt("fast_div_bear")} | ${fmt("mixed")}`
    );
  }

  console.log("\n=== Per-ticker headline (DD on gold-slice only, since deployment is gold-only) ===");
  console.log("Algo                          XAU n   XAU mean_R   XAU DD%   XAU total$");
  for (const a of aggs) {
    const xauTrades = all.filter((t) => t.algo === a.algo && t.ticker === "XAU/USD");
    if (xauTrades.length === 0) {
      console.log(`${a.algo.padEnd(28)}    -        -          -        -`);
      continue;
    }
    const xauSum = xauTrades.reduce((s, x) => s + x.r, 0);
    const xauPnl = xauTrades.reduce((s, x) => s + x.pnl, 0);
    const xauMean = xauSum / xauTrades.length;
    const xauDD = peakToTroughDDPct(xauTrades);
    console.log(
      `${a.algo.padEnd(28)}  ${String(xauTrades.length).padStart(4)}    ${xauMean.toFixed(3).padStart(7)}    ${xauDD.toFixed(2).padStart(5)}    ${xauPnl.toFixed(0).padStart(8)}`
    );
  }

  console.log("\n=== Re-verdict against the 10% DD gate (FTMO actual limit) ===");
  for (const a of aggs) {
    const xauTrades = all.filter((t) => t.algo === a.algo && t.ticker === "XAU/USD");
    if (xauTrades.length === 0) continue;
    const xauSum = xauTrades.reduce((s, x) => s + x.r, 0);
    const xauMean = xauTrades.length > 0 ? xauSum / xauTrades.length : 0;
    const xauDD = peakToTroughDDPct(xauTrades);
    const passes = xauTrades.length >= MIN_N_TRADES && xauMean > 0 && xauDD <= 10.0;
    const live = a.deployed ? "LIVE" : "    ";
    console.log(
      `  ${a.algo.padEnd(28)} ${live}  n=${String(xauTrades.length).padStart(4)} mean_R=${xauMean.toFixed(3).padStart(7)} DD=${xauDD.toFixed(2).padStart(5)}% ${passes ? "  ✓ PASS" : "  ✗ FAIL"}`
    );
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/discovery-per-algo-validation-${ts}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        tickers: TICKERS,
        validation_gate: { dd_threshold_pct: DD_THRESHOLD_PCT, min_n: MIN_N_TRADES, min_mean_r: MIN_MEAN_R },
        deployed_specs: Array.from(DEPLOYED_SPEC_KEYS),
        total_trades: all.length,
        aggs,
      },
      null,
      2
    )
  );
  console.log(`\nWrote ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
