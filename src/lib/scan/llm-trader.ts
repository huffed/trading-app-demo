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
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ANTHROPIC_HAIKU_MODEL, getAnthropicClient } from "@/lib/ai/anthropic-client";
import { AI_MODEL, getAIClient } from "@/lib/ai/client";
import type { PriceBar } from "@/lib/market-data/types";
import { DEFAULT_PROMPT_VERSION, getPrompt } from "@/lib/scan/llm-trader-prompts";
import type { AlgorithmRules } from "@/types/algorithm";

// Re-export for backward compatibility with any external callers /
// scripts that import the V1 constant directly.
export { LLM_TRADER_PROMPT_V1 } from "@/lib/scan/llm-trader-prompts";

export interface LlmTraderDecision {
  decision: "enter_long" | "enter_short" | "hold" | "exit";
  confidence: number;
  reasoning: string;
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
    targetPrice?: number;
  } | null;
  /** Primary timeframe label for the prompt (e.g. "4h"). */
  timeframe: string;
}

const decisionSchema = z.object({
  decision: z.enum(["enter_long", "enter_short", "hold", "exit"]),
  confidence: z.number().min(0).max(100),
  reasoning: z.string().min(1).max(2000),
});

// ---------------------------------------------------------------------------
// Context builders — port from scripts/llm-trader-backtest.ts. Compressed to
// ~530 tokens/call (vs ~1400 in the verbose version that was too cliché-prone).
// ---------------------------------------------------------------------------

function summariseDailyBias(dailyBars: PriceBar[]): string {
  if (dailyBars.length < 21) return "daily: n/a";
  const recent = dailyBars.slice(-14);
  const last = dailyBars[dailyBars.length - 1];
  const sma20 = dailyBars.slice(-20).reduce((s, b) => s + b.close, 0) / 20;
  const greenDays = recent.filter((b) => b.close > b.open).length;
  const high14 = Math.max(...recent.map((b) => b.high));
  const low14 = Math.min(...recent.map((b) => b.low));
  const last3High = Math.max(...recent.slice(-3).map((b) => b.high));
  const prev3High = Math.max(...recent.slice(-7, -3).map((b) => b.high));
  const last3Low = Math.min(...recent.slice(-3).map((b) => b.low));
  const prev3Low = Math.min(...recent.slice(-7, -3).map((b) => b.low));
  let structure: "HH" | "LH" | "RANGING";
  if (last3High > prev3High && last3Low > prev3Low) structure = "HH";
  else if (last3High < prev3High && last3Low < prev3Low) structure = "LH";
  else structure = "RANGING";
  const smaPct = ((last.close - sma20) / sma20) * 100;
  return `D1 structure: ${structure}. Close ${last.close.toFixed(0)} (${smaPct >= 0 ? "+" : ""}${smaPct.toFixed(2)}% vs SMA20 ${sma20.toFixed(0)}). 14d ${greenDays}G/${14 - greenDays}R. Range ${low14.toFixed(0)}-${high14.toFixed(0)}.`;
}

function computeAtr(bars: PriceBar[], period: number, idx: number): number {
  const start = Math.max(1, idx - period + 1);
  let sum = 0;
  let count = 0;
  for (let i = start; i <= idx; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
    sum += tr;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

function summariseRecentBars(bars: PriceBar[], idx: number, tfLabel: string): string {
  const start = Math.max(0, idx - 19);
  const window = bars.slice(start, idx + 1);
  const cur = window[window.length - 1];
  const swingHigh = Math.max(...window.map((b) => b.high));
  const swingLow = Math.min(...window.map((b) => b.low));
  const last3 = window.slice(-3);
  const last3Lines = last3.map((b) => {
    const dir = b.close > b.open ? "↑" : "↓";
    return `${b.date.slice(11, 16)} ${b.open.toFixed(0)}-${b.close.toFixed(0)} ${dir} (H${b.high.toFixed(0)} L${b.low.toFixed(0)})`;
  });
  const mom3 =
    window.length >= 4
      ? ((cur.close - window[window.length - 4].close) / window[window.length - 4].close) * 100
      : 0;
  const atr14 = computeAtr(bars, 14, idx);
  const distHi = ((swingHigh - cur.close) / cur.close) * 100;
  const distLo = ((cur.close - swingLow) / cur.close) * 100;
  return (
    `${tfLabel}: cur ${cur.close.toFixed(0)}, 20-bar range ${swingLow.toFixed(0)}-${swingHigh.toFixed(0)} ` +
    `(dist hi ${distHi.toFixed(1)}% / lo ${distLo.toFixed(1)}%), 3-bar mom ${mom3 >= 0 ? "+" : ""}${mom3.toFixed(2)}%, ATR14 ${atr14.toFixed(1)}.\n` +
    `Last 3 bars: ${last3Lines.join(" | ")}`
  );
}

function summariseDxy(eurusdBars: PriceBar[] | null | undefined, currentTs: string): string {
  if (!eurusdBars || eurusdBars.length === 0) return "DXY: n/a";
  const ts = new Date(currentTs).getTime();
  const cutoff24h = ts - 24 * 3600 * 1000;
  const cutoff7d = ts - 7 * 24 * 3600 * 1000;
  const before24h = eurusdBars.findLast((b) => new Date(b.date).getTime() <= cutoff24h);
  const before7d = eurusdBars.findLast((b) => new Date(b.date).getTime() <= cutoff7d);
  const latest = eurusdBars.findLast((b) => new Date(b.date).getTime() <= ts);
  if (!before24h || !before7d || !latest) return "DXY: n/a";
  const c24 = ((latest.close - before24h.close) / before24h.close) * 100;
  const c7 = ((latest.close - before7d.close) / before7d.close) * 100;
  return `DXY: 24h ${-c24 >= 0 ? "+" : ""}${(-c24).toFixed(2)}% / 7d ${-c7 >= 0 ? "+" : ""}${(-c7).toFixed(2)}%.`;
}

function summariseIntermarket(
  im: NonNullable<LlmTraderContext["intermarket"]> | undefined,
  goldClose: number,
  currentTs: string
): string {
  if (!im) return "Intermarket: n/a";
  const ts = new Date(currentTs).getTime();
  const cutoff24h = ts - 24 * 3600 * 1000;
  const cutoff7d = ts - 7 * 24 * 3600 * 1000;
  const lookup = (bars: PriceBar[] | undefined, cutoff: number): PriceBar | undefined => {
    if (!bars) return undefined;
    return bars.findLast((b) => new Date(b.date).getTime() <= cutoff);
  };
  const parts: string[] = [];
  const slvLatest = lookup(im.silver, ts);
  const slv7d = lookup(im.silver, cutoff7d);
  if (slvLatest && slv7d) {
    const ratioNow = goldClose / slvLatest.close;
    const slvChange7d = ((slvLatest.close - slv7d.close) / slv7d.close) * 100;
    parts.push(
      `XAU/XAG ${ratioNow.toFixed(0)} (silver 7d ${slvChange7d >= 0 ? "+" : ""}${slvChange7d.toFixed(2)}%)`
    );
  }
  const tnxLatest = lookup(im.yield10y, ts);
  const tnx24h = lookup(im.yield10y, cutoff24h);
  if (tnxLatest && tnx24h) {
    const yieldChange = tnxLatest.close - tnx24h.close;
    parts.push(
      `10Y ${tnxLatest.close.toFixed(2)}% (24h ${yieldChange >= 0 ? "+" : ""}${yieldChange.toFixed(2)}pp)`
    );
  }
  const vixLatest = lookup(im.vix, ts);
  const vix24h = lookup(im.vix, cutoff24h);
  if (vixLatest && vix24h) {
    const vixChange = ((vixLatest.close - vix24h.close) / vix24h.close) * 100;
    parts.push(
      `VIX ${vixLatest.close.toFixed(0)} (24h ${vixChange >= 0 ? "+" : ""}${vixChange.toFixed(1)}%)`
    );
  }
  return parts.length > 0 ? `Intermarket: ${parts.join(" | ")}.` : "Intermarket: n/a";
}

function summarisePosition(position: LlmTraderContext["position"], currentPrice: number): string {
  if (!position) return "FLAT.";
  const pnlPct =
    position.side === "long"
      ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
      : ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
  const sl = position.stopPrice ? `SL ${position.stopPrice.toFixed(0)}` : "SL n/a";
  const tp = position.targetPrice ? `TP ${position.targetPrice.toFixed(0)}` : "TP n/a";
  return `${position.side.toUpperCase()} from ${position.entryPrice.toFixed(0)}, cur ${currentPrice.toFixed(0)}, P&L ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%, ${sl}/${tp}.`;
}

/** Build the user-message context string. ~430 tokens typical. */
export function buildLlmTraderContext(ctx: LlmTraderContext): string {
  const idx = ctx.bars.length - 1;
  const cur = ctx.bars[idx];
  const dailyBefore = ctx.dailyBars.filter(
    (d) => new Date(d.date).getTime() <= new Date(ctx.currentTimestamp).getTime()
  );
  const dailyContext = summariseDailyBias(dailyBefore);
  const recentContext = summariseRecentBars(ctx.bars, idx, ctx.timeframe);
  const dxyContext = summariseDxy(ctx.dxyBars, ctx.currentTimestamp);
  const intermarketContext = summariseIntermarket(ctx.intermarket, cur.close, ctx.currentTimestamp);
  const positionContext = summarisePosition(ctx.position ?? null, cur.close);
  return `${ctx.currentTimestamp.slice(0, 16)}\n${dailyContext}\n${dxyContext}\n${intermarketContext}\n${recentContext}\nPosition: ${positionContext}\nDecide.`;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      /* give up */
    }
  }
  return null;
}

/** Call Anthropic Haiku (or override). Returns null on parse failure or
 *  API error. Caller decides whether to retry. */
async function callAnthropic(
  client: Anthropic,
  model: string,
  systemPrompt: string,
  context: string
): Promise<LlmTraderDecision | null> {
  const res = await client.messages.create({
    model,
    max_tokens: 200,
    system: systemPrompt,
    messages: [{ role: "user", content: context }],
  });
  const block = res.content[0];
  const text = block && block.type === "text" ? block.text : "{}";
  const raw = extractJson(text);
  const parsed = decisionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

async function callGroq(
  client: ReturnType<typeof getAIClient>,
  model: string,
  systemPrompt: string,
  context: string
): Promise<LlmTraderDecision | null> {
  const res = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: context },
    ],
    response_format: { type: "json_object" },
    max_tokens: 200,
    temperature: 0.2,
  });
  const text = res.choices[0]?.message?.content ?? "{}";
  const raw = extractJson(text);
  const parsed = decisionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Check whether the current wall-clock time is at a bar-close moment for
 * the given primary timeframe. The scan-cron runs every 15 min, but the
 * LLM should only evaluate at primary-TF bar-close to match how the
 * backtest harness evaluated. Otherwise live calls happen mid-bar with
 * partial data — the LLM's context is half-formed, decisions diverge
 * from backtest.
 *
 * Returns true if "now" is within the first 15 minutes after a bar-close
 * boundary for the timeframe. Forex/gold markets close at UTC midnight
 * so daily uses 00:00 UTC.
 */
export function isBarCloseScan(timeframe: string, now: Date = new Date()): boolean {
  const minute = now.getUTCMinutes();
  const hour = now.getUTCHours();
  const tf = timeframe.toLowerCase();
  switch (tf) {
    case "4h":
      // 4h bars close at 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC
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

/** Top-level entry — caller passes the context, gets back a decision (or
 *  null on failure). One-shot retry on transient errors built in. */
export async function evaluateLlmTrader(
  config: NonNullable<AlgorithmRules["llm_trader"]>,
  ctx: LlmTraderContext
): Promise<LlmTraderDecision | null> {
  const userMessage = buildLlmTraderContext(ctx);
  const provider = config.provider;
  // prompt_version is optional in the schema; fall back to current default
  // when absent so old algorithm rows keep working without a migration.
  const systemPrompt = getPrompt(config.prompt_version ?? DEFAULT_PROMPT_VERSION);
  const tryOnce = async (): Promise<LlmTraderDecision | null> => {
    if (provider === "anthropic") {
      const client = getAnthropicClient();
      const model = config.model ?? ANTHROPIC_HAIKU_MODEL;
      return await callAnthropic(client, model, systemPrompt, userMessage);
    }
    const client = getAIClient();
    const model = config.model ?? AI_MODEL;
    return await callGroq(client, model, systemPrompt, userMessage);
  };
  try {
    const first = await tryOnce();
    if (first) return first;
  } catch {
    /* fall through to retry */
  }
  // One retry on transient failure (rate-limit / network blip)
  await new Promise((r) => setTimeout(r, 1500));
  try {
    return await tryOnce();
  } catch {
    return null;
  }
}
