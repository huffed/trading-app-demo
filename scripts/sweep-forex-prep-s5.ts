/* eslint-disable no-console */
/**
 * Forex prep for S5 (S1.5 priority #3).
 *
 * Goal per project_roadmap_2026_06: "port the per-algo validation +
 * cluster mining onto forex with FOREX-TUNED geometry (pct SL ~0.3-0.5%
 * instead of swing_anchor, different rr_multiples). Test whether
 * non-cluster expectancy flips positive."
 *
 * Context (per project_discovery_v1_findings V1.2 per-ticker decomp):
 *   - XAU non-cluster +0.05R (only positive)
 *   - EUR non-cluster -0.14R
 *   - GBP non-cluster -0.02R
 *   - JPY non-cluster -0.005R
 *
 * The V1.2 cluster signal IS portable cross-instrument (PR #255) — it's
 * the NON-cluster baseline that breaks on forex with gold-tuned
 * geometry. This sweep tests whether forex-tuned geometry (lower-pct SL
 * matched to forex's smaller per-bar moves) recovers the non-cluster
 * positive expectancy.
 *
 * Grid:
 *   pairs: EUR/USD, GBP/USD, USD/JPY
 *   strategies: coil_breakout (bos+daily_bias),
 *               dip_buyer (sweep+daily_bias),
 *               fvg_dailybias (fvg+daily_bias)
 *   geometry: swing_anchor 0.10/lb4 (gold baseline),
 *             percentage 0.30%,
 *             percentage 0.50%
 *   rr: 2, 3, 5
 *
 * Two variants per cell: ungated + V1.2 cluster gate enforced
 * (block_joint compressed ∩ discount ∩ london(7-13)).
 *
 * Total: 3 pairs × 3 strategies × 3 geometries × 3 rr × 2 variants = 162
 * backtests. Cost $0 (no LLM). ~12-15 min compute.
 *
 * Output: scripts/sweep-forex-prep-s5-<stamp>.json + on-stdout summary.
 *
 * Usage:
 *   pnpm dlx tsx scripts/sweep-forex-prep-s5.ts
 *   PAIR=EUR/USD pnpm dlx tsx scripts/sweep-forex-prep-s5.ts   # single pair
 */
import { readFileSync, writeFileSync } from "fs";
import { runWalkForward } from "../src/lib/market-data/walk-forward";
import type { MarketStateSeries } from "../src/lib/market-data/portfolio-backtest";
import type { PriceBar } from "../src/lib/market-data/types";
import type { AlgorithmRules, EntryCondition } from "../src/types/algorithm";
import type { MarketStateGate } from "../src/lib/algorithm/market-state-gate";
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
const TIMEFRAME = "4h";

const V12_CLUSTER_GATE: MarketStateGate = {
  mode: "block_joint",
  states: {
    range: ["compressed"],
    entry_zone: ["discount"],
    entry_hour_bucket: ["london(7-13)"],
  },
  on_unreadable: "allow",
};

const PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY"];
const STRATEGIES: { key: string; conditions: (tf: string) => EntryCondition[] }[] = [
  {
    key: "coil_breakout",
    conditions: (tf) => [
      { type: "pattern", pattern: "bos", direction: "bullish", lookback: 5, timeframe: tf },
      { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: tf },
    ],
  },
  {
    key: "dip_buyer",
    conditions: (tf) => [
      { type: "pattern", pattern: "liquidity_sweep", direction: "bullish", lookback: 5, timeframe: tf },
      { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: tf },
    ],
  },
  {
    key: "fvg_dailybias",
    conditions: (tf) => [
      { type: "pattern", pattern: "fvg", direction: "bullish", timeframe: tf },
      { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: tf },
    ],
  },
];

type GeometryKey = "sa-0.10/4" | "pct-0.30" | "pct-0.50";
const GEOMETRIES: { key: GeometryKey; build: () => AlgorithmRules["stop_loss"] }[] = [
  { key: "sa-0.10/4", build: () => ({ type: "swing_anchor", value: 0.1, lookback: 4 }) },
  { key: "pct-0.30", build: () => ({ type: "percentage", value: 0.3 }) },
  { key: "pct-0.50", build: () => ({ type: "percentage", value: 0.5 }) },
];

const RR_GRID = [2, 3, 5];

interface CellResult {
  pair: string;
  strategy: string;
  geometry: GeometryKey;
  rr: number;
  variant: "ungated" | "gated_v12";
  trades: number;
  total_return: number;
  green_pct: number;
  worst_dd: number;
  per_year: Record<string, { trades: number; return: number; green_pct: number; windows: number }>;
}

function makeRules(
  pair: string,
  strategy: (typeof STRATEGIES)[number],
  geometry: (typeof GEOMETRIES)[number],
  rr: number,
  gated: boolean
): AlgorithmRules {
  return {
    entry_conditions: strategy.conditions(TIMEFRAME),
    exit_conditions: [],
    entry_logic: "all",
    stop_loss: geometry.build(),
    take_profit: { type: "rr_multiple", value: rr },
    position_sizing: { type: "risk_per_trade", value: 0.6 },
    max_positions: 1,
    leverage: 9,
    timeframe: TIMEFRAME,
    asset_class: "forex",
    side: "long",
    stagnant_exit: { enabled: true },
    ...(gated ? { market_state_gate: V12_CLUSTER_GATE } : {}),
  } as AlgorithmRules;
}

async function runCell(
  pair: string,
  strategy: (typeof STRATEGIES)[number],
  geometry: (typeof GEOMETRIES)[number],
  rr: number,
  gated: boolean,
  bars: PriceBar[],
  series: MarketStateSeries
): Promise<CellResult> {
  const rules = makeRules(pair, strategy, geometry, rr, gated);
  const prices = new Map([[pair, bars]]);
  const summary = runWalkForward(rules, prices, CAPITAL, {
    testWindowDays: WINDOW_DAYS,
    stepDays: STEP_DAYS,
    marketStateSeries: gated ? series : null,
  });
  const traded = summary.windows.filter((w) => w.total_trades > 0);
  const green = traded.filter((w) => w.total_return > 0);
  const perYear: Record<string, { trades: number; return: number; green: number; windows: number }> = {};
  for (const w of summary.windows) {
    if (w.total_trades === 0) continue;
    const y = w.start.slice(0, 4);
    if (!perYear[y]) perYear[y] = { trades: 0, return: 0, green: 0, windows: 0 };
    perYear[y].trades += w.total_trades;
    perYear[y].return += w.total_return;
    perYear[y].windows += 1;
    if (w.total_return > 0) perYear[y].green += 1;
  }
  const perYearFinal: CellResult["per_year"] = {};
  for (const [y, v] of Object.entries(perYear)) {
    perYearFinal[y] = {
      trades: v.trades,
      return: Number(v.return.toFixed(0)),
      green_pct: Number(((v.green / v.windows) * 100).toFixed(0)),
      windows: v.windows,
    };
  }
  return {
    pair,
    strategy: strategy.key,
    geometry: geometry.key,
    rr,
    variant: gated ? "gated_v12" : "ungated",
    trades: summary.windows.reduce((s, w) => s + w.total_trades, 0),
    total_return: Number(summary.windows.reduce((s, w) => s + w.total_return, 0).toFixed(0)),
    green_pct: traded.length ? Number(((green.length / traded.length) * 100).toFixed(1)) : 0,
    worst_dd: Number(Math.max(0, ...summary.windows.map((w) => w.max_drawdown)).toFixed(2)),
    per_year: perYearFinal,
  };
}

async function main(): Promise<void> {
  const onlyPair = process.env.PAIR;
  const pairs = onlyPair ? PAIRS.filter((p) => p === onlyPair) : PAIRS;

  // Load 4h corpora per pair, plus a 1h corpus and EUR/USD 4h proxy for
  // state series. State series uses XAU 4h-frame conventions but we
  // need a shared market context for the gate; per-pair 1h corpus
  // suffices for entry_zone/entry_hour_bucket computation.
  const corpora = new Map<string, Corpus>();
  for (const pair of pairs) {
    console.log(`Loading ${pair} 4h corpus...`);
    const c = await loadCorpus("4h", pair);
    corpora.set(pair, c);
    console.log(`  ${pair}: ${c.bars.length} bars`);
  }

  const cells: CellResult[] = [];
  let cellNum = 0;
  const total = pairs.length * STRATEGIES.length * GEOMETRIES.length * RR_GRID.length * 2;

  for (const pair of pairs) {
    const corpus = corpora.get(pair)!;
    // For the gated runs the gate needs 1h-derived features (entry_zone,
    // entry_hour_bucket) AND a 4h-frame "range" / "mtf" reading. For
    // forex we reuse the 4h primary as the 4h source and resample or
    // skip 1h (on_unreadable:allow lets us through). We construct a
    // minimal series using the pair's own bars as both 4h and 1h —
    // imperfect but unblocked given OANDA 1h depth doesn't cover the
    // full 2020+ range either way.
    const series: MarketStateSeries = {
      bars4h: new Map([[pair, corpus.bars]]),
      oneHour: new Map([[pair, corpus.bars]]),
      daily: new Map([[pair, corpus.dailyBars]]),
      eurusd4h: corpus.eurusd4h,
    };

    for (const strategy of STRATEGIES) {
      for (const geometry of GEOMETRIES) {
        for (const rr of RR_GRID) {
          for (const gated of [false, true]) {
            cellNum += 1;
            const cell = await runCell(pair, strategy, geometry, rr, gated, corpus.bars, series);
            cells.push(cell);
            if (cellNum % 10 === 0) console.log(`  [${cellNum}/${total}] ${pair} ${strategy.key} ${geometry.key} rr=${rr} ${gated ? "gated" : "ungated"} trades=${cell.trades} ret=$${cell.total_return}`);
          }
        }
      }
    }
  }

  // Print per-pair summary tables: for each strategy + geometry + rr,
  // show ungated vs gated. Flag profitable cells.
  for (const pair of pairs) {
    console.log(`\n\n=== ${pair} ===`);
    console.log(`strategy        geom        rr | ungated trades→ret  | gated trades→ret    | non-cluster Δ`);
    console.log("-".repeat(110));
    for (const strategy of STRATEGIES) {
      for (const geometry of GEOMETRIES) {
        for (const rr of RR_GRID) {
          const ung = cells.find(
            (c) => c.pair === pair && c.strategy === strategy.key && c.geometry === geometry.key && c.rr === rr && c.variant === "ungated"
          )!;
          const gat = cells.find(
            (c) => c.pair === pair && c.strategy === strategy.key && c.geometry === geometry.key && c.rr === rr && c.variant === "gated_v12"
          )!;
          const deltaRet = gat.total_return - ung.total_return;
          const profitable = gat.total_return > 0 ? "✓" : " ";
          console.log(
            `${profitable} ${strategy.key.padEnd(14)} ${geometry.key.padEnd(11)} rr=${rr} | ${ung.trades.toString().padStart(4)} → $${ung.total_return.toString().padStart(7)} | ${gat.trades.toString().padStart(4)} → $${gat.total_return.toString().padStart(7)} | $${deltaRet.toString().padStart(6)}`
          );
        }
      }
    }
  }

  // Headline: per pair, the BEST profitable gated cell (non-cluster
  // expectancy). Answers the priority question directly.
  console.log("\n\n=== HEADLINE: best non-cluster expectancy per pair (gated_v12, sorted by return) ===");
  for (const pair of pairs) {
    const pairGated = cells.filter((c) => c.pair === pair && c.variant === "gated_v12");
    const best = [...pairGated].sort((a, b) => b.total_return - a.total_return)[0];
    if (!best || best.total_return <= 0) {
      console.log(`${pair.padEnd(10)}: NO profitable non-cluster cell. Best: ${best?.strategy ?? "n/a"} ${best?.geometry ?? "n/a"} rr=${best?.rr ?? "n/a"} ret=$${best?.total_return ?? 0}`);
      continue;
    }
    console.log(`${pair.padEnd(10)}: ${best.strategy} ${best.geometry} rr=${best.rr} → $${best.total_return} (${best.trades} trades, ${best.green_pct}% green, DD ${best.worst_dd}%)`);
    const years = Object.keys(best.per_year).sort();
    if (years.length > 0) {
      console.log(`           per-year: ${years.map((y) => `${y}=$${best.per_year[y].return}`).join(" | ")}`);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/sweep-forex-prep-s5-${stamp}.json`;
  writeFileSync(outPath, JSON.stringify({ cells }, null, 2));
  console.log(`\nSummary saved: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
