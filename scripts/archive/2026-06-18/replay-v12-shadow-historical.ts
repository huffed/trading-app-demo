/**
 * Historical replay of the V1.2 cluster gate across all 5 deployed
 * library algos that carry it (Bear-Short, Coil-1h, Dip-Buyer, FVG-Long
 * 30m, FVG-DailyBias-Long 4h). For each algo, runs the algo's entry
 * conditions through walk-forward TWICE — once with the V1.2 gate
 * enforced (shadow:false), once without — and reports:
 *
 *   1. How many trades the V1.2 gate would have blocked
 *   2. The per-year breakdown of blocks
 *   3. Whether the gate REDUCED or INCREASED total return (would-block
 *      trades' aggregate P&L vs without)
 *
 * This is the "get the data NOW" complement to the in-engine
 * shadow-telemetry fix (this PR). Live shadow events accumulate slowly
 * (n=0 in first ~48h across all 5 algos); the historical replay tells
 * us per-algo whether the V1.2 cluster gate is binding, useful, or
 * irrelevant — and whether it's worth flipping to enforce.
 *
 * Important coverage limit: the V1.2 cluster signature uses
 * entry_hour_bucket + entry_zone + range. The first needs 1h corpus
 * (post-2025-08-06 OANDA backfill); the rest need bar history that the
 * historical sim can compute. With `on_unreadable:allow` set on the
 * deployed gates, pre-Aug-2025 entries effectively pass through. This
 * sim INHERITS that fall-through behavior — early-corpus blocks=0 is
 * expected, not a sim bug.
 *
 * Usage:
 *   pnpm dlx tsx scripts/replay-v12-shadow-historical.ts            # all 5 algos
 *   ALGO=fvg_long_30m pnpm dlx tsx scripts/replay-v12-shadow-historical.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { runWalkForward } from "../src/lib/market-data/walk-forward";
import type { MarketStateSeries } from "../src/lib/market-data/portfolio-backtest";
import type { PriceBar } from "../src/lib/market-data/types";
import type { AlgorithmRules, EntryCondition } from "../src/types/algorithm";
import type { MarketStateGate, MarketStateGateConfig } from "../src/lib/algorithm/market-state-gate";
import { loadCorpus, type Corpus } from "./llm-trader-backtest";

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

const WINDOW_DAYS = 40;
const STEP_DAYS = 40;
const CAPITAL = 100_000;
const TICKER = "XAU/USD";

const V12_CLUSTER_GATE: MarketStateGate = {
  mode: "block_joint",
  states: {
    range: ["compressed"],
    entry_zone: ["discount"],
    entry_hour_bucket: ["london(7-13)"],
  },
  on_unreadable: "allow",
};

interface AlgoSpec {
  key: string;
  algo_name: string;
  timeframe: "4h" | "1h" | "30m";
  side: "long" | "short";
  rr: number;
  sl_lookback: number;
  entry_conditions: EntryCondition[];
  entry_logic?: "all" | "any";
  /** Extra hard clauses on the algo (Dip-Buyer / Bear-Short / Coil-Breakout
   *  4h carry pre-V1.2 gate clauses). Replicated faithfully so the
   *  baseline matches live. */
  extra_clauses?: NonNullable<Extract<MarketStateGateConfig, { clauses: unknown[] }>["clauses"]>;
}

const ALGOS: AlgoSpec[] = [
  {
    key: "bear_short_4h",
    algo_name: "Library: Gold Bear-Short Sentinel 4h",
    timeframe: "4h",
    side: "short",
    rr: 3,
    sl_lookback: 4,
    entry_conditions: [
      { type: "pattern", pattern: "bos", direction: "bearish", lookback: 5, timeframe: "4h" },
      { type: "pattern", pattern: "daily_bias", direction: "bearish", ma_period: 20, timeframe: "4h" },
    ],
    entry_logic: "all",
    extra_clauses: [{ mode: "allow", states: { mtf: ["aligned_LH"] }, on_unreadable: "block" }],
  },
  {
    key: "coil_breakout_1h",
    algo_name: "Library: Gold Coil-Breakout 1h",
    timeframe: "1h",
    side: "long",
    rr: 3,
    sl_lookback: 4,
    entry_conditions: [
      { type: "pattern", pattern: "bos", direction: "bullish", lookback: 5, timeframe: "1h" },
      { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "1h" },
    ],
    entry_logic: "all",
  },
  {
    key: "dip_buyer_4h",
    algo_name: "Library: Gold Dip-Buyer 4h",
    timeframe: "4h",
    side: "long",
    rr: 3,
    sl_lookback: 4,
    entry_conditions: [
      { type: "pattern", pattern: "liquidity_sweep", direction: "bullish", lookback: 5, timeframe: "4h" },
      { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "4h" },
    ],
    entry_logic: "all",
    extra_clauses: [
      {
        mode: "block",
        states: { dxy: ["usd_down"], mtf: ["fast_div_bull"] },
        on_unreadable: "allow",
      },
    ],
  },
  {
    key: "fvg_long_30m",
    algo_name: "Library: Gold FVG-Long 30m",
    timeframe: "30m",
    side: "long",
    rr: 3,
    sl_lookback: 3, // updated 2026-06-16 (PR #259)
    entry_conditions: [
      { type: "pattern", pattern: "fvg", direction: "bullish", timeframe: "30m" },
    ],
  },
  {
    key: "fvg_dailybias_long_4h",
    algo_name: "Library: Gold FVG-DailyBias-Long 4h",
    timeframe: "4h",
    side: "long",
    rr: 2, // chose rr=2 in PR #258
    sl_lookback: 4,
    entry_conditions: [
      { type: "pattern", pattern: "fvg", direction: "bullish", timeframe: "4h" },
      { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "4h" },
    ],
    entry_logic: "all",
  },
];

function makeRules(spec: AlgoSpec, includeV12: boolean): AlgorithmRules {
  const gate: MarketStateGateConfig | undefined = (() => {
    if (!includeV12 && !spec.extra_clauses) return undefined;
    if (!spec.extra_clauses) return V12_CLUSTER_GATE;
    if (!includeV12) {
      return spec.extra_clauses.length === 1
        ? spec.extra_clauses[0]
        : { clauses: spec.extra_clauses };
    }
    return { clauses: [...spec.extra_clauses, V12_CLUSTER_GATE] };
  })();

  return {
    entry_conditions: spec.entry_conditions,
    exit_conditions: [],
    stop_loss: { type: "swing_anchor", value: 0.1, lookback: spec.sl_lookback },
    take_profit: { type: "rr_multiple", value: spec.rr },
    position_sizing: { type: "risk_per_trade", value: 0.6 },
    max_positions: 1,
    leverage: 9,
    timeframe: spec.timeframe,
    asset_class: "commodity",
    side: spec.side,
    stagnant_exit: { enabled: true },
    ...(spec.entry_logic ? { entry_logic: spec.entry_logic } : {}),
    ...(gate ? { market_state_gate: gate } : {}),
  } as AlgorithmRules;
}

interface AlgoResult {
  algo: string;
  variant: "baseline" | "with_v12";
  trades: number;
  total_return: number;
  worst_dd: number;
  per_year: Record<string, { trades: number; return: number }>;
}

async function runVariant(
  spec: AlgoSpec,
  includeV12: boolean,
  bars: PriceBar[],
  series: MarketStateSeries | null
): Promise<AlgoResult> {
  const rules = makeRules(spec, includeV12);
  const prices = new Map([[TICKER, bars]]);
  const summary = runWalkForward(rules, prices, CAPITAL, {
    testWindowDays: WINDOW_DAYS,
    stepDays: STEP_DAYS,
    marketStateSeries: rules.market_state_gate ? series : null,
  });
  const perYear: Record<string, { trades: number; return: number }> = {};
  for (const w of summary.windows) {
    if (w.total_trades === 0) continue;
    const y = w.start.slice(0, 4);
    if (!perYear[y]) perYear[y] = { trades: 0, return: 0 };
    perYear[y].trades += w.total_trades;
    perYear[y].return += w.total_return;
  }
  return {
    algo: spec.key,
    variant: includeV12 ? "with_v12" : "baseline",
    trades: summary.windows.reduce((s, w) => s + w.total_trades, 0),
    total_return: Number(summary.windows.reduce((s, w) => s + w.total_return, 0).toFixed(0)),
    worst_dd: Number(Math.max(0, ...summary.windows.map((w) => w.max_drawdown)).toFixed(2)),
    per_year: Object.fromEntries(
      Object.entries(perYear).map(([y, v]) => [y, { trades: v.trades, return: Number(v.return.toFixed(0)) }])
    ),
  };
}

async function main(): Promise<void> {
  const onlyKey = process.env.ALGO;
  const targets = onlyKey ? ALGOS.filter((a) => a.key === onlyKey) : ALGOS;
  if (targets.length === 0) {
    throw new Error(`Unknown ALGO=${onlyKey}. Keys: ${ALGOS.map((a) => a.key).join(", ")}`);
  }

  const uniqueTfs = Array.from(new Set(targets.map((t) => t.timeframe)));
  const corpora = new Map<string, Corpus>();
  for (const tf of uniqueTfs) {
    console.log(`Loading XAU/USD ${tf} corpus...`);
    const c = await loadCorpus(tf);
    console.log(`  ${tf}: ${c.bars.length} bars (${c.bars[0]?.date.slice(0, 10)} → ${c.bars[c.bars.length - 1]?.date.slice(0, 10)})`);
    corpora.set(tf, c);
  }

  // For the gated runs we need MarketStateSeries. The gate features mtf/dxy
  // use 1h + EUR/USD; range/entry_zone/entry_hour_bucket use 4h bars +
  // current TF. We use the 4h corpus for state-series purposes regardless
  // of primary TF — matches live gate behavior (gate is 4h-frame).
  const corpus4h = corpora.get("4h") ?? (await loadCorpus("4h"));
  const corpus1h = corpora.get("1h") ?? (await loadCorpus("1h"));
  const series: MarketStateSeries = {
    bars4h: new Map([[TICKER, corpus4h.bars]]),
    oneHour: new Map([[TICKER, corpus1h.bars]]),
    daily: new Map([[TICKER, corpus4h.dailyBars]]),
    eurusd4h: corpus4h.eurusd4h,
  };

  const allResults: AlgoResult[] = [];
  for (const spec of targets) {
    console.log(`\n=== ${spec.algo_name} (${spec.timeframe}) ===`);
    const bars = corpora.get(spec.timeframe)!.bars;
    const baseline = await runVariant(spec, false, bars, series);
    const gated = await runVariant(spec, true, bars, series);
    allResults.push(baseline, gated);

    const blocked = baseline.trades - gated.trades;
    const deltaRet = gated.total_return - baseline.total_return;
    const blockPct = baseline.trades > 0 ? ((blocked / baseline.trades) * 100).toFixed(1) : "n/a";
    console.log(
      `  baseline: trades=${baseline.trades}  ret=$${baseline.total_return}  worstDD=${baseline.worst_dd}%`
    );
    console.log(
      `  with V1.2: trades=${gated.trades}  ret=$${gated.total_return}  worstDD=${gated.worst_dd}%`
    );
    console.log(
      `  V1.2 blocked ${blocked} trades (${blockPct}% of baseline); Δret=$${deltaRet} ${deltaRet > 0 ? "(GATE HELPED)" : deltaRet < 0 ? "(GATE HURT)" : "(NO EFFECT)"}`
    );

    const allYears = Array.from(new Set([...Object.keys(baseline.per_year), ...Object.keys(gated.per_year)])).sort();
    console.log(`  per-year delta (trades blocked / Δreturn):`);
    for (const y of allYears) {
      const b = baseline.per_year[y] ?? { trades: 0, return: 0 };
      const g = gated.per_year[y] ?? { trades: 0, return: 0 };
      const blockedY = b.trades - g.trades;
      const dRet = g.return - b.return;
      if (blockedY === 0 && dRet === 0) continue;
      console.log(`    ${y}: ${blockedY} blocked, Δret=$${dRet}`);
    }
  }

  console.log(`\n\n=== CROSS-ALGO SUMMARY ===`);
  console.log(`algo                                      | baseline trades→ret  | with V1.2 trades→ret | blocked | Δret    | verdict`);
  console.log("-".repeat(140));
  for (const spec of targets) {
    const b = allResults.find((r) => r.algo === spec.key && r.variant === "baseline")!;
    const g = allResults.find((r) => r.algo === spec.key && r.variant === "with_v12")!;
    const blocked = b.trades - g.trades;
    const deltaRet = g.total_return - b.total_return;
    const blockPct = b.trades > 0 ? ((blocked / b.trades) * 100).toFixed(0) : "0";
    let verdict = "no effect";
    if (blocked === 0) verdict = "no effect (0 binds)";
    else if (deltaRet > 0) verdict = `GATE HELPED (saved $${deltaRet})`;
    else if (deltaRet < 0) verdict = `gate HURT (cost $${-deltaRet})`;
    else verdict = "neutral";
    console.log(
      `${spec.algo_name.padEnd(40)} | ${b.trades.toString().padStart(4)} → $${b.total_return.toString().padStart(7)} | ${g.trades.toString().padStart(4)} → $${g.total_return.toString().padStart(7)} | ${blocked.toString().padStart(3)} (${blockPct.padStart(3)}%) | $${deltaRet.toString().padStart(6)} | ${verdict}`
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/replay-v12-shadow-${stamp}.json`;
  writeFileSync(outPath, JSON.stringify({ results: allResults }, null, 2));
  console.log(`\nSummary saved: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
