/**
 * OTE standalone validation — does the OTE primitive (PR #238) produce
 * empirical trading edge?
 *
 * Background: equal-levels confluence test (PR #257) returned strongly
 * negative (-0.21R per trade). Two ICT primitives in a row (OTE in V1.2
 * mining + equal-levels here) failed to produce edge. This test is the
 * 2nd data point on "do ICT primitives systematically under-deliver in
 * our setup?"
 *
 * Method:
 *   OTE is itself an entry trigger (unlike equal-levels which is a
 *   target marker). So the direct test is: backtest OTE-as-entry with
 *   V1.2 geometry (swing_anchor 0.1/4 + rr_multiple 3) and measure
 *   standalone expectancy.
 *
 *   This is exactly what `Library: Gold OTE-Long 4h` (deployed earlier
 *   today, paper-only) would generate live — we're running it
 *   retroactively against historical corpus to validate (or invalidate)
 *   that deployment.
 *
 *   Per `feedback_direction_split_first`: both long (bullish OTE) and
 *   short (bearish OTE) tested.
 *
 * Decision criterion (`feedback_dd_validation_gate`):
 *   - mean_R > 0
 *   - DD ≤ 10% (FTMO challenge cap) on gold-only
 *   - n ≥ 30
 *
 * If PASS: the deployed OTE-Long 4h is justified by data.
 * If FAIL: OTE-Long 4h should be paused; 2 of 2 ICT primitives have
 *          failed → genuine pause on #245 sweep+reclaim.
 */
import { writeFileSync } from "fs";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import type { MarketStateSeries } from "../src/lib/market-data/portfolio-backtest";
import type { BacktestTrade } from "../src/lib/market-data/types";
import type { AlgorithmRules } from "../src/types/algorithm";
import { loadCorpus } from "./llm-trader-backtest";

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

function oteOnlyRules(side: "long" | "short", assetClass: "commodity" | "forex"): AlgorithmRules {
  const dir = side === "long" ? "bullish" : "bearish";
  return {
    entry_conditions: [
      { type: "pattern", pattern: "ote", direction: dir, lookback: 5, timeframe: "4h" },
    ],
    exit_conditions: [],
    stop_loss: { type: "swing_anchor", value: 0.1, lookback: 4 },
    take_profit: { type: "rr_multiple", value: 3 },
    position_sizing: { type: "risk_per_trade", value: RISK_PCT },
    max_positions: 1,
    leverage: 9,
    timeframe: "4h",
    asset_class: assetClass,
    side,
    stagnant_exit: { enabled: true },
    prop_firm: { slippage_bps: FRICTION_SLIPPAGE_BPS, spread_bps: FRICTION_SPREAD_BPS },
  } as unknown as AlgorithmRules;
}

interface T {
  ticker: string;
  side: "long" | "short";
  r: number;
  pnl: number;
  entry_date: string;
}

async function processOne(ticker: string, side: "long" | "short"): Promise<T[]> {
  const ac = assetClassFor(ticker);
  console.log(`\n--- ${ticker} ${side.toUpperCase()} OTE ---`);
  const c4 = await loadCorpus("4h", ticker);
  const series: MarketStateSeries = {
    bars4h: new Map([[ticker, c4.bars]]),
    oneHour: new Map([[ticker, c4.bars]]),
    daily: new Map([[ticker, c4.dailyBars]]),
    eurusd4h: c4.eurusd4h,
  };
  const rules = oteOnlyRules(side, ac);
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
  const out: T[] = trades.map((t) => ({
    ticker, side, r: t.pnl / RISK_DOLLARS, pnl: t.pnl, entry_date: t.entry_date,
  }));
  console.log(`  → ${trades.length} trades`);
  return out;
}

function agg(rs: number[]) {
  if (rs.length === 0) return { n: 0, mean_r: 0, total_r: 0, win_pct: 0 };
  const s = rs.reduce((a, x) => a + x, 0);
  const wins = rs.filter((x) => x > 0).length;
  return { n: rs.length, mean_r: s / rs.length, total_r: s, win_pct: (wins * 100) / rs.length };
}

function peakDD(ts: T[]): number {
  const sorted = [...ts].sort((a, b) => new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime());
  let eq = 0, peak = 0, dd = 0;
  for (const t of sorted) {
    eq += t.pnl;
    if (eq > peak) peak = eq;
    if (peak - eq > dd) dd = peak - eq;
  }
  return (dd / CAPITAL) * 100;
}

async function main() {
  console.log("OTE standalone validation — same V1.2 geometry as deployed OTE-Long 4h");
  console.log(`Tickers: ${TICKERS.join(", ")}\n`);

  const all: T[] = [];
  for (const tick of TICKERS) {
    all.push(...(await processOne(tick, "long")));
    all.push(...(await processOne(tick, "short")));
  }
  console.log(`\nTotal OTE trades: ${all.length}`);

  console.log("\n=== Per-side aggregate ===");
  for (const side of ["long", "short"] as const) {
    const ts = all.filter((t) => t.side === side);
    if (ts.length === 0) continue;
    const a = agg(ts.map((t) => t.r));
    const dd = peakDD(ts);
    console.log(`  ${side.toUpperCase()}: n=${String(a.n).padStart(4)}  mean_R=${a.mean_r.toFixed(3).padStart(7)}  win%=${a.win_pct.toFixed(1).padStart(5)}  total$=${(a.total_r * RISK_DOLLARS).toFixed(0).padStart(8)}  DD%=${dd.toFixed(2).padStart(5)}`);
  }

  console.log("\n=== Per-ticker per-side ===");
  for (const tick of TICKERS) {
    for (const side of ["long", "short"] as const) {
      const ts = all.filter((t) => t.ticker === tick && t.side === side);
      if (ts.length === 0) continue;
      const a = agg(ts.map((t) => t.r));
      const dd = peakDD(ts);
      console.log(`  ${tick.padEnd(10)} ${side.padEnd(5)}: n=${String(a.n).padStart(4)}  mean_R=${a.mean_r.toFixed(3).padStart(7)}  win%=${a.win_pct.toFixed(1).padStart(5)}  DD%=${dd.toFixed(2).padStart(5)}`);
    }
  }

  console.log("\n=== Verdict per validation gate (DD ≤ 10%, n ≥ 30, mean_R > 0) ===");
  for (const tick of TICKERS) {
    for (const side of ["long", "short"] as const) {
      const ts = all.filter((t) => t.ticker === tick && t.side === side);
      if (ts.length === 0) continue;
      const a = agg(ts.map((t) => t.r));
      const dd = peakDD(ts);
      const pass = a.n >= 30 && a.mean_r > 0 && dd <= 10;
      const reasons: string[] = [];
      if (a.n < 30) reasons.push(`n=${a.n}<30`);
      if (a.mean_r <= 0) reasons.push(`mean_R=${a.mean_r.toFixed(3)}≤0`);
      if (dd > 10) reasons.push(`DD=${dd.toFixed(2)}%>10%`);
      console.log(`  ${tick.padEnd(10)} ${side.padEnd(5)}: ${pass ? "✓ PASS" : "✗ FAIL"}${reasons.length > 0 ? "  (" + reasons.join("; ") + ")" : ""}`);
    }
  }

  // Save JSON.
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  writeFileSync(
    `scripts/discovery-ote-standalone-validation-${ts}.json`,
    JSON.stringify({
      generated_at: new Date().toISOString(),
      tickers: TICKERS,
      total_trades: all.length,
      per_side: ["long", "short"].map((side) => {
        const ts2 = all.filter((t) => t.side === side);
        return { side, ...agg(ts2.map((t) => t.r)), dd_pct: peakDD(ts2) };
      }),
      per_ticker_side: TICKERS.flatMap((tick) =>
        ["long", "short"].map((side) => {
          const ts2 = all.filter((t) => t.ticker === tick && t.side === side);
          return { ticker: tick, side, ...agg(ts2.map((t) => t.r)), dd_pct: peakDD(ts2) };
        })
      ),
    }, null, 2)
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
