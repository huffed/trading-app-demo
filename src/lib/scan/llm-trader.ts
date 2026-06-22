/**
 * LLM-trader — discretionary AI evaluator that replaces pattern-detect +
 * threshold for algos with `rules.llm_trader.enabled = true`.
 *
 * Architecture: every scan tick (4h-aligned for 4h algos), we build a
 * compressed market context (~530 tokens) and send it to the configured
 * LLM provider. The model returns a structured decision
 * (enter_long/short/hold/exit) which the scan engine routes through the
 * existing entry/exit pipelines + risk gates.
 *
 * Validated on Anthropic Haiku 4.5 across three non-overlapping 60d
 * historical windows (2025-10 → 2026-04): 20 trades, 65% WR, +20.2%,
 * 0.75% peak DD on XAU/USD 4h. Backtest harness lives at
 * `scripts/llm-trader-backtest.ts`; this module is the production port.
 *
 * Failure modes to watch in live (from backtest):
 *  - "Chase pattern" — entries within 0.3% of 20-bar extreme stop out
 *    ~50% of the time. Net statistically neutral (winners cancel losers
 *    near extremes), so accepted as known noise.
 *  - Anthropic API rate limits (Tier 1: 50 RPM, 50K input TPM). For
 *    1 algo × 6 calls/day = no risk. Multi-algo bursts need handling.
 *  - API failure rate ~9% on long backtest runs. Caller should retry
 *    once with backoff before giving up the bar.
 */
import { ANTHROPIC_HAIKU_MODEL, getAnthropicClient } from "@/lib/ai/anthropic-client";
import { AI_MODEL, getAIClient } from "@/lib/ai/client";
import type { PriceBar } from "@/lib/market-data/types";
import { DEFAULT_PROMPT_VERSION, getPrompt } from "@/lib/scan/llm-trader-prompts";
import type { AlgorithmRules } from "@/types/algorithm";
// CB.H1 pass 15 (2026-06-22): provider call layer + context summarisers
// extracted to sibling modules.
import { callAnthropic, callGroq } from "./llm-trader-providers";
import {
  summariseDailyBias,
  summariseDxy,
  summariseHigherTfStructure,
  summariseIntermarket,
  summarisePosition,
  summariseRecentBars,
} from "./llm-trader-summarisers";

// Re-export for backward compatibility with any external callers /
// scripts that import the V1 constant directly.
export { LLM_TRADER_PROMPT_V1 } from "@/lib/scan/llm-trader-prompts";

export interface LlmTraderDecision {
  decision: "enter_long" | "enter_short" | "hold" | "exit" | "move_be";
  confidence: number;
  reasoning: string;
}

/** D1-structure regime tag derived from HH/LH price action. The same
 *  tag the LLM sees in its daily-bias context line. Threaded out so
 *  the audit log can record what regime drove each decision without
 *  re-deriving it. */
export type Regime = "HH" | "LH" | "RANGING" | "n/a";

/** Full evaluation result. Returns the LLM decision (null on retry-
 *  exhausted failure), the regime as the LLM saw it, and the exact
 *  user message that was sent — useful for the decision audit log. */
export interface LlmTraderEvaluation {
  decision: LlmTraderDecision | null;
  regime: Regime;
  userMessage: string;
  promptVersion: string;
  provider: "anthropic" | "groq";
  model: string;
}

export interface LlmTraderContext {
  /** ISO timestamp of the bar being evaluated. */
  currentTimestamp: string;
  /** Recent primary-TF bars (last 20+, oldest → newest). The current bar
   *  is the last one. */
  bars: PriceBar[];
  /** Daily bars for D1 bias. Last bar should be at-or-before currentTimestamp. */
  dailyBars: PriceBar[];
  /** EUR/USD proxy bars for DXY context. Optional. */
  dxyBars?: PriceBar[] | null;
  /** Intermarket context. Each is optional; missing ones are skipped. */
  intermarket?: {
    silver?: PriceBar[];
    yield10y?: PriceBar[];
    vix?: PriceBar[];
  };
  /** Currently open position state, if any. */
  position?: {
    side: "long" | "short";
    entryPrice: number;
    entryDate: string;
    stopPrice?: number;
    /** Entry-time SL — used for R-multiple math so a BE-moved stop
     *  doesn't make R look infinite. Falls back to stopPrice when
     *  absent (legacy rows pre-migration 00032). */
    initialStopPrice?: number;
    targetPrice?: number;
  } | null;
  /** Primary timeframe label for the prompt (e.g. "4h"). */
  timeframe: string;
  /** Layer 3 in-context reflection — pre-formatted summary of the algo's
   *  recent track record by regime. When provided, the prompt context
   *  surfaces "your last 20 trades: 30% WR overall, LH-short at 36%,
   *  HH-long at 20%" so the LLM can dynamically adjust conviction.
   *  Pass null/undefined to skip (e.g. <10 trades exist yet). */
  recentOutcomes?: string | null;
  /** Higher-TF bars for multi-TF structural context. Lets the LLM see
   *  whether faster TFs have flipped regime ahead of D1's lagging
   *  14-day window. For Intraday (30m primary) this would be 1h and 4h.
   *  For v1 (4h primary) this would be daily — but daily is already
   *  surfaced via dailyBars + summariseDailyBias, so v1 typically
   *  passes nothing here. Each entry's bars must be ordered oldest →
   *  newest with the most recent bar at-or-before currentTimestamp.
   *  Omitted/empty → multi-TF section silently skipped. v5 prompt
   *  expects this to be present; v3/v4 ignore it gracefully. */
  higherTfBars?: { tfLabel: string; bars: PriceBar[] }[];
}

// ---------------------------------------------------------------------------
// Context builders — port from scripts/llm-trader-backtest.ts. Compressed to
// ~530 tokens/call (vs ~1400 in the verbose version that was too cliché-prone).
// ---------------------------------------------------------------------------

/** Build the user-message context string + capture the regime tag.
 *  ~430 tokens typical. Regime is returned alongside so the audit log
 *  can record it without re-deriving. */
export function buildLlmTraderContext(ctx: LlmTraderContext): {
  userMessage: string;
  regime: Regime;
} {
  const idx = ctx.bars.length - 1;
  const cur = ctx.bars[idx];
  const dailyBefore = ctx.dailyBars.filter(
    (d) => new Date(d.date).getTime() <= new Date(ctx.currentTimestamp).getTime()
  );
  const { summary: dailyContext, regime } = summariseDailyBias(dailyBefore);
  const recentContext = summariseRecentBars(ctx.bars, idx, ctx.timeframe);
  const dxyContext = summariseDxy(ctx.dxyBars, ctx.currentTimestamp);
  const intermarketContext = summariseIntermarket(ctx.intermarket, cur.close, ctx.currentTimestamp);
  const positionContext = summarisePosition(ctx.position ?? null, cur.close);
  // Multi-TF structural read — only emitted if caller provided higherTfBars.
  // The v5 prompt expects this; older prompts ignore it.
  const higherTfContext = ctx.higherTfBars && ctx.higherTfBars.length > 0
    ? summariseHigherTfStructure(ctx.higherTfBars, ctx.currentTimestamp)
    : "";
  const higherTfLine = higherTfContext ? `\n${higherTfContext}` : "";
  // Layer 3 reflection: include recent-outcomes summary when provided.
  // Self-gates (caller passes null when <10 trades exist), so the
  // section is silently omitted during the warm-up phase.
  const reflectionLine = ctx.recentOutcomes ? `\n${ctx.recentOutcomes}` : "";
  const userMessage = `${ctx.currentTimestamp.slice(0, 16)}\n${dailyContext}\n${dxyContext}\n${intermarketContext}\n${recentContext}${higherTfLine}\nPosition: ${positionContext}${reflectionLine}\nDecide.`;
  return { userMessage, regime };
}

/**
 * Throttle gate: returns true on scan ticks that should trigger an LLM
 * evaluation. The scan-cron runs every 15 min; without this gate the LLM
 * would be called every tick. The throttle fires once per primary-TF
 * worth of wall-clock (one tick per 4h, per 1h, etc.), so each call sees
 * exactly one new closed bar relative to the previous call.
 *
 * IMPORTANT — this does NOT align with OANDA bar boundaries. OANDA's
 * default H4 alignment for gold is NY 17:00 (`dailyAlignment=17`,
 * `alignmentTimezone=America/New_York` per OANDA defaults; the OANDA
 * client passes no overrides). In practice that means:
 *   - EDT (summer): bars open at 01/05/09/13/17/21 UTC, close at 05/09/13/17/21/01
 *   - EST (winter): bars open at 02/06/10/14/18/22 UTC, close at 06/10/14/18/22/02
 * The gate below fires at UTC `hour % 4 === 0` regardless of season, so the
 * LLM call happens 2-3 hours AFTER the actual bar close. This is fine — the
 * LLM gets `currentTimestamp = bars[bars.length-1].date` (the bar's open
 * time) so its decision-input is identical to what the backtest harness
 * feeds it. Live and harness see the same view; only the wall-clock
 * moment of the call differs. See investigation notes 2026-06-15.
 *
 * Returns true if "now" is within the first 15 minutes after a wall-clock
 * UTC multiple of the timeframe's duration. Forex/gold markets close at
 * UTC midnight so daily uses 00:00 UTC.
 */
export function isBarCloseScan(timeframe: string, now: Date = new Date()): boolean {
  const minute = now.getUTCMinutes();
  const hour = now.getUTCHours();
  const tf = timeframe.toLowerCase();
  switch (tf) {
    case "4h":
      // Wall-clock gate at 00/04/08/12/16/20 UTC (NOT OANDA bar boundaries
      // — see the IMPORTANT note in the docstring above). Each tick the
      // most-recent-closed 4h bar advances by one.
      return minute < 15 && hour % 4 === 0;
    case "1h":
      // Hourly bars close every :00
      return minute < 15;
    case "30m":
      return minute < 15 || (minute >= 30 && minute < 45);
    case "15m":
      // Every quarter-hour
      return true;
    case "1d":
    case "1day":
      // Daily bar closes at 00:00 UTC
      return minute < 15 && hour === 0;
    default:
      // Unknown TF — let the LLM run, no harm done
      return true;
  }
}

/** Top-level entry — caller passes the context, gets back the decision
 *  + provenance + regime. The provenance + regime + userMessage feed
 *  into the audit log without entry.ts having to re-derive any of them.
 *  One-shot retry on transient errors built in; decision is null when
 *  both attempts fail. */
export async function evaluateLlmTrader(
  config: NonNullable<AlgorithmRules["llm_trader"]>,
  ctx: LlmTraderContext
): Promise<LlmTraderEvaluation> {
  const { userMessage, regime } = buildLlmTraderContext(ctx);
  const provider = config.provider;
  const promptVersion = config.prompt_version ?? DEFAULT_PROMPT_VERSION;
  const systemPrompt = getPrompt(promptVersion);
  const model =
    config.model ?? (provider === "anthropic" ? ANTHROPIC_HAIKU_MODEL : AI_MODEL);

  const tryOnce = async (): Promise<LlmTraderDecision | null> => {
    if (provider === "anthropic") {
      const client = getAnthropicClient();
      return await callAnthropic(client, model, systemPrompt, userMessage);
    }
    const client = getAIClient();
    return await callGroq(client, model, systemPrompt, userMessage);
  };

  let decision: LlmTraderDecision | null = null;
  try {
    decision = await tryOnce();
  } catch {
    /* fall through to retry */
  }
  if (!decision) {
    // One retry on transient failure (rate-limit / network blip)
    await new Promise((r) => setTimeout(r, 1500));
    try {
      decision = await tryOnce();
    } catch {
      decision = null;
    }
  }

  return { decision, regime, userMessage, promptVersion, provider, model };
}
