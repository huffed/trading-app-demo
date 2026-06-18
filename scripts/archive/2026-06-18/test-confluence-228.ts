/* eslint-disable no-console */
/**
 * S1.5 priority #6 — empirical close of audit issue #228 sub-3
 * (pattern confluence/sequences).
 *
 * Friend-replay confluence test (extended replay-friend-trades.ts)
 * showed pairs of winner-disc primitives have higher WR than singles:
 *   daily_bias + fvg: 100% WR (7/7)
 *   fvg + equal_levels: 100% WR (7/7)
 *   ≥2 winner-discs: 72.7% WR vs baseline 57.9%
 *
 * Question for #228 close: does this confluence-lift hold in our 6yr
 * backtest, OR is the friend's edge specific to his trade selection?
 *
 * Test design — backtest 5 confluence variants on XAU/USD 4h:
 *   B0  fvg + daily_bias            (CURRENT FVG-DailyBias-Long 4h, baseline)
 *   B1  fvg + daily_bias + equal_levels (TRIPLE confluence — does it lift?)
 *   B2  fvg + daily_bias + sweep_reclaim (different 3rd primitive)
 *   B3  fvg + daily_bias + sweep_reclaim + equal_levels (QUAD)
 *   B4  fvg + equal_levels         (2-primitive without daily_bias)
 *
 * Each runs ungated, swing_anchor 0.10/4 + rr=2 (same geometry as
 * FVG-DailyBias-Long 4h). Compare: n trades, total R, mean R per
 * trade, win %, peak-to-trough DD.
 *
 * Confluence wins if: triple/quad variants have HIGHER mean R per
 * trade AND comparable DD (the higher trade quality compensates for
 * lower trade count). If they have LOWER mean R, confluence adds no
 * value at our scale.
 *
 * Usage:
 *   pnpm dlx tsx scripts/test-confluence-228.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import type { BacktestTrade, PriceBar } from "../src/lib/market-data/types";
import type { AlgorithmRules, EntryCondition } from "../src/types/algorithm";
import { loadCorpus } from "./llm-trader-backtest";

{
  try {
    const raw = readFileSync(".env.local", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.replace(/^['"]|['"]$/g, "");
    }
  } catch {
    /* ignore */
  }
}

const TICKERS = (process.env.TICKERS ?? "XAU/USD").split(",").map((s) => s.trim());
const CAPITAL = 100_000;
const RISK_PCT = 0.6;
const RISK_DOLLARS = (CAPITAL * RISK_PCT) / 100;
const CHUNK_DAYS = 90;
const DAY_MS = 86_400_000;
const RR = 2;
// Forex needs pct geometry (per PR #261 forex prep findings); gold needs swing_anchor.
// SL geometry resolves per ticker.
const FOREX_PCT_SL = 0.3;

interface Variant {
  key: string;
  description: string;
  conditions: EntryCondition[];
}

function cond(pattern: string, opts: Record<string, unknown> = {}): EntryCondition {
  return {
    type: "pattern" as const,
    pattern,
    direction: "bullish",
    timeframe: "4h",
    lookback: 5,
    ...opts,
  } as unknown as EntryCondition;
}

const VARIANTS: Variant[] = [
  {
    key: "B0_fvg+bias",
    description: "BASELINE: fvg + daily_bias (current FVG-DailyBias-Long 4h)",
    conditions: [
      cond("fvg"),
      cond("daily_bias", { ma_period: 20, lookback: undefined }),
    ],
  },
  {
    key: "B1_fvg+bias+eql",
    description: "TRIPLE: fvg + daily_bias + equal_levels (audit #228 main test)",
    conditions: [
      cond("fvg"),
      cond("daily_bias", { ma_period: 20, lookback: undefined }),
      cond("equal_levels"),
    ],
  },
  {
    key: "B2_fvg+bias+reclaim",
    description: "TRIPLE: fvg + daily_bias + liquidity_sweep_reclaim",
    conditions: [
      cond("fvg"),
      cond("daily_bias", { ma_period: 20, lookback: undefined }),
      cond("liquidity_sweep_reclaim"),
    ],
  },
  {
    key: "B3_quad",
    description: "QUAD: fvg + daily_bias + sweep_reclaim + equal_levels",
    conditions: [
      cond("fvg"),
      cond("daily_bias", { ma_period: 20, lookback: undefined }),
      cond("liquidity_sweep_reclaim"),
      cond("equal_levels"),
    ],
  },
  {
    key: "B4_fvg+eql",
    description: "PAIR: fvg + equal_levels (without daily_bias)",
    conditions: [
      cond("fvg"),
      cond("equal_levels"),
    ],
  },
];

function buildRules(ticker: string, v: Variant): AlgorithmRules {
  const isGold = ticker === "XAU/USD";
  return {
    entry_conditions: v.conditions,
    exit_conditions: [],
    entry_logic: "all",
    stop_loss: isGold
      ? { type: "swing_anchor", value: 0.1, lookback: 4 }
      : { type: "percentage", value: FOREX_PCT_SL },
    take_profit: { type: "rr_multiple", value: RR },
    position_sizing: { type: "risk_per_trade", value: RISK_PCT },
    max_positions: 1,
    leverage: 9,
    timeframe: "4h",
    asset_class: isGold ? "commodity" : "forex",
    side: "long",
    stagnant_exit: { enabled: true },
    prop_firm: { slippage_bps: 0.5, spread_bps: 0.4 },
  } as unknown as AlgorithmRules;
}

interface T {
  r: number;
  pnl: number;
  entry_date: string;
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

async function runVariant(ticker: string, v: Variant, bars: PriceBar[]): Promise<{
  ticker: string;
  key: string;
  description: string;
  n: number;
  win_pct: number;
  mean_r: number;
  total_r: number;
  total_dollars: number;
  dd_pct: number;
}> {
  const rules = buildRules(ticker, v);
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
    const m = runPortfolioBacktest(rules, new Map<string, PriceBar[]>([[ticker, chunk]]), CAPITAL, [], null, null);
    trades.push(...m.trades);
  }
  trades.sort((a, b) => new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime());
  const ts: T[] = trades.map((t) => ({ r: t.pnl / RISK_DOLLARS, pnl: t.pnl, entry_date: t.entry_date }));
  const n = ts.length;
  const wins = ts.filter((t) => t.r > 0).length;
  const total_r = ts.reduce((s, t) => s + t.r, 0);
  const mean_r = n > 0 ? total_r / n : 0;
  const total_dollars = ts.reduce((s, t) => s + t.pnl, 0);
  return {
    ticker,
    key: v.key,
    description: v.description,
    n,
    win_pct: n > 0 ? Number(((wins * 100) / n).toFixed(1)) : 0,
    mean_r: Number(mean_r.toFixed(3)),
    total_r: Number(total_r.toFixed(1)),
    total_dollars: Number(total_dollars.toFixed(0)),
    dd_pct: Number(peakDD(ts).toFixed(2)),
  };
}

async function main() {
  console.log("S1.5 #6 — pattern confluence test (audit #228 sub-3)\n");
  console.log(`Tickers: ${TICKERS.join(", ")}`);
  console.log(`Geometry: gold=swing_anchor 0.10/4, forex=percentage ${FOREX_PCT_SL}% + rr=${RR}\n`);

  const allResults = [];
  for (const ticker of TICKERS) {
    console.log(`\n## ${ticker}`);
    const c4 = await loadCorpus("4h", ticker);
    console.log(`Loaded ${c4.bars.length} 4h bars\n`);
    for (const v of VARIANTS) {
      process.stdout.write(`  Running ${v.key}... `);
      const r = await runVariant(ticker, v, c4.bars);
      allResults.push(r);
      console.log(`n=${r.n} mean_R=${r.mean_r} WR=${r.win_pct}% DD=${r.dd_pct}% $=${r.total_dollars}`);
    }
  }

  for (const ticker of TICKERS) {
    const results = allResults.filter((r) => r.ticker === ticker);
    console.log(`\n\n=== ${ticker} confluence test summary ===`);
    console.log("variant            description                                                            n     mean_R    WR%    $        DD%   ship?");
    console.log("-".repeat(150));
    const baseline = results.find((r) => r.key === "B0_fvg+bias")!;
    for (const r of results) {
      const ship = r.n >= 30 && r.total_r > 0 && r.dd_pct <= 10 ? "✓" : `${r.n < 30 ? "n<30" : ""}${r.total_r <= 0 ? " R≤0" : ""}${r.dd_pct > 10 ? " DD>10" : ""}`.trim();
      const meanRDelta = baseline.mean_r !== 0 ? `${((r.mean_r - baseline.mean_r) / Math.abs(baseline.mean_r) * 100).toFixed(0)}%` : "n/a";
      console.log(
        `${r.key.padEnd(18)} ${r.description.slice(0, 70).padEnd(72)} ${String(r.n).padStart(3)}  ${r.mean_r.toFixed(3).padStart(7)}  ${r.win_pct.toFixed(1).padStart(5)}  ${String(r.total_dollars).padStart(7)}  ${r.dd_pct.toFixed(2).padStart(5)}  ${ship.padEnd(8)}  (Δmean_R vs B0 = ${meanRDelta})`
      );
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/test-confluence-228-${stamp}.json`;
  writeFileSync(outPath, JSON.stringify({ baseline_key: "B0_fvg+bias", results: allResults }, null, 2));
  console.log(`\nSaved: ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
