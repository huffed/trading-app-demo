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
 *   - Per bar: (a) check SL/TP fills on ALL open positions, (b) for each
 *     algo that fires this bar, build context → call LLM → apply decision
 *   - Risk-per-trade sizing per algo (full SL hit = riskPct% of capital)
 *   - Shared cash pool, positions tagged with algoId
 *
 * Status: Milestone 2 — LLM calls + decisions + per-bar SL/TP fills.
 * Skipped (Milestone 3): news veto, ATR liquidity gate, stagnant exit,
 * combined DLL halt enforcement, cross-algo position cap enforcement.
 *
 * Usage:
 *   PROVIDER=anthropic SLICE_DAYS=30 SLICE_END_DATE=2026-04-30 \
 *     pnpm dlx tsx scripts/multi-algo-backtest.ts
 *
 * Env (all optional):
 *   PROVIDER=anthropic       (default)
 *   SLICE_DAYS=30            (default)
 *   SLICE_END_DATE=2026-04-30
 *   CAPITAL=100000
 *   COMBINED_DLL_PCT=5       (logged but not enforced — Milestone 3)
 *   MAX_CONCURRENT_POS=3     (logged but not enforced — Milestone 3)
 */
import { readFileSync, writeFileSync } from "fs";
import {
  type Corpus,
  type OpenPosition,
  type ClosedTrade,
  type Regime,
  type Provider,
  type ProviderClients,
  type SlConfig,
  type TpConfig,
  ANTHROPIC_MODEL,
  loadCorpus,
  createClients,
  callLLMWithDiagnostic,
  type LlmFailType,
  computeSlForBacktest,
  computeTpForBacktest,
  summariseDailyBias,
  summariseRecentBars,
  summariseDxy,
  summariseIntermarket,
  summarisePosition,
  findExitOnNextBar,
  computeRMultiple,
} from "./llm-trader-backtest";
import { getPrompt, type PromptVersion } from "../src/lib/scan/llm-trader-prompts";
import { AI_MODEL } from "../src/lib/ai/client";

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
// Algo config
// ---------------------------------------------------------------------------

export interface AlgoConfig {
  algoId: string;
  label: string;
  timeframe: "4h" | "30m";
  promptVersion: PromptVersion;
  riskPerTradePct: number;
  maxPositions: number;
  sl: SlConfig;
  tp: TpConfig;
}

/** Default config matching the LIVE state on FTMO Demo $100K Swing. */
export const DEFAULT_CONFIGS: AlgoConfig[] = [
  {
    algoId: "v1_4h_swing",
    label: "Gold LLM-Trader v1 (4h)",
    timeframe: "4h",
    promptVersion: "v2",
    riskPerTradePct: 1.0,
    maxPositions: 1,
    sl: { type: "percentage", value: 0.015 },
    tp: { type: "percentage", value: 0.045 },
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
// Shared state
// ---------------------------------------------------------------------------

export interface TaggedPosition extends OpenPosition {
  algoId: string;
}

export interface SharedState {
  cash: number;
  capital: number;
  positions: TaggedPosition[];
  dailyRealizedPnL: Map<string, number>;
  unrealizedPnL: number;
  trades: Map<string, ClosedTrade[]>;
  combinedDllTrippedToday: string | null;
  llmCalls: number;
  llmFailures: number;
  /** Per-algo call/fail stats. Surfaces "v3 prompt parse-fails more than
   *  v2" patterns invisible in the global counter. */
  perAlgoStats: Map<string, { calls: number; fails: number; failsByType: Map<LlmFailType, number> }>;
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
    llmCalls: 0,
    llmFailures: 0,
    perAlgoStats: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Bar boundary check
// ---------------------------------------------------------------------------

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
// Per-bar SL/TP fill check across ALL open positions
// ---------------------------------------------------------------------------

function checkSlTpFills(state: SharedState, bar: PriceBar, barIdx: number): void {
  // Iterate from end so splice doesn't disturb iteration
  for (let i = state.positions.length - 1; i >= 0; i--) {
    const pos = state.positions[i];
    const exit = findExitOnNextBar(bar, pos);
    if (!exit.triggered) continue;
    const pnl =
      pos.side === "long"
        ? (exit.exit_price - pos.entry_price) * (pos.notional / pos.entry_price)
        : (pos.entry_price - exit.exit_price) * (pos.notional / pos.entry_price);
    state.cash += pnl;
    const dateKey = bar.date.slice(0, 10);
    state.dailyRealizedPnL.set(
      dateKey,
      (state.dailyRealizedPnL.get(dateKey) ?? 0) + pnl
    );
    const trade: ClosedTrade = {
      side: pos.side,
      entry_price: pos.entry_price,
      exit_price: exit.exit_price,
      entry_date: pos.entry_date,
      exit_date: bar.date,
      realized_pnl: pnl,
      exit_reason: exit.reason,
      hold_bars: barIdx - pos.entry_index,
      entry_reasoning: pos.entry_reasoning,
      exit_reasoning: "(price exit — SL/TP fill)",
      entry_regime: pos.entry_regime,
      exit_regime: pos.entry_regime, // approximate; full regime re-derive optional
      regime_flipped_during_trade: false,
      r_multiple: computeRMultiple(pos.side, pos.entry_price, pos.stop_price, exit.exit_price),
    };
    const algoTrades = state.trades.get(pos.algoId) ?? [];
    algoTrades.push(trade);
    state.trades.set(pos.algoId, algoTrades);
    state.positions.splice(i, 1);
  }
}

// ---------------------------------------------------------------------------
// Per-algo step — called when an algo's bar-close fires
// ---------------------------------------------------------------------------

import type { PriceBar } from "@/lib/market-data/types";
import type { EconomicEvent } from "@/lib/market-data/economic-calendar";

async function processAlgoAtBar(
  algo: AlgoConfig,
  state: SharedState,
  corpus: Corpus,
  windowBars: PriceBar[],
  windowBarIdx: number,
  globalBarIdx: number,
  provider: Provider,
  clients: ProviderClients
): Promise<void> {
  const bar = windowBars[windowBarIdx];
  // Find this algo's open position (if any). Multi-algo means each algo
  // tracks its own positions independently within the shared list.
  const algoPositions = state.positions.filter((p) => p.algoId === algo.algoId);
  const currentPos = algoPositions[0] ?? null;

  // Build LLM context — same shape as runWindow's per-bar context
  const dailyBefore = corpus.dailyBars.filter(
    (d) => new Date(d.date).getTime() <= new Date(bar.date).getTime()
  );
  const { summary: dailyContext, regime } = summariseDailyBias(dailyBefore);
  const recentContext = summariseRecentBars(corpus.bars, globalBarIdx, algo.timeframe);
  const dxyContext = summariseDxy(corpus.eurusd4h, bar.date);
  const intermarketContext = summariseIntermarket(corpus.intermarket, bar.close, bar.date);
  const positionContext = summarisePosition(currentPos, bar.close);
  const userMessage = `${bar.date.slice(0, 16)}\n${dailyContext}\n${dxyContext}\n${intermarketContext}\n${recentContext}\nPosition: ${positionContext}\nDecide.`;

  const systemPrompt = getPrompt(algo.promptVersion);

  state.llmCalls++;
  const algoStats = state.perAlgoStats.get(algo.algoId) ?? {
    calls: 0,
    fails: 0,
    failsByType: new Map<LlmFailType, number>(),
  };
  algoStats.calls++;
  const { decision, failType } = await callLLMWithDiagnostic(
    provider,
    clients,
    systemPrompt,
    userMessage
  );
  if (!decision) {
    state.llmFailures++;
    algoStats.fails++;
    if (failType) {
      algoStats.failsByType.set(failType, (algoStats.failsByType.get(failType) ?? 0) + 1);
    }
    state.perAlgoStats.set(algo.algoId, algoStats);
    return;
  }
  state.perAlgoStats.set(algo.algoId, algoStats);

  // Apply decision against shared state
  if ((decision.decision === "enter_long" || decision.decision === "enter_short") && !currentPos) {
    // Per-algo position cap
    if (algoPositions.length >= algo.maxPositions) return;
    // Cross-algo cap (informational for now; not enforced strictly)
    if (state.positions.length >= MAX_CONCURRENT_POS) return;

    const side = decision.decision === "enter_long" ? "long" : "short";
    const slDistance = computeSlForBacktest(corpus.bars, globalBarIdx, side, bar.close, algo.sl);
    if (slDistance <= 0) return; // degenerate — skip
    const tpDistance = computeTpForBacktest(slDistance, bar.close, algo.tp);
    const stopPrice = side === "long" ? bar.close - slDistance : bar.close + slDistance;
    const targetPrice = side === "long" ? bar.close + tpDistance : bar.close - tpDistance;
    // Risk-per-trade sizing: full SL hit = riskPct% of CURRENT shared cash
    const riskDollars = state.cash * (algo.riskPerTradePct / 100);
    const notional = (riskDollars * bar.close) / slDistance;

    const pos: TaggedPosition = {
      algoId: algo.algoId,
      side,
      entry_price: bar.close,
      entry_index: globalBarIdx,
      entry_date: bar.date,
      stop_price: stopPrice,
      target_price: targetPrice,
      notional,
      entry_reasoning: decision.reasoning,
      entry_regime: regime,
    };
    state.positions.push(pos);
  } else if (decision.decision === "exit" && currentPos) {
    const pnl =
      currentPos.side === "long"
        ? (bar.close - currentPos.entry_price) * (currentPos.notional / currentPos.entry_price)
        : (currentPos.entry_price - bar.close) * (currentPos.notional / currentPos.entry_price);
    state.cash += pnl;
    const dateKey = bar.date.slice(0, 10);
    state.dailyRealizedPnL.set(dateKey, (state.dailyRealizedPnL.get(dateKey) ?? 0) + pnl);
    const trade: ClosedTrade = {
      side: currentPos.side,
      entry_price: currentPos.entry_price,
      exit_price: bar.close,
      entry_date: currentPos.entry_date,
      exit_date: bar.date,
      realized_pnl: pnl,
      exit_reason: "llm_exit",
      hold_bars: globalBarIdx - currentPos.entry_index,
      entry_reasoning: currentPos.entry_reasoning,
      exit_reasoning: decision.reasoning,
      entry_regime: currentPos.entry_regime,
      exit_regime: regime,
      regime_flipped_during_trade: regime !== currentPos.entry_regime,
      r_multiple: computeRMultiple(currentPos.side, currentPos.entry_price, currentPos.stop_price, bar.close),
    };
    const algoTrades = state.trades.get(currentPos.algoId) ?? [];
    algoTrades.push(trade);
    state.trades.set(currentPos.algoId, algoTrades);
    state.positions = state.positions.filter((p) => p !== currentPos);
  }
  // hold → no-op
}

// ---------------------------------------------------------------------------
// Cross-algo limits (logged but not strictly enforced in milestone 2)
// ---------------------------------------------------------------------------

const COMBINED_DLL_PCT = Number(process.env.COMBINED_DLL_PCT ?? "5");
const MAX_CONCURRENT_POS = Number(process.env.MAX_CONCURRENT_POS ?? "3");

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const sliceEndStr = process.env.SLICE_END_DATE ?? new Date().toISOString().slice(0, 10);
  const sliceEndMs = new Date(`${sliceEndStr}T23:59:59Z`).getTime();
  const sliceDays = Number(process.env.SLICE_DAYS ?? "30");
  const capital = Number(process.env.CAPITAL ?? "100000");
  const provider = (process.env.PROVIDER ?? "anthropic") as Provider;
  if (provider !== "anthropic" && provider !== "groq") {
    throw new Error(`Unsupported PROVIDER=${provider}`);
  }

  console.log("Multi-algo backtest harness — MILESTONE 2");
  console.log(`  capital              : $${capital.toLocaleString()}`);
  console.log(`  slice                : ${sliceDays}d ending ${sliceEndStr}`);
  console.log(`  provider             : ${provider} (${provider === "anthropic" ? ANTHROPIC_MODEL : AI_MODEL})`);
  console.log(`  combined DLL halt    : ${COMBINED_DLL_PCT}% (informational)`);
  console.log(`  max concurrent pos   : ${MAX_CONCURRENT_POS}`);
  console.log(`  algos                :`);
  for (const a of DEFAULT_CONFIGS) {
    console.log(
      `    - ${a.label} · TF=${a.timeframe} · prompt=${a.promptVersion} · ${a.riskPerTradePct}% risk · max ${a.maxPositions} pos · SL=${a.sl.type}(${a.sl.value}) · TP=${a.tp.type}(${a.tp.value})`
    );
  }
  console.log("");

  // Load shared corpus (use 30m as the iteration cadence — finest TF)
  console.log("Loading shared corpus (30m)...");
  const corpus = await loadCorpus("30m");
  console.log(
    `  30m bars: ${corpus.bars.length} (${corpus.bars[0].date} → ${corpus.bars[corpus.bars.length - 1].date})`
  );

  // Slice to window
  const sliceStartMs = sliceEndMs - sliceDays * 24 * 3600 * 1000;
  const startIdx = corpus.bars.findIndex(
    (b) => new Date(b.date).getTime() > sliceStartMs
  );
  const endIdx = corpus.bars.findIndex((b) => new Date(b.date).getTime() > sliceEndMs);
  const lastIdx = endIdx === -1 ? corpus.bars.length : endIdx;
  if (startIdx === -1 || lastIdx <= startIdx) {
    console.log("\nNo bars in window — check SLICE_END_DATE and SLICE_DAYS");
    return;
  }
  const numBars = lastIdx - startIdx;
  console.log(`  in-window: ${numBars} bars (${corpus.bars[startIdx].date.slice(0, 10)} → ${corpus.bars[lastIdx - 1].date.slice(0, 10)})`);
  console.log("");

  const state = newSharedState(capital);
  const clients = createClients(provider);

  console.log(`Replaying ${numBars} bars with ${DEFAULT_CONFIGS.length} algos in parallel...`);

  for (let bi = startIdx; bi < lastIdx; bi++) {
    const windowBarIdx = bi - startIdx;
    const bar = corpus.bars[bi];

    // 1. Check SL/TP fills on all open positions BEFORE algo decisions
    //    (mirrors how live broker would fire SLs intra-bar)
    checkSlTpFills(state, bar, bi);

    // 2. For each algo that fires at this bar, process its decision
    for (const algo of DEFAULT_CONFIGS) {
      if (!shouldFireAt(algo, bar.date)) continue;
      await processAlgoAtBar(
        algo,
        state,
        corpus,
        corpus.bars,
        bi,
        bi,
        provider,
        clients
      );
    }

    // 3. Update unrealized PnL for the dashboard / DLL check
    let unreal = 0;
    for (const p of state.positions) {
      const pnl =
        p.side === "long"
          ? (bar.close - p.entry_price) * (p.notional / p.entry_price)
          : (p.entry_price - bar.close) * (p.notional / p.entry_price);
      unreal += pnl;
    }
    state.unrealizedPnL = unreal;

    // Progress logging every 50 bars
    if (windowBarIdx % 50 === 0 || bi === lastIdx - 1) {
      const totalTrades = Array.from(state.trades.values()).reduce(
        (s, arr) => s + arr.length,
        0
      );
      console.log(
        `  ${windowBarIdx}/${numBars} bars · cash $${Math.round(state.cash).toLocaleString()} · open ${state.positions.length} · closed ${totalTrades} · LLM ${state.llmCalls} (${state.llmFailures} fails)`
      );
    }
  }

  // Force-close any still-open positions at last bar
  if (state.positions.length > 0) {
    const lastBar = corpus.bars[lastIdx - 1];
    for (const pos of state.positions) {
      const pnl =
        pos.side === "long"
          ? (lastBar.close - pos.entry_price) * (pos.notional / pos.entry_price)
          : (pos.entry_price - lastBar.close) * (pos.notional / pos.entry_price);
      state.cash += pnl;
      const trade: ClosedTrade = {
        side: pos.side,
        entry_price: pos.entry_price,
        exit_price: lastBar.close,
        entry_date: pos.entry_date,
        exit_date: lastBar.date,
        realized_pnl: pnl,
        exit_reason: "llm_exit",
        hold_bars: lastIdx - 1 - pos.entry_index,
        entry_reasoning: pos.entry_reasoning,
        exit_reasoning: "(force-close at end of window)",
        entry_regime: pos.entry_regime,
        exit_regime: pos.entry_regime,
        regime_flipped_during_trade: false,
        r_multiple: computeRMultiple(pos.side, pos.entry_price, pos.stop_price, lastBar.close),
      };
      const algoTrades = state.trades.get(pos.algoId) ?? [];
      algoTrades.push(trade);
      state.trades.set(pos.algoId, algoTrades);
    }
    state.positions = [];
  }

  // ---- Reporting ----
  console.log("\n===== Multi-algo backtest complete =====");
  const finalPnl = state.cash - capital;
  const finalPct = (finalPnl / capital) * 100;
  console.log(`Final cash    : $${Math.round(state.cash).toLocaleString()} (${finalPnl >= 0 ? "+" : ""}$${Math.round(finalPnl).toLocaleString()}, ${finalPct >= 0 ? "+" : ""}${finalPct.toFixed(2)}%)`);
  console.log(`LLM calls     : ${state.llmCalls} (${state.llmFailures} fails, ${(100 * state.llmFailures / Math.max(state.llmCalls, 1)).toFixed(1)}%)`);

  // Per-algo fail-type breakdown — diagnostic for distinguishing
  // rate-limit (transient, retry helps) from parse-fail (prompt issue).
  console.log("\nPer-algo LLM diagnostics:");
  for (const algo of DEFAULT_CONFIGS) {
    const s = state.perAlgoStats.get(algo.algoId);
    if (!s) continue;
    const failPct = (100 * s.fails) / Math.max(s.calls, 1);
    const failBreakdown = Array.from(s.failsByType.entries())
      .map(([type, n]) => `${type}=${n}`)
      .join(" · ");
    console.log(
      `  ${algo.label}: ${s.calls} calls · ${s.fails} fails (${failPct.toFixed(1)}%) ${failBreakdown ? `· ${failBreakdown}` : ""}`
    );
  }

  console.log("\nPer-algo breakdown:");
  for (const algo of DEFAULT_CONFIGS) {
    const trades = state.trades.get(algo.algoId) ?? [];
    const wins = trades.filter((t) => t.realized_pnl > 0).length;
    const losses = trades.filter((t) => t.realized_pnl <= 0).length;
    const wr = trades.length > 0 ? (100 * wins) / trades.length : 0;
    const sumPnl = trades.reduce((s, t) => s + t.realized_pnl, 0);
    const sumR = trades.reduce((s, t) => s + t.r_multiple, 0);
    console.log(
      `  ${algo.label}: ${trades.length} trades · ${wins}W/${losses}L (${wr.toFixed(0)}% WR) · ${sumPnl >= 0 ? "+" : ""}$${Math.round(sumPnl).toLocaleString()} · ${sumR >= 0 ? "+" : ""}${sumR.toFixed(2)}R`
    );
  }

  // Save trade logs
  for (const algo of DEFAULT_CONFIGS) {
    const trades = state.trades.get(algo.algoId) ?? [];
    const path = `scripts/multi-algo-trades-${algo.algoId}-${sliceDays}d.jsonl`;
    writeFileSync(path, trades.map((t) => JSON.stringify(t)).join("\n"));
    console.log(`  trade log: ${path} (${trades.length} entries)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
