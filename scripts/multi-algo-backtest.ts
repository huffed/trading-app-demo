/**
 * Multi-algo backtest harness — runs MULTIPLE LLM-trader algorithms
 * in parallel on a SHARED capital pool, simulating the live setup
 * where v1 (4h) + Intraday (30m) both run on the same FTMO Demo
 * broker connection.
 *
 * What this measures (that single-algo backtests don't):
 *   - Combined daily-loss behaviour (both algos contributing to one DLL)
 *   - Capital contention (when both want positions at once)
 *   - Cross-algo position-count limits
 *   - Realistic portfolio-level drawdown distribution
 *
 * Architecture:
 *   - Iterate at the finest timeframe across configured algos (30m by
 *     default since Intraday is finer than v1's 4h)
 *   - For each bar: determine which algos should fire ('isBarCloseScan'
 *     equivalent — v1 fires at 4h boundaries, Intraday every 30m)
 *   - Per algo: build context → call LLM → apply decision against
 *     shared cash + positions
 *   - Each tick: check SL/TP fills on ALL open positions, update
 *     unrealized P&L, run shared safety gates
 *
 * Status: Milestone 1 — scaffolding + iteration + stubbed decisions.
 * LLM calls + risk pooling + reporting fidelity coming in subsequent
 * milestones.
 *
 * Usage (when complete):
 *   pnpm dlx tsx scripts/multi-algo-backtest.ts
 *
 * Env (TBD):
 *   SLICE_DAYS=30
 *   SLICE_END_DATE=2026-04-30
 *   CAPITAL=100000
 *   PROVIDER=anthropic
 *   COMBINED_DLL_PCT=5      shared DLL halt across all algos
 *   MAX_CONCURRENT_POS=3    cross-algo position cap
 */
import { readFileSync } from "fs";
import {
  type Corpus,
  type OpenPosition,
  type ClosedTrade,
  type Regime,
  loadCorpus,
} from "./llm-trader-backtest";
import type { PromptVersion } from "../src/lib/scan/llm-trader-prompts";

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

// ---------------------------------------------------------------------------
// Algo config — what each algo runs as
// ---------------------------------------------------------------------------

export interface AlgoConfig {
  /** Stable identifier used for tagging positions, decisions, trades. */
  algoId: string;
  /** Display label shown in console output. */
  label: string;
  /** Bar cadence — algo only fires on these boundaries. */
  timeframe: "4h" | "30m";
  /** Prompt version to use. */
  promptVersion: PromptVersion;
  /** Per-trade risk as % of CURRENT shared capital (e.g. 1.0 = 1%). */
  riskPerTradePct: number;
  /** Max simultaneous positions held by THIS algo (per-algo cap, separate
   *  from the cross-algo MAX_CONCURRENT_POS). */
  maxPositions: number;
  /** SL config — supports fixed-% (legacy v1) or swing_anchor (Intraday). */
  sl: { type: "percentage"; value: number } | { type: "swing_anchor"; value: number; lookback: number };
  /** TP config — supports fixed-% or rr_multiple. */
  tp: { type: "percentage"; value: number } | { type: "rr_multiple"; value: number };
}

/** Default config matching the LIVE state on FTMO Demo $100K Swing
 *  (broker `11325c4b-...`). Override via env or programmatically when
 *  running with different scaling-plan configurations. */
export const DEFAULT_CONFIGS: AlgoConfig[] = [
  {
    algoId: "v1_4h_swing",
    label: "Gold LLM-Trader v1 (4h)",
    timeframe: "4h",
    promptVersion: "v2",
    riskPerTradePct: 1.0,
    maxPositions: 1,
    sl: { type: "percentage", value: 1.5 },
    tp: { type: "percentage", value: 4.5 },
  },
  {
    algoId: "intraday_30m",
    label: "Gold LLM-Intraday v1 (30m)",
    timeframe: "30m",
    promptVersion: "v3",
    riskPerTradePct: 1.0,
    maxPositions: 2,
    sl: { type: "swing_anchor", value: 0.25, lookback: 8 },
    tp: { type: "rr_multiple", value: 3 },
  },
];

// ---------------------------------------------------------------------------
// Shared state — cash + positions across all algos, daily P&L tracker
// ---------------------------------------------------------------------------

/** A position tagged with which algo opened it. The algoId is needed
 *  for per-algo metrics and for routing exits back through the right
 *  decision pipeline. */
export interface TaggedPosition extends OpenPosition {
  algoId: string;
}

export interface SharedState {
  cash: number;
  capital: number;
  positions: TaggedPosition[];
  /** Per-UTC-day P&L (realised + closed unrealised). Used by combined-DLL
   *  halt. Key format: "YYYY-MM-DD". */
  dailyRealizedPnL: Map<string, number>;
  /** Most recent unrealised P&L snapshot — recomputed each tick. */
  unrealizedPnL: number;
  /** Per-algo closed trades. Routed by algoId on close. */
  trades: Map<string, ClosedTrade[]>;
  /** Whether the combined-DLL halt has tripped this UTC day. */
  combinedDllTrippedToday: string | null; // null or the UTC date string of trip
}

export function newSharedState(capital: number): SharedState {
  return {
    cash: capital,
    capital,
    positions: [],
    dailyRealizedPnL: new Map(),
    unrealizedPnL: 0,
    trades: new Map(),
    combinedDllTrippedToday: null,
  };
}

// ---------------------------------------------------------------------------
// Bar boundary check — port of isBarCloseScan, adapted for backtest
// ---------------------------------------------------------------------------

/** Should the algo fire at this 30m bar? Returns true on bar-close
 *  boundaries matching the algo's timeframe. The harness iterates at
 *  30m granularity, so each algo's cadence is enforced here.
 *
 *  Examples (UTC):
 *    barDate = "2026-04-30T08:00:00Z" → 4h algo: TRUE (multiple of 4h)
 *                                       30m algo: TRUE (always on 30m boundary)
 *    barDate = "2026-04-30T08:30:00Z" → 4h algo: FALSE
 *                                       30m algo: TRUE
 */
export function shouldFireAt(algo: AlgoConfig, barDate: string): boolean {
  const d = new Date(barDate);
  const minute = d.getUTCMinutes();
  const hour = d.getUTCHours();
  if (algo.timeframe === "30m") {
    return minute === 0 || minute === 30;
  }
  if (algo.timeframe === "4h") {
    return minute === 0 && hour % 4 === 0;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Combined-DLL guard — single shared halt across all algos
// ---------------------------------------------------------------------------

const COMBINED_DLL_PCT = Number(process.env.COMBINED_DLL_PCT ?? "5");

/** Returns true if the combined day P&L (realised + unrealised across
 *  all algos) is at or below the negative DLL threshold. Idempotent —
 *  caller checks this before considering any new entries. */
export function isCombinedDllTripped(state: SharedState, utcDateKey: string): boolean {
  if (state.combinedDllTrippedToday === utcDateKey) return true;
  const realised = state.dailyRealizedPnL.get(utcDateKey) ?? 0;
  const totalDayPnl = realised + state.unrealizedPnL;
  const pctOfCapital = (totalDayPnl / state.capital) * 100;
  if (pctOfCapital <= -COMBINED_DLL_PCT) {
    state.combinedDllTrippedToday = utcDateKey;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Cross-algo position cap
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_POS = Number(process.env.MAX_CONCURRENT_POS ?? "3");

/** Returns true if the shared state already holds the cross-algo cap of
 *  open positions. Caller checks this before allowing a new entry. */
export function isAtPositionCap(state: SharedState): boolean {
  return state.positions.length >= MAX_CONCURRENT_POS;
}

// ---------------------------------------------------------------------------
// Main loop — Milestone 1 SCAFFOLDING ONLY
// ---------------------------------------------------------------------------

interface MainOptions {
  configs: AlgoConfig[];
  capital: number;
  sliceEndMs: number;
  sliceDays: number;
}

async function main(): Promise<void> {
  const sliceEndStr = process.env.SLICE_END_DATE ?? new Date().toISOString().slice(0, 10);
  const sliceEndMs = new Date(`${sliceEndStr}T23:59:59Z`).getTime();
  const sliceDays = Number(process.env.SLICE_DAYS ?? "30");
  const capital = Number(process.env.CAPITAL ?? "100000");

  const opts: MainOptions = {
    configs: DEFAULT_CONFIGS,
    capital,
    sliceEndMs,
    sliceDays,
  };

  console.log("Multi-algo backtest harness — MILESTONE 1 (scaffolding)");
  console.log(`  capital              : $${capital.toLocaleString()}`);
  console.log(`  slice                : ${sliceDays}d ending ${sliceEndStr}`);
  console.log(`  combined DLL halt    : ${COMBINED_DLL_PCT}%`);
  console.log(`  max concurrent pos   : ${MAX_CONCURRENT_POS}`);
  console.log(`  algos                :`);
  for (const a of opts.configs) {
    console.log(`    - ${a.label} · TF=${a.timeframe} · prompt=${a.promptVersion} · ${a.riskPerTradePct}% risk · max ${a.maxPositions} pos`);
  }
  console.log("");

  // Load corpora — both algos use XAU/USD with different timeframes.
  // Intraday's 30m corpus is the finest; v1 derives from resampled 30m.
  console.log("Loading corpus (30m for iteration cadence)...");
  const corpus = await loadCorpus("30m");
  console.log(`  30m bars: ${corpus.bars.length} (${corpus.bars[0].date} → ${corpus.bars[corpus.bars.length - 1].date})`);

  // Filter bars to slice window
  const sliceStartMs = sliceEndMs - sliceDays * 24 * 3600 * 1000;
  const windowBars = corpus.bars.filter((b) => {
    const t = new Date(b.date).getTime();
    return t > sliceStartMs && t <= sliceEndMs;
  });
  console.log(`  in-window: ${windowBars.length} bars`);

  if (windowBars.length === 0) {
    console.log("\nNo bars in window — check SLICE_END_DATE and SLICE_DAYS");
    return;
  }

  // Initialize shared state
  const state = newSharedState(capital);

  // Milestone 1 main loop: iterate, check fire conditions, log only
  // (no LLM call, no decision application yet — that's Milestone 2)
  console.log("\nIterating bars (Milestone 1 — fire-condition check only)...");
  let v1FireCount = 0;
  let intradayFireCount = 0;
  for (let i = 0; i < windowBars.length; i++) {
    const bar = windowBars[i];
    for (const algo of opts.configs) {
      if (!shouldFireAt(algo, bar.date)) continue;
      if (algo.timeframe === "4h") v1FireCount++;
      else if (algo.timeframe === "30m") intradayFireCount++;
    }
  }
  console.log(`\nFire counts (validates iteration cadence):`);
  console.log(`  v1 (4h):       ${v1FireCount} fires (expected: ~${Math.round(windowBars.length / 8)})`);
  console.log(`  Intraday (30m): ${intradayFireCount} fires (expected: ${windowBars.length})`);

  console.log(`\nShared state final:`);
  console.log(`  cash: $${state.cash.toLocaleString()} (start: $${state.capital.toLocaleString()})`);
  console.log(`  positions: ${state.positions.length}`);
  console.log(`  combined DLL tripped: ${state.combinedDllTrippedToday ?? "no"}`);
  console.log("\nMilestone 1 complete — iteration cadence verified.");
  console.log("Next: Milestone 2 — wire actual LLM calls + decision application.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
