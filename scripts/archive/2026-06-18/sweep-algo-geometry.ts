/**
 * Generalized geometry sweep — runs RR×lookback grid for any deployed
 * library algo. Used for both pre-deploy validation (new algos) and
 * retroactive revalidation (existing deployed algos) per the 4-way
 * pre-deploy validation rule (see feedback_4_way_pre_deploy_validation).
 *
 * Each TARGET corresponds to a deployed `Library: %` algo (algo id
 * recorded for traceability). The sweep replays the deployed entry
 * conditions on the historical corpus under each {rr, lookback} cell.
 *
 * Grid (9 cells per target):
 *   RR multiple ∈ {2, 3, 5}
 *   SL lookback ∈ {3, 4, 6}   (SL value fixed at 0.10 buffer)
 *
 * Friction is opt-in via FRICTION_SLIPPAGE_BPS + FRICTION_SPREAD_BPS
 * (defaults 0 for frictionless baseline — matches library-walk-forward).
 *
 * Usage:
 *   pnpm dlx tsx scripts/sweep-algo-geometry.ts                       # all targets
 *   TARGET=fvg_dailybias_long_4h pnpm dlx tsx scripts/sweep-algo-geometry.ts
 *   FRICTION_SLIPPAGE_BPS=0.5 FRICTION_SPREAD_BPS=0.4 ...             # realistic gold friction
 */
import { readFileSync, writeFileSync } from "fs";
import { runWalkForward } from "../src/lib/market-data/walk-forward";
import type { PriceBar } from "../src/lib/market-data/types";
import type { AlgorithmRules, EntryCondition } from "../src/types/algorithm";
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
const RR_GRID = [2, 3, 5];
const LOOKBACK_GRID = [3, 4, 6];
const FRICTION_SLIPPAGE_BPS = Number(process.env.FRICTION_SLIPPAGE_BPS ?? 0);
const FRICTION_SPREAD_BPS = Number(process.env.FRICTION_SPREAD_BPS ?? 0);

interface Target {
  key: string;
  algo_name: string;
  algo_id: string;
  timeframe: "4h" | "1h" | "30m";
  side: "long" | "short";
  current_rr: number;
  current_lookback: number;
  entry_conditions: EntryCondition[];
  /** Optional logic combinator. Default "all" if multiple conditions. */
  entry_logic?: "all" | "any";
}

// Mirrors the 5 currently-deployed library algos as of 2026-06-16 PM
// (excluding FVG-DailyBias-Long 4h which was just validated). The
// entry_conditions exactly match what's in the algorithms.rules JSONB.
const TARGETS: Target[] = [
  {
    key: "fvg_long_30m",
    algo_name: "Library: Gold FVG-Long 30m",
    algo_id: "6d3c60f1-1775-4799-9b00-72931f618fe3",
    timeframe: "30m",
    side: "long",
    current_rr: 3,
    current_lookback: 4,
    entry_conditions: [
      { type: "pattern", pattern: "fvg", direction: "bullish", timeframe: "30m" },
    ],
  },
  {
    key: "coil_breakout_1h",
    algo_name: "Library: Gold Coil-Breakout 1h",
    algo_id: "unknown-1h", // not critical — algo_name is the key
    timeframe: "1h",
    side: "long",
    current_rr: 3,
    current_lookback: 4,
    entry_conditions: [
      { type: "pattern", pattern: "bos", direction: "bullish", lookback: 5, timeframe: "1h" },
      { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "1h" },
    ],
    entry_logic: "all",
  },
  {
    key: "coil_breakout_4h",
    algo_name: "Library: Gold Coil-Breakout 4h",
    algo_id: "unknown-4h",
    timeframe: "4h",
    side: "long",
    current_rr: 3,
    current_lookback: 4,
    entry_conditions: [
      { type: "pattern", pattern: "bos", direction: "bullish", lookback: 5, timeframe: "4h" },
      { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "4h" },
    ],
    entry_logic: "all",
  },
  {
    key: "dip_buyer_4h",
    algo_name: "Library: Gold Dip-Buyer 4h",
    algo_id: "unknown",
    timeframe: "4h",
    side: "long",
    current_rr: 3,
    current_lookback: 4,
    entry_conditions: [
      { type: "pattern", pattern: "liquidity_sweep", direction: "bullish", lookback: 5, timeframe: "4h" },
      { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "4h" },
    ],
    entry_logic: "all",
  },
  {
    key: "ote_long_4h",
    algo_name: "Library: Gold OTE-Long 4h",
    algo_id: "8cf42a49-4d61-457c-9163-0ed0fc4276d9",
    timeframe: "4h",
    side: "long",
    current_rr: 3,
    current_lookback: 4,
    entry_conditions: [
      { type: "pattern", pattern: "ote", direction: "bullish", timeframe: "4h" },
    ],
  },
];

interface Cell {
  rr: number;
  lookback: number;
  windows: number;
  windows_with_trades: number;
  green_pct: number;
  trades: number;
  total_ret: number;
  worst_dd: number;
  dd_breaches_gt5: number;
  per_year: Record<string, { trades: number; return: number; green_pct: number; windows: number }>;
}

function makeRules(target: Target, rr: number, lookback: number): AlgorithmRules {
  const rules: AlgorithmRules = {
    entry_conditions: target.entry_conditions,
    exit_conditions: [],
    stop_loss: { type: "swing_anchor", value: 0.1, lookback },
    take_profit: { type: "rr_multiple", value: rr },
    position_sizing: { type: "risk_per_trade", value: 0.6 },
    max_positions: 1,
    leverage: 9,
    timeframe: target.timeframe,
    asset_class: "commodity",
    side: target.side,
    stagnant_exit: { enabled: true },
    ...(target.entry_logic ? { entry_logic: target.entry_logic } : {}),
    ...(FRICTION_SLIPPAGE_BPS > 0 || FRICTION_SPREAD_BPS > 0
      ? {
          prop_firm: {
            slippage_bps: FRICTION_SLIPPAGE_BPS,
            spread_bps: FRICTION_SPREAD_BPS,
          },
        }
      : {}),
  } as AlgorithmRules;
  return rules;
}

async function sweepTarget(target: Target, bars: PriceBar[]): Promise<Cell[]> {
  const prices = new Map([[TICKER, bars]]);
  const cells: Cell[] = [];

  for (const rr of RR_GRID) {
    for (const lookback of LOOKBACK_GRID) {
      const rules = makeRules(target, rr, lookback);
      const summary = runWalkForward(rules, prices, CAPITAL, {
        testWindowDays: WINDOW_DAYS,
        stepDays: STEP_DAYS,
        marketStateSeries: null,
      });
      const traded = summary.windows.filter((w) => w.total_trades > 0);
      const green = traded.filter((w) => w.total_return > 0);
      const perYear: Record<string, { trades: number; return: number; green: number; windows: number }> = {};
      for (const w of summary.windows) {
        if (w.total_trades === 0) continue;
        const year = w.start.slice(0, 4);
        if (!perYear[year]) perYear[year] = { trades: 0, return: 0, green: 0, windows: 0 };
        perYear[year].trades += w.total_trades;
        perYear[year].return += w.total_return;
        perYear[year].windows += 1;
        if (w.total_return > 0) perYear[year].green += 1;
      }
      const perYearFinal: Cell["per_year"] = {};
      for (const [y, v] of Object.entries(perYear)) {
        perYearFinal[y] = {
          trades: v.trades,
          return: Number(v.return.toFixed(0)),
          green_pct: Number(((v.green / v.windows) * 100).toFixed(0)),
          windows: v.windows,
        };
      }
      cells.push({
        rr,
        lookback,
        windows: summary.total_windows,
        windows_with_trades: traded.length,
        green_pct: traded.length ? Number(((green.length / traded.length) * 100).toFixed(1)) : 0,
        trades: summary.windows.reduce((s, w) => s + w.total_trades, 0),
        total_ret: Number(summary.windows.reduce((s, w) => s + w.total_return, 0).toFixed(0)),
        worst_dd: Number(Math.max(0, ...summary.windows.map((w) => w.max_drawdown)).toFixed(2)),
        dd_breaches_gt5: summary.windows.filter((w) => w.max_drawdown > 5).length,
        per_year: perYearFinal,
      });
    }
  }
  return cells;
}

function printCells(target: Target, cells: Cell[]): void {
  console.log(`\n=== ${target.algo_name} (${target.timeframe}, ${target.entry_conditions.map((c) => `${c.type === "pattern" ? c.pattern : c.type}`).join("+")}) ===`);
  console.log(`Current geometry: rr=${target.current_rr} lb=${target.current_lookback}`);

  const sorted = [...cells].sort((a, b) => b.total_ret - a.total_ret);
  console.log("\nCells sorted by total return:");
  for (const c of sorted) {
    const ship = c.green_pct >= 60 && c.worst_dd <= 5 && c.dd_breaches_gt5 === 0 ? "  SHIP" : "      ";
    const current = c.rr === target.current_rr && c.lookback === target.current_lookback ? " ← CURRENT" : "";
    console.log(
      `${ship}  rr=${c.rr} lb=${c.lookback}  ret=$${c.total_ret.toString().padStart(7)}  green=${c.green_pct.toString().padStart(5)}%  trades=${c.trades.toString().padStart(3)}  worstDD=${c.worst_dd}%${current}`
    );
  }

  console.log("\nPer-year return ($):");
  const allYears = Array.from(new Set(cells.flatMap((c) => Object.keys(c.per_year)))).sort();
  console.log(`              ${allYears.map((y) => y.padStart(8)).join(" ")}`);
  for (const c of cells) {
    const row = allYears.map((y) => {
      const v = c.per_year[y];
      return v ? `$${v.return.toString().padStart(6)}` : "    -   ";
    });
    const tag = c.rr === target.current_rr && c.lookback === target.current_lookback ? " ←cur " : "      ";
    console.log(`rr=${c.rr} lb=${c.lookback}${tag} ${row.join(" ")}`);
  }
}

async function main(): Promise<void> {
  const onlyKey = process.env.TARGET;
  const targets = onlyKey ? TARGETS.filter((t) => t.key === onlyKey) : TARGETS;
  if (targets.length === 0) {
    throw new Error(`Unknown TARGET=${onlyKey}. Valid keys: ${TARGETS.map((t) => t.key).join(", ")}`);
  }

  console.log(`Targets: ${targets.length}, grid: ${RR_GRID.length}×${LOOKBACK_GRID.length}=${RR_GRID.length * LOOKBACK_GRID.length} cells each`);
  console.log(`Friction: slippage=${FRICTION_SLIPPAGE_BPS}bps spread=${FRICTION_SPREAD_BPS}bps`);

  // Load corpus once per unique timeframe used in the target set.
  const uniqueTfs = Array.from(new Set(targets.map((t) => t.timeframe)));
  const corpora = new Map<string, Corpus>();
  for (const tf of uniqueTfs) {
    console.log(`Loading XAU/USD ${tf} corpus...`);
    const c = await loadCorpus(tf);
    console.log(`  ${tf}: ${c.bars.length} bars (${c.bars[0]?.date.slice(0, 10)} → ${c.bars[c.bars.length - 1]?.date.slice(0, 10)})`);
    corpora.set(tf, c);
  }

  const allResults: Array<{ target: Target; cells: Cell[] }> = [];
  for (const target of targets) {
    const corpus = corpora.get(target.timeframe)!;
    const cells = await sweepTarget(target, corpus.bars);
    printCells(target, cells);
    allResults.push({ target, cells });
  }

  console.log("\n\n=== CROSS-ALGO SUMMARY: current vs best ===");
  console.log("algo                                     |  cur rr/lb  | cur ret  cur green | best rr/lb  | best ret  best green | delta");
  console.log("-".repeat(125));
  for (const { target, cells } of allResults) {
    const current = cells.find((c) => c.rr === target.current_rr && c.lookback === target.current_lookback);
    const best = [...cells].sort((a, b) => b.total_ret - a.total_ret)[0];
    if (!current || !best) continue;
    const delta = best.total_ret - current.total_ret;
    const pct = current.total_ret !== 0 ? ((delta / Math.abs(current.total_ret)) * 100).toFixed(0) : "n/a";
    const same = best.rr === current.rr && best.lookback === current.lookback ? " (already best)" : "";
    console.log(
      `${target.algo_name.padEnd(40)} | rr=${current.rr} lb=${current.lookback} | $${current.total_ret.toString().padStart(7)}  ${current.green_pct.toString().padStart(4)}%  | rr=${best.rr} lb=${best.lookback} | $${best.total_ret.toString().padStart(7)}  ${best.green_pct.toString().padStart(4)}%  | $${delta.toString().padStart(7)} (${pct}%)${same}`
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/sweep-algo-geometry-${stamp}.json`;
  writeFileSync(
    outPath,
    JSON.stringify({ friction: { slippage_bps: FRICTION_SLIPPAGE_BPS, spread_bps: FRICTION_SPREAD_BPS }, results: allResults }, null, 2)
  );
  console.log(`\nSummary saved: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
