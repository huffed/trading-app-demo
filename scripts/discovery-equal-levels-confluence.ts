/**
 * Equal-levels confluence validation — does adding equal_levels as a
 * filter on top of liquidity_sweep entries meaningfully improve
 * expectancy? If yes, the primitive has tradeable value (and we can
 * pursue sweep+reclaim refinement / paper-algo deploy next). If no,
 * equal_levels is a structural primitive without empirical edge in
 * the V1.2 corpus.
 *
 * Method:
 *   For each ticker, run a backtest using `liquidity_sweep` as entry
 *   (V1.2 geometry: swing_anchor 0.1/4 SL, rr_multiple 3 TP). Each
 *   sweep entry is post-tagged with:
 *     - confluence_strict: detectEqualLevels fires at entry bar AND the
 *       swept_level matches an equal-levels cluster member within 0.1%
 *     - confluence_loose: detectEqualLevels fires at entry bar (any
 *       cluster, swept level not required to be member)
 *     - no_confluence: detectEqualLevels does not fire
 *
 *   Run both bullish (long-after-sell-side-sweep) and bearish
 *   (short-after-buy-side-sweep) — `feedback_direction_split_first`.
 *
 *   Compare R distributions and report per `feedback_dd_validation_gate`.
 *
 * Output: console table + scripts/discovery-equal-levels-confluence-<ts>.json
 *
 * Usage:
 *   pnpm dlx tsx scripts/discovery-equal-levels-confluence.ts
 *   TICKERS=XAU/USD pnpm dlx tsx scripts/discovery-equal-levels-confluence.ts
 */
import { writeFileSync } from "fs";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import type { MarketStateSeries } from "../src/lib/market-data/portfolio-backtest";
import type { BacktestTrade } from "../src/lib/market-data/types";
import type { AlgorithmRules } from "../src/types/algorithm";
import { detectLiquiditySweep } from "../src/lib/patterns/liquidity-sweep";
import { detectEqualLevels } from "../src/lib/patterns/equal-levels";
import { loadCorpus, type Corpus } from "./llm-trader-backtest";

const CAPITAL = 100_000;
const RISK_PCT = 0.6;
const RISK_DOLLARS = (CAPITAL * RISK_PCT) / 100;
const CHUNK_DAYS = 90;
const DAY_MS = 86_400_000;
const TICKERS = (process.env.TICKERS ?? "XAU/USD").split(",").map((s) => s.trim());
const FRICTION_SLIPPAGE_BPS = 0.5;
const FRICTION_SPREAD_BPS = 0.4;

function assetClassFor(ticker: string): "commodity" | "forex" {
  return ticker.startsWith("XAU") || ticker.startsWith("XAG") ? "commodity" : "forex";
}

function sweepOnlyRules(
  timeframe: "4h" | "1h" | "30m",
  side: "long" | "short",
  assetClass: "commodity" | "forex"
): AlgorithmRules {
  // direction convention: bullish sweep → long (sell-side raid)
  //                       bearish sweep → short (buy-side raid)
  const dir = side === "long" ? "bullish" : "bearish";
  return {
    entry_conditions: [
      { type: "pattern", pattern: "liquidity_sweep", direction: dir, lookback: 5, timeframe },
    ],
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

function findBarIdx(bars: { date: string }[], targetDate: string): number {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= targetDate) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

type Confluence = "strict" | "loose" | "none";

interface T {
  ticker: string;
  tf: "4h";
  side: "long" | "short";
  r: number;
  pnl: number;
  entry_date: string;
  confluence: Confluence;
}

async function processOne(ticker: string, side: "long" | "short"): Promise<T[]> {
  const ac = assetClassFor(ticker);
  console.log(`\n--- ${ticker} ${side.toUpperCase()} sweep ---`);
  const c4 = await loadCorpus("4h", ticker);
  const series: MarketStateSeries = {
    bars4h: new Map([[ticker, c4.bars]]),
    oneHour: new Map([[ticker, c4.bars]]),
    daily: new Map([[ticker, c4.dailyBars]]),
    eurusd4h: c4.eurusd4h,
  };
  const rules = sweepOnlyRules("4h", side, ac);
  // Run chunked backtest matching V1.2's pipeline.
  const bars = c4.bars;
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
    const m = runPortfolioBacktest(rules, new Map([[ticker, chunk]]), CAPITAL, [], null, series);
    trades.push(...m.trades);
  }
  trades.sort((a, b) => new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime());

  // Post-tag confluence.
  const direction = side === "long" ? "bullish" : "bearish";
  const out: T[] = [];
  for (const t of trades) {
    const entryIdx = findBarIdx(bars, t.entry_date);
    if (entryIdx < 0) continue;
    const eq = detectEqualLevels(bars, entryIdx, direction, { swingLookback: 5 });
    let confluence: Confluence = "none";
    if (eq.detected && eq.details) {
      const sw = detectLiquiditySweep(bars, entryIdx, 5);
      // strict: swept_level falls within the equal-levels cluster's
      // tolerance of cluster.level
      if (sw.detected && sw.details) {
        const tol = (eq.details.level * eq.details.tolerance_pct) / 100;
        if (Math.abs(sw.details.swept_level - eq.details.level) <= tol) confluence = "strict";
        else confluence = "loose";
      } else {
        confluence = "loose";
      }
    }
    out.push({
      ticker,
      tf: "4h",
      side,
      r: t.pnl / RISK_DOLLARS,
      pnl: t.pnl,
      entry_date: t.entry_date,
      confluence,
    });
  }
  console.log(`  → ${trades.length} trades`);
  return out;
}

function agg(rs: number[]) {
  if (rs.length === 0) return { n: 0, mean_r: 0, total_r: 0, win_pct: 0 };
  const sum = rs.reduce((s, x) => s + x, 0);
  const wins = rs.filter((x) => x > 0).length;
  return { n: rs.length, mean_r: sum / rs.length, total_r: sum, win_pct: (wins * 100) / rs.length };
}

function peakDD(trades: T[]): number {
  const sorted = [...trades].sort((a, b) => new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime());
  let eq = 0, peak = 0, dd = 0;
  for (const t of sorted) {
    eq += t.pnl;
    if (eq > peak) peak = eq;
    if (peak - eq > dd) dd = peak - eq;
  }
  return (dd / CAPITAL) * 100;
}

async function main() {
  console.log("Equal-levels confluence validation on liquidity_sweep entries");
  console.log(`Tickers: ${TICKERS.join(", ")}`);
  console.log("Question: does equal-levels confluence improve sweep expectancy?\n");

  const all: T[] = [];
  for (const tick of TICKERS) {
    all.push(...(await processOne(tick, "long")));
    all.push(...(await processOne(tick, "short")));
  }

  console.log(`\nTotal sweep trades: ${all.length}`);

  // Per side, per confluence bucket.
  for (const side of ["long", "short"] as const) {
    const sideTrades = all.filter((t) => t.side === side);
    if (sideTrades.length === 0) continue;
    console.log(`\n=== ${side.toUpperCase()} sweeps ===`);
    const baseline = agg(sideTrades.map((t) => t.r));
    const strict = agg(sideTrades.filter((t) => t.confluence === "strict").map((t) => t.r));
    const loose = agg(sideTrades.filter((t) => t.confluence === "loose").map((t) => t.r));
    const none = agg(sideTrades.filter((t) => t.confluence === "none").map((t) => t.r));
    console.log(`  baseline (all):       n=${String(baseline.n).padStart(4)}  mean_R=${baseline.mean_r.toFixed(3).padStart(7)}  win%=${baseline.win_pct.toFixed(1).padStart(5)}  total$=${(baseline.total_r * RISK_DOLLARS).toFixed(0).padStart(7)}  DD%=${peakDD(sideTrades).toFixed(2).padStart(5)}`);
    console.log(`  STRICT confluence:    n=${String(strict.n).padStart(4)}  mean_R=${strict.mean_r.toFixed(3).padStart(7)}  win%=${strict.win_pct.toFixed(1).padStart(5)}  total$=${(strict.total_r * RISK_DOLLARS).toFixed(0).padStart(7)}`);
    console.log(`  loose confluence:     n=${String(loose.n).padStart(4)}  mean_R=${loose.mean_r.toFixed(3).padStart(7)}  win%=${loose.win_pct.toFixed(1).padStart(5)}  total$=${(loose.total_r * RISK_DOLLARS).toFixed(0).padStart(7)}`);
    console.log(`  no confluence:        n=${String(none.n).padStart(4)}  mean_R=${none.mean_r.toFixed(3).padStart(7)}  win%=${none.win_pct.toFixed(1).padStart(5)}  total$=${(none.total_r * RISK_DOLLARS).toFixed(0).padStart(7)}`);
    const lift_strict = strict.n > 0 ? strict.mean_r - baseline.mean_r : 0;
    const lift_loose = loose.n > 0 ? loose.mean_r - baseline.mean_r : 0;
    console.log(`  lift (strict vs baseline): ${lift_strict >= 0 ? "+" : ""}${lift_strict.toFixed(3)}R`);
    console.log(`  lift (loose vs baseline):  ${lift_loose >= 0 ? "+" : ""}${lift_loose.toFixed(3)}R`);
  }

  // Verdict
  console.log("\n=== Verdict ===");
  for (const side of ["long", "short"] as const) {
    const sideTrades = all.filter((t) => t.side === side);
    if (sideTrades.length === 0) continue;
    const baseline = agg(sideTrades.map((t) => t.r));
    const strict = agg(sideTrades.filter((t) => t.confluence === "strict").map((t) => t.r));
    const lift = strict.n > 0 ? strict.mean_r - baseline.mean_r : 0;
    let verdict = "";
    if (strict.n < 20) verdict = "sample too small (n<20) — inconclusive";
    else if (lift > 0.15) verdict = "✓ STRICT confluence adds meaningful edge — primitive validated";
    else if (lift > 0.05) verdict = "marginal lift — borderline";
    else if (lift > -0.05) verdict = "no measurable lift — primitive doesn't help here";
    else verdict = "✗ confluence WORSENS expectancy — adverse selection";
    console.log(`  ${side.toUpperCase()}: baseline mean_R=${baseline.mean_r.toFixed(3)}, strict n=${strict.n} mean_R=${strict.mean_r.toFixed(3)}, lift ${lift >= 0 ? "+" : ""}${lift.toFixed(3)}R → ${verdict}`);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  writeFileSync(
    `scripts/discovery-equal-levels-confluence-${ts}.json`,
    JSON.stringify({
      generated_at: new Date().toISOString(),
      tickers: TICKERS,
      total_trades: all.length,
      per_side: ["long", "short"].map((side) => {
        const ts2 = all.filter((t) => t.side === side);
        return {
          side,
          baseline: agg(ts2.map((t) => t.r)),
          strict_confluence: agg(ts2.filter((t) => t.confluence === "strict").map((t) => t.r)),
          loose_confluence: agg(ts2.filter((t) => t.confluence === "loose").map((t) => t.r)),
          no_confluence: agg(ts2.filter((t) => t.confluence === "none").map((t) => t.r)),
          baseline_dd_pct: peakDD(ts2),
        };
      }),
    }, null, 2)
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
