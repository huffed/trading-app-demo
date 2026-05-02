/**
 * Walk-forward orchestrator for the LLM-trader. Runs N non-overlapping
 * windows against the cached XAU/USD corpus and reports per-window stats
 * + aggregated regime breakdown across all windows.
 *
 * Why this exists: the standard `runWalkForward` (lib/market-data/walk-forward)
 * walks pattern-detect entry_conditions through rolling windows. LLM-trader
 * has empty entry_conditions by design — the LLM determines entries — so
 * the standard WF engine fires zero trades and the readiness check shows
 * "0% windows green" not because the strategy fails but because the WF
 * engine can't exercise it.
 *
 * This orchestrator fixes that by walking the actual LLM through rolling
 * windows. Each window calls `runWindow()` with a different `sliceEndMs`,
 * collects the results, and aggregates:
 *
 *   - Per-window: trades, WR, return, max DD, regime mix
 *   - Across windows: % windows green (return > 0), mean WR, mean return,
 *     max DD across all windows
 *   - By entry-regime: WR / mean R / sum P&L for HH / LH / RANGING trades
 *   - Regime-flip cohort: WR for trades where the regime changed mid-trade
 *
 * Layer 1 of the learning loop: instrumentation. A failed window now
 * carries diagnosis (e.g. "windows 3 and 5 had transition regimes,
 * LH-while-long shorts didn't fire") instead of just a green/red verdict.
 *
 * Cost: 6 windows × 40d × 6 4h-bars/day = ~1,440 LLM calls.
 *   Anthropic Haiku: ~$1/run.
 *   Groq llama-70b free tier: 100K tokens/day cap means ~190 calls/day,
 *   so the full 1,440-call run is impossible on free tier — use Dev tier
 *   or the anthropic provider.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... PROVIDER=anthropic pnpm dlx tsx scripts/llm-trader-walk-forward.ts
 *
 * Env (optional):
 *   PROVIDER=anthropic         (default: anthropic — groq is rate-limited)
 *   TIMEFRAME=4h               (default: 4h)
 *   WINDOW_DAYS=40             (default: 40 — chosen to balance regime
 *                               diversity vs trade count per window)
 *   WINDOW_COUNT=6             (default: 6 — 6×40d = ~8mo coverage)
 *   END_DATE=2026-04-30        (default: now — most recent window ends here,
 *                               earlier windows step back from this date)
 *   CAPITAL=100000             (default: $100K)
 *   PROMPT_VERSION=v2          (default: v2 — current production. Use v1
 *                               to reproduce the validated baseline.)
 *   ALGO_ID=<uuid>             (optional — when set, also writes the WF
 *                               summary to the algorithm's
 *                               `llm_walk_forward_cache` column so
 *                               runReadinessCheck can use it without
 *                               re-running the LLM. Without ALGO_ID the
 *                               script only writes local JSON files.)
 *   PERSIST_DECISIONS_TO_DB=1  (optional, requires ALGO_ID — when set,
 *                               every per-bar decision is also written
 *                               to the `llm_decisions` table with
 *                               source='walk_forward'. The algorithm
 *                               detail page's Decisions section then
 *                               surfaces backtest decisions for review
 *                               with the same UI as live decisions.)
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import {
  type Corpus,
  type Provider,
  type Timeframe,
  type WindowResult,
  ANTHROPIC_MODEL,
  aggregateByRegime,
  aggregateByRegimeFlip,
  aggregateDecisionsByRegime,
  createClients,
  loadCorpus,
  runWindow,
} from "./llm-trader-backtest";
import { AI_MODEL } from "../src/lib/ai/client";
import { fetchEconomicCalendar } from "../src/lib/market-data/economic-calendar";
import {
  DEFAULT_PROMPT_VERSION,
  type PromptVersion,
} from "../src/lib/scan/llm-trader-prompts";

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

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

interface WindowSlot {
  index: number; // 1-based
  sliceEndMs: number;
  sliceEndDate: string; // YYYY-MM-DD
}

/** Build N non-overlapping windows ending at endDateMs, stepping back
 *  windowDays at a time. Index 1 = oldest, N = newest. */
function buildWindowGrid(
  endDateMs: number,
  windowDays: number,
  windowCount: number
): WindowSlot[] {
  const out: WindowSlot[] = [];
  const dayMs = 24 * 3600 * 1000;
  for (let i = 0; i < windowCount; i++) {
    // Newest window ends at endDateMs; each older window ends `windowDays` earlier.
    const sliceEndMs = endDateMs - i * windowDays * dayMs;
    const sliceEndDate = new Date(sliceEndMs).toISOString().slice(0, 10);
    out.push({
      index: windowCount - i, // newest = highest index
      sliceEndMs,
      sliceEndDate,
    });
  }
  // Oldest first for chronological reading.
  out.sort((a, b) => a.sliceEndMs - b.sliceEndMs);
  return out;
}

interface AggregateReport {
  windows: number;
  green_windows: number;
  green_pct: number;
  total_trades: number;
  mean_win_rate_pct: number;
  median_win_rate_pct: number;
  total_return: number;
  mean_return_per_window: number;
  max_drawdown_across_windows: number;
  total_llm_calls: number;
  total_llm_failures: number;
}

function aggregateAcrossWindows(results: WindowResult[]): AggregateReport {
  const greenWindows = results.filter((r) => r.finalCash - r.capital > 0);
  const totalTrades = results.reduce((s, r) => s + r.trades.length, 0);
  const winRates = results.map((r) => {
    const wins = r.trades.filter((t) => t.realized_pnl > 0).length;
    return r.trades.length === 0 ? 0 : (wins / r.trades.length) * 100;
  });
  const sortedWR = [...winRates].sort((a, b) => a - b);
  const median = sortedWR.length === 0 ? 0 : sortedWR[Math.floor(sortedWR.length / 2)];
  const totalReturn = results.reduce((s, r) => s + (r.finalCash - r.capital), 0);
  const maxDD = Math.max(...results.map((r) => r.maxDrawdown), 0);
  return {
    windows: results.length,
    green_windows: greenWindows.length,
    green_pct: results.length === 0 ? 0 : (greenWindows.length / results.length) * 100,
    total_trades: totalTrades,
    mean_win_rate_pct: winRates.length === 0 ? 0 : winRates.reduce((s, w) => s + w, 0) / winRates.length,
    median_win_rate_pct: median,
    total_return: totalReturn,
    mean_return_per_window: results.length === 0 ? 0 : totalReturn / results.length,
    max_drawdown_across_windows: maxDD,
    total_llm_calls: results.reduce((s, r) => s + r.llmCalls, 0),
    total_llm_failures: results.reduce((s, r) => s + r.llmFailures, 0),
  };
}

function printWindowTable(results: WindowResult[]): void {
  console.log("Per-window results (oldest → newest):");
  console.log(
    `  ${pad("#", 4)}${pad("end_date", 12)}${pad("trades", 8)}${pad("WR", 8)}${pad("return$", 12)}${pad("return%", 10)}${pad("DD%", 8)}${pad("LLM(fails)", 14)}`
  );
  for (const r of results) {
    const wins = r.trades.filter((t) => t.realized_pnl > 0).length;
    const wr = r.trades.length === 0 ? 0 : (wins / r.trades.length) * 100;
    const ret = r.finalCash - r.capital;
    const retPct = (ret / r.capital) * 100;
    const idxStr = r.windowLabel.split(" ")[0];
    const greenMarker = ret > 0 ? "✓" : ret < 0 ? "✗" : " ";
    console.log(
      `  ${pad(greenMarker, 4)}${pad(idxStr, 12)}${pad(r.trades.length.toString(), 8)}${pad(`${wr.toFixed(0)}%`, 8)}${pad(`$${ret.toFixed(0)}`, 12)}${pad(`${retPct >= 0 ? "+" : ""}${retPct.toFixed(2)}%`, 10)}${pad(`${r.maxDrawdown.toFixed(2)}%`, 8)}${pad(`${r.llmCalls}(${r.llmFailures})`, 14)}`
    );
  }
  console.log("");
}

function printAggregateReport(agg: AggregateReport): void {
  console.log("Walk-forward aggregate:");
  console.log(`  Windows                 : ${agg.windows}`);
  console.log(
    `  Green windows           : ${agg.green_windows}/${agg.windows} (${agg.green_pct.toFixed(0)}%)`
  );
  console.log(`  Total trades            : ${agg.total_trades}`);
  console.log(`  Mean WR (per window)    : ${agg.mean_win_rate_pct.toFixed(1)}%`);
  console.log(`  Median WR (per window)  : ${agg.median_win_rate_pct.toFixed(1)}%`);
  console.log(
    `  Total return            : $${agg.total_return.toFixed(0)} (${((agg.total_return / 100_000) * 100).toFixed(2)}% on $100K base)`
  );
  console.log(`  Mean return / window    : $${agg.mean_return_per_window.toFixed(0)}`);
  console.log(`  Max DD (worst window)   : ${agg.max_drawdown_across_windows.toFixed(2)}%`);
  console.log(`  Total LLM calls         : ${agg.total_llm_calls} (${agg.total_llm_failures} failures)`);
  console.log("");
}

async function main(): Promise<void> {
  const provider: Provider = (process.env.PROVIDER ?? "anthropic").toLowerCase() as Provider;
  if (provider !== "groq" && provider !== "anthropic") {
    throw new Error(`Unsupported PROVIDER=${provider}. Use groq or anthropic.`);
  }
  const timeframeRaw = (process.env.TIMEFRAME ?? "4h").toLowerCase();
  if (
    timeframeRaw !== "4h" &&
    timeframeRaw !== "1h" &&
    timeframeRaw !== "30m" &&
    timeframeRaw !== "15m"
  ) {
    throw new Error(`Unsupported TIMEFRAME=${timeframeRaw}. Use 4h / 1h / 30m / 15m.`);
  }
  const timeframe: Timeframe = timeframeRaw;
  const windowDays = Number(process.env.WINDOW_DAYS ?? "40");
  const windowCount = Number(process.env.WINDOW_COUNT ?? "6");
  const capital = Number(process.env.CAPITAL ?? "100000");
  const endDateStr = process.env.END_DATE;
  const endDateMs = endDateStr ? new Date(`${endDateStr}T23:59:59Z`).getTime() : Date.now();
  if (Number.isNaN(endDateMs)) throw new Error(`Invalid END_DATE=${endDateStr}`);

  const promptVersionRaw = (process.env.PROMPT_VERSION ?? DEFAULT_PROMPT_VERSION).toLowerCase();
  if (promptVersionRaw !== "v1" && promptVersionRaw !== "v2" && promptVersionRaw !== "v3") {
    throw new Error(`Unsupported PROMPT_VERSION=${promptVersionRaw}. Use v1, v2, or v3.`);
  }
  const promptVersion: PromptVersion = promptVersionRaw;

  const grid = buildWindowGrid(endDateMs, windowDays, windowCount);

  console.log("===== LLM-trader walk-forward =====");
  console.log(
    `Provider: ${provider} (model: ${provider === "anthropic" ? ANTHROPIC_MODEL : AI_MODEL})`
  );
  console.log(`Prompt:    ${promptVersion}`);
  console.log(`Timeframe: ${timeframe}`);
  console.log(`Capital per window: $${capital.toLocaleString()}`);
  console.log(`Windows: ${windowCount} × ${windowDays}d (non-overlapping, ending ${grid[grid.length - 1].sliceEndDate})`);
  console.log(
    `Coverage: ${grid[0].sliceEndDate} (− ${windowDays}d) → ${grid[grid.length - 1].sliceEndDate}`
  );
  const tfHoursPerBar = timeframe === "4h" ? 4 : timeframe === "1h" ? 1 : timeframe === "30m" ? 0.5 : 0.25;
  const estCallsPerWindow = Math.round((windowDays * 24) / tfHoursPerBar);
  const estCallsTotal = estCallsPerWindow * windowCount;
  const estTokens = estCallsTotal * 530;
  console.log(
    `Estimated cost: ~${estCallsTotal} LLM calls (~${(estTokens / 1000).toFixed(0)}K tokens). Anthropic Haiku ≈ $${((estTokens / 1_000_000) * 0.8).toFixed(2)}.`
  );
  if (provider === "groq" && estTokens > 100_000) {
    console.log(
      "  ⚠ Over Groq free-tier daily quota (100K tokens). Use ANTHROPIC or Dev tier."
    );
  }
  console.log("");

  // Load corpus once — Twelve Data + intermarket fetches are expensive.
  const corpus: Corpus = await loadCorpus(timeframe);
  const clients = createClients(provider);

  // Pre-fetch the economic calendar once across the full grid range so
  // each window doesn't hit Finnhub separately. Production-fidelity
  // backtest gate; news veto refuses entries inside ±15min windows of
  // tier-1 USD releases.
  const gridStartMs =
    grid[0].sliceEndMs - windowDays * 24 * 3600 * 1000;
  const gridEndMs = grid[grid.length - 1].sliceEndMs;
  console.log(
    `Pre-fetching economic calendar for ${new Date(gridStartMs).toISOString().slice(0, 10)} → ${new Date(gridEndMs).toISOString().slice(0, 10)}...`
  );
  const economicEvents = await fetchEconomicCalendar(
    new Date(gridStartMs),
    new Date(gridEndMs)
  );
  console.log(`  ${economicEvents.length} events loaded`);
  console.log("");

  // Run each window sequentially (LLM calls are I/O-bound but parallelism
  // would slam rate limits; sequential is the safer default).
  const results: WindowResult[] = [];
  for (const slot of grid) {
    console.log(
      `--- Window ${slot.index}/${windowCount}: ending ${slot.sliceEndDate} (back ${windowDays}d) ---`
    );
    const t0 = Date.now();
    const result = await runWindow({
      corpus,
      sliceEndMs: slot.sliceEndMs,
      sliceDays: windowDays,
      capital,
      provider,
      clients,
      promptVersion,
      economicEvents,
      silent: true,
    });
    const elapsedSec = Math.round((Date.now() - t0) / 1000);
    const wins = result.trades.filter((t) => t.realized_pnl > 0).length;
    const wr = result.trades.length === 0 ? 0 : (wins / result.trades.length) * 100;
    const ret = result.finalCash - result.capital;
    const gr = result.gateRefusals;
    const totalRefused =
      gr.atr_liquidity +
      gr.news_veto +
      gr.consec_loss_halt +
      gr.ftmo_consistency_halt;
    console.log(
      `  ${result.trades.length} trades · ${wr.toFixed(0)}% WR · $${ret.toFixed(0)} (${((ret / capital) * 100).toFixed(2)}%) · DD ${result.maxDrawdown.toFixed(2)}% · ${result.llmCalls} LLM calls (${result.llmFailures} fails) · ${elapsedSec}s`
    );
    if (totalRefused > 0 || gr.stagnant_exits > 0) {
      console.log(
        `    Gates: atr=${gr.atr_liquidity} news=${gr.news_veto} consec=${gr.consec_loss_halt} ftmo=${gr.ftmo_consistency_halt} · stagnant_exits=${gr.stagnant_exits}`
      );
    }
    results.push(result);
  }
  console.log("");

  // Cross-window report.
  console.log("===== Walk-forward summary =====");
  console.log("");
  printWindowTable(results);
  const agg = aggregateAcrossWindows(results);
  printAggregateReport(agg);

  // Per-regime breakdown across ALL trades from all windows. This is the
  // adaptation diagnostic — does the LLM's edge hold symmetrically across
  // HH / LH / RANGING regimes, or is it concentrated?
  const allTrades = results.flatMap((r) => r.trades);
  const allDecisions = results.flatMap((r) => r.decisions);
  console.log("Per-regime breakdown (all trades, all windows):");
  const regimeStats = aggregateByRegime(allTrades);
  console.log(
    `  ${pad("regime", 10)}${pad("trades", 8)}${pad("WR", 8)}${pad("mean_R", 9)}${pad("$pnl", 12)}${pad("long(W/T)", 12)}${pad("short(W/T)", 12)}`
  );
  for (const s of regimeStats) {
    console.log(
      `  ${pad(s.regime, 10)}${pad(s.count.toString(), 8)}${pad(`${s.win_rate_pct.toFixed(0)}%`, 8)}${pad(s.mean_r.toFixed(2), 9)}${pad(`$${s.sum_pnl.toFixed(0)}`, 12)}${pad(`${s.long_wins}/${s.long_count}`, 12)}${pad(`${s.short_wins}/${s.short_count}`, 12)}`
    );
  }
  console.log("");

  console.log("Regime-flip cohort (regime changed mid-trade?):");
  const flip = aggregateByRegimeFlip(allTrades);
  const fmtCohort = (label: string, c: { count: number; wins: number; mean_r: number; sum_pnl: number }) => {
    const wr = c.count === 0 ? 0 : (c.wins / c.count) * 100;
    console.log(
      `  ${pad(label, 16)}${pad(c.count.toString(), 8)}${pad(`${wr.toFixed(0)}%`, 8)}${pad(c.mean_r.toFixed(2), 9)}${pad(`$${c.sum_pnl.toFixed(0)}`, 12)}`
    );
  };
  console.log(`  ${pad("cohort", 16)}${pad("trades", 8)}${pad("WR", 8)}${pad("mean_R", 9)}${pad("$pnl", 12)}`);
  fmtCohort("flipped", flip.flipped);
  fmtCohort("not_flipped", flip.not_flipped);
  console.log("");

  console.log("LLM decision distribution per regime (all bars, all windows):");
  const decisionStats = aggregateDecisionsByRegime(allDecisions);
  console.log(
    `  ${pad("regime", 10)}${pad("enter_long", 12)}${pad("enter_short", 13)}${pad("hold", 8)}${pad("exit", 8)}`
  );
  for (const [regime, dist] of Object.entries(decisionStats)) {
    console.log(
      `  ${pad(regime, 10)}${pad((dist.enter_long ?? 0).toString(), 12)}${pad((dist.enter_short ?? 0).toString(), 13)}${pad((dist.hold ?? 0).toString(), 8)}${pad((dist.exit ?? 0).toString(), 8)}`
    );
  }
  console.log("");

  // Persist combined audit + summary for later inspection. Filename
  // includes prompt_version so v1 vs v2 runs don't collide.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fileBase = `${provider}-${timeframe}-${windowCount}x${windowDays}d-${promptVersion}-${stamp}`;
  const summaryPath = `scripts/llm-trader-wf-summary-${fileBase}.json`;
  const summaryDoc = {
    provider,
    model: provider === "anthropic" ? ANTHROPIC_MODEL : AI_MODEL,
    prompt_version: promptVersion,
    timeframe,
    window_days: windowDays,
    window_count: windowCount,
    end_date: endDateStr ?? new Date(endDateMs).toISOString().slice(0, 10),
    capital,
    aggregate: agg,
    per_window: results.map((r) => ({
      window_label: r.windowLabel,
      start_date: r.startDate,
      end_date: r.endDate,
      num_bars: r.numBars,
      trades: r.trades.length,
      wins: r.trades.filter((t) => t.realized_pnl > 0).length,
      return_usd: r.finalCash - r.capital,
      max_drawdown_pct: r.maxDrawdown,
      llm_calls: r.llmCalls,
      llm_failures: r.llmFailures,
      gate_refusals: r.gateRefusals,
    })),
    aggregate_gate_refusals: results.reduce(
      (acc, r) => ({
        atr_liquidity: acc.atr_liquidity + r.gateRefusals.atr_liquidity,
        news_veto: acc.news_veto + r.gateRefusals.news_veto,
        consec_loss_halt: acc.consec_loss_halt + r.gateRefusals.consec_loss_halt,
        ftmo_consistency_halt:
          acc.ftmo_consistency_halt + r.gateRefusals.ftmo_consistency_halt,
        stagnant_exits: acc.stagnant_exits + r.gateRefusals.stagnant_exits,
      }),
      {
        atr_liquidity: 0,
        news_veto: 0,
        consec_loss_halt: 0,
        ftmo_consistency_halt: 0,
        stagnant_exits: 0,
      }
    ),
    by_regime: regimeStats,
    flip_cohort: flip,
    decisions_by_regime: decisionStats,
  };
  writeFileSync(summaryPath, JSON.stringify(summaryDoc, null, 2));
  console.log(`Walk-forward summary saved: ${summaryPath}`);

  const tradesPath = `scripts/llm-trader-wf-trades-${fileBase}.jsonl`;
  writeFileSync(tradesPath, allTrades.map((t) => JSON.stringify(t)).join("\n"));
  console.log(`Combined trade log saved: ${tradesPath} (${allTrades.length} trades)`);

  // Per-window decision audit logs — full per-bar LLM responses for each
  // window. Lets us investigate "did the LLM see the regime flip" without
  // re-running. One JSONL per window so they're easy to pull individually.
  for (const r of results) {
    const winStamp = r.endDate.slice(0, 10);
    const decPath = `scripts/llm-trader-wf-decisions-${provider}-${timeframe}-${windowDays}d-${promptVersion}-${winStamp}.jsonl`;
    writeFileSync(decPath, r.decisions.map((d) => JSON.stringify(d)).join("\n"));
  }
  console.log(`Per-window decision logs saved: scripts/llm-trader-wf-decisions-...-${promptVersion}-<window-end>.jsonl (${results.length} files)`);

  // Build the readiness-cache shape — maps directly to the
  // WalkForwardSummary that runReadinessCheck consumes. The walkForwardCheck
  // function in src/lib/scan/readiness-check.ts reads .summary.* directly.
  const meanDdPerWindow = results.length === 0 ? 0 : results.reduce((s, r) => s + r.maxDrawdown, 0) / results.length;
  const cacheDoc = {
    generated_at: new Date().toISOString(),
    provider,
    model: provider === "anthropic" ? ANTHROPIC_MODEL : AI_MODEL,
    prompt_version: promptVersion,
    timeframe,
    window_days: windowDays,
    window_count: windowCount,
    end_date: endDateStr ?? new Date(endDateMs).toISOString().slice(0, 10),
    capital,
    summary: {
      total_windows: agg.windows,
      mean_win_rate: agg.mean_win_rate_pct,
      mean_return: agg.mean_return_per_window,
      mean_drawdown: meanDdPerWindow,
      win_rate_of_windows: agg.green_pct / 100,
      windows: results.map((r) => ({
        total_return: r.finalCash - r.capital,
        max_drawdown: r.maxDrawdown,
      })),
    },
  };

  // If ALGO_ID is set, also upload the cache to the algorithm's row so
  // runReadinessCheck can read it without re-running the LLM. Skipped
  // silently if no ALGO_ID — the local JSON file is enough for ad-hoc
  // analysis.
  const algoId = process.env.ALGO_ID;
  if (algoId) {
    await uploadCacheToAlgorithm(algoId, cacheDoc);
    if (process.env.PERSIST_DECISIONS_TO_DB === "1") {
      await persistDecisionsToDb(algoId, results, promptVersion, provider, cacheDoc.model);
    }
  } else {
    console.log("");
    console.log("(No ALGO_ID set — cache not uploaded. To populate the readiness check,");
    console.log(" re-run with ALGO_ID=<uuid> or write the cache from the saved summary file.)");
  }
}

/** Persist per-bar decisions from each WF window into the llm_decisions
 *  table with source='walk_forward'. The algorithm detail page's
 *  Decisions section then shows backtest decisions alongside live ones,
 *  using the same UI for review. */
async function persistDecisionsToDb(
  algoId: string,
  results: WindowResult[],
  promptVersion: PromptVersion,
  provider: Provider,
  model: string
): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error("PERSIST_DECISIONS_TO_DB set but Supabase env missing. Skipping.");
    return;
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Resolve user_id from the algorithm row (RLS scopes decisions by user_id).
  const { data: algoRow, error: algoErr } = await supabase
    .from("algorithms")
    .select("user_id, name")
    .eq("id", algoId)
    .single();
  if (algoErr || !algoRow) {
    console.error(`PERSIST_DECISIONS_TO_DB: algorithm ${algoId} not found:`, algoErr?.message);
    return;
  }
  const userId = (algoRow as { user_id: string }).user_id;

  const totalDecisions = results.reduce((s, r) => s + r.decisions.length, 0);
  console.log("");
  console.log(`Persisting ${totalDecisions} decisions to llm_decisions table (source=walk_forward)...`);

  let inserted = 0;
  for (const r of results) {
    const rows = r.decisions.map((d) => ({
      user_id: userId,
      algorithm_id: algoId,
      bar_date: d.bar_date,
      prompt_version: promptVersion,
      provider,
      model,
      regime: d.regime,
      decision: d.decision,
      confidence: d.confidence,
      reasoning: d.reasoning,
      context: { backtest_window: r.windowLabel },
      had_position: d.had_position === "long" || d.had_position === "short" ? d.had_position : "flat",
      paper_position_id: null,
      trade_outcome: null,
      source: "walk_forward",
    }));
    if (rows.length === 0) continue;
    const { error } = await supabase.from("llm_decisions").insert(rows);
    if (error) {
      console.error(`Window ${r.windowLabel}: insert failed: ${error.message}`);
      continue;
    }
    inserted += rows.length;
  }
  console.log(`  ${inserted}/${totalDecisions} decisions persisted.`);
}

interface CacheDoc {
  generated_at: string;
  provider: Provider;
  model: string;
  prompt_version: PromptVersion;
  timeframe: Timeframe;
  window_days: number;
  window_count: number;
  end_date: string;
  capital: number;
  summary: {
    total_windows: number;
    mean_win_rate: number;
    mean_return: number;
    mean_drawdown: number;
    win_rate_of_windows: number;
    windows: { total_return: number; max_drawdown: number }[];
  };
}

async function uploadCacheToAlgorithm(algoId: string, cache: CacheDoc): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error(
      "ALGO_ID set but NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in env. Cache NOT uploaded."
    );
    return;
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase
    .from("algorithms")
    .update({ llm_walk_forward_cache: cache })
    .eq("id", algoId)
    .select("id, name")
    .single();
  if (error || !data) {
    console.error(`Failed to upload WF cache to algorithm ${algoId}: ${error?.message ?? "unknown"}`);
    return;
  }
  const row = data as { id: string; name: string };
  console.log("");
  console.log(`WF cache uploaded to algorithm "${row.name}" (${row.id.slice(0, 8)}).`);
  console.log(`  ${cache.summary.total_windows} windows · ${cache.summary.mean_win_rate.toFixed(1)}% mean WR · ${(cache.summary.win_rate_of_windows * 100).toFixed(0)}% green · mean DD ${cache.summary.mean_drawdown.toFixed(2)}%`);
  console.log("Readiness check (/api/admin/readiness-check?id=...) will now use these stats for walk_forward_stability.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
