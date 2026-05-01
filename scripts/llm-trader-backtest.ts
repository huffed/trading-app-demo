/**
 * LLM-trader MVP — replays cached XAU/USD bars through a Groq-powered
 * discretionary trader and reports backtest stats. Built after pattern-
 * detect-and-threshold strategies failed to produce edge in the recent
 * 60-day regime; this prototype tests whether an LLM with the inputs
 * we already have can outperform our pattern-based candidates.
 *
 * Architecture (MVP):
 *   - Replay cached XAU/USD 4h bars (resampled from Yahoo 1h cache)
 *   - Per bar, build a context string (recent OHLC + daily bias + DXY)
 *   - Call Groq with a structured-output prompt asking for
 *     enter_long/enter_short/hold/exit + confidence + reasoning
 *   - Apply the decision: simulate position open/hold/close
 *   - Use fixed 1.5% SL and 3R TP (MVP — discretionary SL/TP comes later)
 *   - Track P&L, WR, drawdown
 *
 * Cost: each bar = 1 LLM call. 60 days × 6 4h-bars/day = ~360 calls.
 * Groq's free tier handles this (~5K tokens in / ~200 out per call).
 *
 * Usage:
 *   pnpm dlx tsx scripts/llm-trader-backtest.ts
 *
 * Env (optional):
 *   TIMEFRAME=4h    primary timeframe — 4h / 1h / 30m / 15m (default 4h).
 *                   4h is resampled from cached 1h. 1h/30m/15m fetched
 *                   directly (Twelve Data or Yahoo).
 *   SLICE_DAYS=60   how many days back to replay (default 60)
 *   CAPITAL=100000  starting capital (default $100K)
 *
 * Token cost per 60-day run (estimate, ~530 tokens/call after compression):
 *   4h  =  360 calls = ~190K tokens (within Groq free 100K? close — clamp to 30d)
 *   1h  = 1440 calls = ~760K tokens (Dev tier required)
 *   30m = 2880 calls = ~1.5M tokens (Dev tier required)
 *   15m = 5760 calls = ~3M tokens (Dev tier or higher)
 */
import { readFileSync, writeFileSync } from "fs";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { AI_MODEL, getAIClient } from "../src/lib/ai/client";
import { fetchDailyPrices } from "../src/lib/market-data/prices";
import { resampleTo } from "../src/lib/market-data/resample";
import type { PriceBar } from "../src/lib/market-data/types";

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

const decisionSchema = z.object({
  decision: z.enum(["enter_long", "enter_short", "hold", "exit"]),
  confidence: z.number().min(0).max(100),
  reasoning: z.string().min(1).max(2000),
});

type Decision = z.infer<typeof decisionSchema>;

interface OpenPosition {
  side: "long" | "short";
  entry_price: number;
  entry_index: number;
  entry_date: string;
  stop_price: number;
  target_price: number;
  notional: number;
  entry_reasoning: string;
}

interface ClosedTrade {
  side: "long" | "short";
  entry_price: number;
  exit_price: number;
  entry_date: string;
  exit_date: string;
  realized_pnl: number;
  exit_reason: "stop_loss" | "take_profit" | "llm_exit";
  hold_bars: number;
  entry_reasoning: string;
  exit_reasoning: string;
}

const SYSTEM_PROMPT = `You are a gold (XAU/USD) discretionary trader on 4h. Take only HIGH-CONVICTION setups; most bars should be "hold".

BIAS HIERARCHY — apply in strict priority order:
1. RECENT STRUCTURE (HH = bullish regime; LH = bearish regime; RANGING = neutral). Structure is the PRIMARY regime indicator. It leads everything else.
2. Close vs SMA20 = secondary confluence ONLY. If structure conflicts with SMA20, STRUCTURE WINS. SMA20 is slow and lagging — it confirms the regime after the fact, it does not define it.
3. Intermarket (DXY / 10Y yield / VIX / silver) = modifiers that affect setup quality, NEVER primary direction.

REGIME RULES — these are absolute, not heuristics:
- LH regime: only SHORT setups are valid. Do not take longs even if close > SMA20 — that's a counter-trend trade against falling structure.
- HH regime: only LONG setups are valid. Do not take shorts even if close < SMA20.
- RANGING regime: hold by default. Fades at range extremes are the only valid setups.

If you find yourself wanting to take a trade against the structure regime, the answer is "hold". Wait for the regime to flip.

REGIME-FLIP EXIT (applies when in a position):
- Long position + regime flips from HH to LH → EXIT at this bar's close. Do not wait for SL. The regime flip IS the exit signal.
- Short position + regime flips from LH to HH → EXIT at this bar's close. Same rule.
- Long/short + regime goes to RANGING → hold but reduce conviction; consider exit if 4h shows clear thesis breakdown.
The regime is your edge. When it flips, your edge is gone — get out.

Triggers — once regime is established, look for ANY of these (don't wait for perfect confirmation; if structure aligns and you see one of these, take the trade):

Long triggers (HH regime ONLY):
- Sweep of recent swing low + bullish reversal candle
- Bullish engulfing or pin bar at structural support
- Bullish BOS + retest of breakout level
- Pullback into 4h SMA20 / FVG / OB and stalling
- Rally retracement to 20-bar mid + 3-bar bullish momentum confirming up

Short triggers (LH regime ONLY) — be willing to take these even without perfect pattern confirmation:
- Rally of >0.5% into the upper third of the 20-bar range (count this as a valid short setup, the rejection-from-resistance is implied by the regime)
- Sweep of recent 4h swing high + close back below it
- Bearish engulfing, pin bar, or three black crows at swing high
- Bearish BOS + retest of broken support as resistance
- Rally into 4h SMA20 from below (especially if 20-bar mid acts as resistance)
- Rally into recent swing high (within 1.5% of 20-bar high) in any LH bar with weakening momentum or confluent intermarket headwinds (rising DXY / rising 10Y / rising VIX)

Calibration: a "rally into resistance during LH regime" with EITHER a structural rejection sign OR confluent intermarket headwinds is sufficient. Do not wait for textbook-perfect engulfing patterns — those are rare. The regime is the edge; the trigger is just the entry timing.

Intermarket guidance:
- DXY rising = gold headwind (worse for longs, better for shorts)
- 10Y yields rising = gold headwind
- VIX rising = risk-off = gold tailwind (safe haven flows)
- Gold/silver ratio rising = gold leading; falling = silver leading

Hold winners through normal pullbacks; exit only on STRUCTURAL thesis break (e.g., HH→LH flip while long, or LH→HH while short — see Regime-Flip Exit above). SL/TP are fixed (1.5%/4.5%); your job is direction + timing.

Output JSON: {"decision": "enter_long"|"enter_short"|"hold"|"exit", "confidence": 0-100, "reasoning": "1 short sentence"}. "hold" = maintain; "exit" only valid when in a position.`;

const SL_PCT = 0.015;
const TP_PCT = 0.045;

function summariseDailyBias(dailyBars: PriceBar[]): string {
  if (dailyBars.length < 21) return "daily: n/a";
  const recent = dailyBars.slice(-14);
  const last = dailyBars[dailyBars.length - 1];
  const sma20 = dailyBars.slice(-20).reduce((s, b) => s + b.close, 0) / 20;
  const greenDays = recent.filter((b) => b.close > b.open).length;
  const high14 = Math.max(...recent.map((b) => b.high));
  const low14 = Math.min(...recent.map((b) => b.low));
  // Recent structural read: are we making higher highs (HH) or lower highs (LH)?
  // Compare highest of last 3 daily bars to highest of the 4 bars before that.
  const last3High = Math.max(...recent.slice(-3).map((b) => b.high));
  const prev3High = Math.max(...recent.slice(-7, -3).map((b) => b.high));
  // Also compare lows for a more complete picture; ranging if highs and lows
  // disagree (one trending, the other ranging). Conservative tag.
  const last3Low = Math.min(...recent.slice(-3).map((b) => b.low));
  const prev3Low = Math.min(...recent.slice(-7, -3).map((b) => b.low));
  let structure: "HH" | "LH" | "RANGING";
  if (last3High > prev3High && last3Low > prev3Low) structure = "HH";
  else if (last3High < prev3High && last3Low < prev3Low) structure = "LH";
  else structure = "RANGING";
  // Lead with structure (the primary regime indicator per the prompt
  // hierarchy). Present SMA20 as raw data, not a "(bullish/bearish)" label,
  // so the LLM applies the hierarchy explicitly rather than anchoring on
  // the indicator alone.
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
  // Last 3 bars verbose, the rest summarized
  const last3 = window.slice(-3);
  const last3Lines = last3.map((b) => {
    const dir = b.close > b.open ? "↑" : "↓";
    return `${b.date.slice(11, 16)} ${b.open.toFixed(0)}-${b.close.toFixed(0)} ${dir} (H${b.high.toFixed(0)} L${b.low.toFixed(0)})`;
  });
  // 3-bar momentum: close vs close 3 bars ago
  const mom3 = window.length >= 4
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

function summariseDxy(eurusdBars: PriceBar[], currentTs: string): string {
  const ts = new Date(currentTs).getTime();
  const cutoff24h = ts - 24 * 3600 * 1000;
  const cutoff7d = ts - 7 * 24 * 3600 * 1000;
  const before24h = eurusdBars.findLast((b) => new Date(b.date).getTime() <= cutoff24h);
  const before7d = eurusdBars.findLast((b) => new Date(b.date).getTime() <= cutoff7d);
  const latest = eurusdBars.findLast((b) => new Date(b.date).getTime() <= ts);
  if (!before24h || !before7d || !latest) return "DXY: n/a";
  const c24 = ((latest.close - before24h.close) / before24h.close) * 100;
  const c7 = ((latest.close - before7d.close) / before7d.close) * 100;
  // DXY moves inverse to EUR/USD
  return `DXY: 24h ${-c24 >= 0 ? "+" : ""}${(-c24).toFixed(2)}% / 7d ${-c7 >= 0 ? "+" : ""}${(-c7).toFixed(2)}%.`;
}

interface IntermarketSeries {
  silver?: PriceBar[];
  yield10y?: PriceBar[];
  vix?: PriceBar[];
}

/** Try to load each intermarket series, return null entries on failure
 *  (prices.ts fallback chain handles Twelve Data quota outage by falling
 *  through to Yahoo). Doesn't crash the run if any single ticker can't
 *  be fetched — the summariser handles missing data gracefully. */
async function loadIntermarket(): Promise<IntermarketSeries> {
  const out: IntermarketSeries = {};
  const tryFetch = async (ticker: string): Promise<PriceBar[] | undefined> => {
    try {
      return await fetchDailyPrices(ticker, "full", "1day");
    } catch (err) {
      console.log(`  ${ticker}: fetch failed (${err instanceof Error ? err.message.slice(0, 60) : "unknown"})`);
      return undefined;
    }
  };
  out.silver = await tryFetch("XAG/USD");
  out.yield10y = await tryFetch("^TNX");
  out.vix = await tryFetch("^VIX");
  return out;
}

function summariseIntermarket(im: IntermarketSeries, goldClose: number, currentTs: string): string {
  const ts = new Date(currentTs).getTime();
  const cutoff24h = ts - 24 * 3600 * 1000;
  const cutoff7d = ts - 7 * 24 * 3600 * 1000;
  const lookup = (bars: PriceBar[] | undefined, cutoff: number): PriceBar | undefined => {
    if (!bars) return undefined;
    return bars.findLast((b) => new Date(b.date).getTime() <= cutoff);
  };
  const parts: string[] = [];

  // Gold-silver ratio
  const slvLatest = lookup(im.silver, ts);
  const slv7d = lookup(im.silver, cutoff7d);
  if (slvLatest && slv7d) {
    const ratioNow = goldClose / slvLatest.close;
    const ratio7d = goldClose / slv7d.close; // approximation — uses current gold for both, just shows silver direction
    const slvChange7d = ((slvLatest.close - slv7d.close) / slv7d.close) * 100;
    parts.push(
      `XAU/XAG ${ratioNow.toFixed(0)} (silver 7d ${slvChange7d >= 0 ? "+" : ""}${slvChange7d.toFixed(2)}%)`
    );
  }

  // 10Y yield
  const tnxLatest = lookup(im.yield10y, ts);
  const tnx24h = lookup(im.yield10y, cutoff24h);
  if (tnxLatest && tnx24h) {
    const yieldNow = tnxLatest.close;
    const yieldChange = yieldNow - tnx24h.close;
    parts.push(
      `10Y ${yieldNow.toFixed(2)}% (24h ${yieldChange >= 0 ? "+" : ""}${yieldChange.toFixed(2)}pp)`
    );
  }

  // VIX
  const vixLatest = lookup(im.vix, ts);
  const vix24h = lookup(im.vix, cutoff24h);
  if (vixLatest && vix24h) {
    const vixNow = vixLatest.close;
    const vixChange = ((vixNow - vix24h.close) / vix24h.close) * 100;
    parts.push(`VIX ${vixNow.toFixed(0)} (24h ${vixChange >= 0 ? "+" : ""}${vixChange.toFixed(1)}%)`);
  }

  return parts.length > 0 ? `Intermarket: ${parts.join(" | ")}.` : "Intermarket: n/a";
}

function summarisePosition(position: OpenPosition | null, currentPrice: number): string {
  if (!position) return "FLAT.";
  const pnlPct =
    position.side === "long"
      ? ((currentPrice - position.entry_price) / position.entry_price) * 100
      : ((position.entry_price - currentPrice) / position.entry_price) * 100;
  return `${position.side.toUpperCase()} from ${position.entry_price.toFixed(0)}, cur ${currentPrice.toFixed(0)}, P&L ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%, SL ${position.stop_price.toFixed(0)}/TP ${position.target_price.toFixed(0)}.`;
}

type Provider = "groq" | "anthropic";

interface ProviderClients {
  groq?: ReturnType<typeof getAIClient>;
  anthropic?: Anthropic;
}

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

/** Robust JSON extractor — Anthropic occasionally prefaces JSON with
 *  prose despite the prompt, so we strip to the first { ... } block. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Direct JSON
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  // First {...} block
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

async function callGroq(
  client: ReturnType<typeof getAIClient>,
  context: string
): Promise<Decision | null> {
  const res = await client.chat.completions.create({
    model: AI_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: context },
    ],
    response_format: { type: "json_object" },
    max_tokens: 128,
    temperature: 0.2,
  });
  const text = res.choices[0]?.message?.content ?? "{}";
  const raw = extractJson(text);
  const parsed = decisionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

async function callAnthropic(client: Anthropic, context: string): Promise<Decision | null> {
  const res = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 200,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: context }],
  });
  const block = res.content[0];
  const text = block && block.type === "text" ? block.text : "{}";
  const raw = extractJson(text);
  const parsed = decisionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

async function callLLM(
  provider: Provider,
  clients: ProviderClients,
  context: string
): Promise<Decision | null> {
  try {
    if (provider === "anthropic") {
      if (!clients.anthropic) throw new Error("anthropic client not initialised");
      return await callAnthropic(clients.anthropic, context);
    }
    if (!clients.groq) throw new Error("groq client not initialised");
    return await callGroq(clients.groq, context);
  } catch (err) {
    console.error("LLM call failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

function findExitOnNextBar(
  bar: PriceBar,
  position: OpenPosition
): { triggered: true; exit_price: number; reason: "stop_loss" | "take_profit" } | { triggered: false } {
  if (position.side === "long") {
    if (bar.low <= position.stop_price) return { triggered: true, exit_price: position.stop_price, reason: "stop_loss" };
    if (bar.high >= position.target_price) return { triggered: true, exit_price: position.target_price, reason: "take_profit" };
  } else {
    if (bar.high >= position.stop_price) return { triggered: true, exit_price: position.stop_price, reason: "stop_loss" };
    if (bar.low <= position.target_price) return { triggered: true, exit_price: position.target_price, reason: "take_profit" };
  }
  return { triggered: false };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function main(): Promise<void> {
  const sliceDays = Number(process.env.SLICE_DAYS ?? "60");
  const capital = Number(process.env.CAPITAL ?? "100000");
  const timeframe = (process.env.TIMEFRAME ?? "4h").toLowerCase();
  // SLICE_END_DATE optional: end the slice at this date instead of "now".
  // Lets us replay arbitrary historical windows for cross-regime validation
  // (e.g. test that the LLM-trader's edge isn't lucky for the most-recent
  // 60d). Format: YYYY-MM-DD.
  const sliceEndStr = process.env.SLICE_END_DATE;
  const sliceEndMs = sliceEndStr ? new Date(`${sliceEndStr}T23:59:59Z`).getTime() : Date.now();
  if (Number.isNaN(sliceEndMs)) throw new Error(`Invalid SLICE_END_DATE=${sliceEndStr}`);
  // BarInterval supports "15min" | "1h" | "4h" | "1day". For 4h and 30m
  // we fetch a finer interval and resample via resampleTo. For 1h and
  // 15m we fetch directly.
  let fetchInterval: "15min" | "1h" | "4h";
  let needsResample: false | "4h" | "30m";
  if (timeframe === "4h") {
    fetchInterval = "1h";
    needsResample = "4h";
  } else if (timeframe === "1h") {
    fetchInterval = "1h";
    needsResample = false;
  } else if (timeframe === "30m") {
    fetchInterval = "15min";
    needsResample = "30m";
  } else if (timeframe === "15m") {
    fetchInterval = "15min";
    needsResample = false;
  } else {
    throw new Error(`Unsupported TIMEFRAME=${timeframe}. Use 4h / 1h / 30m / 15m.`);
  }

  console.log(`Loading XAU/USD ${timeframe} corpus (fetched at ${fetchInterval}${needsResample ? `, resampled to ${needsResample}` : ""})...`);
  const fetched = await fetchDailyPrices("XAU/USD", "full", fetchInterval);
  const bars = needsResample ? resampleTo(fetched, needsResample) : fetched;
  const dailyBars = await fetchDailyPrices("XAU/USD", "full", "1day");
  console.log(`  ${timeframe} corpus: ${bars.length} bars`);
  console.log(`  daily corpus: ${dailyBars.length} bars`);

  console.log("Loading EUR/USD 4h proxy...");
  const eurusd4h = await fetchDailyPrices("EUR/USD", "full", "4h");
  console.log(`  EUR/USD 4h: ${eurusd4h.length} bars`);

  console.log("Loading intermarket series (silver / yields / VIX)...");
  const intermarket = await loadIntermarket();
  console.log(
    `  silver: ${intermarket.silver?.length ?? 0} bars · 10Y yield: ${intermarket.yield10y?.length ?? 0} bars · VIX: ${intermarket.vix?.length ?? 0} bars`
  );
  console.log("");

  // Slice bars to [end - sliceDays, end]. End defaults to "now" but can be
  // overridden via SLICE_END_DATE for historical-window validation.
  const cutoffMs = sliceEndMs - sliceDays * 24 * 3600 * 1000;
  const startIdx = bars.findIndex((b) => new Date(b.date).getTime() >= cutoffMs);
  if (startIdx === -1) throw new Error(`no ${timeframe} bars in slice window`);
  const endIdxExclusive = bars.findIndex((b) => new Date(b.date).getTime() > sliceEndMs);
  const lastIdx = endIdxExclusive === -1 ? bars.length : endIdxExclusive;
  const numBars = lastIdx - startIdx;
  if (numBars <= 0) throw new Error(`empty slice — check SLICE_END_DATE / SLICE_DAYS`);
  // ~530 tokens/call rough estimate post-compression (~430 input + ~100 output)
  const estTokens = numBars * 530;
  const windowLabel = sliceEndStr ? `${sliceEndStr} − ${sliceDays}d` : `last ${sliceDays} days`;
  console.log(`Replaying ${numBars} ${timeframe} bars (${windowLabel}: ${bars[startIdx]?.date.slice(0,10)} → ${bars[lastIdx-1]?.date.slice(0,10)})...`);
  console.log(
    `  Estimated token cost: ~${(estTokens / 1000).toFixed(0)}K tokens (Groq free 100K/day, Dev 6M/day)`
  );
  if (estTokens > 100_000) {
    console.log(`  ⚠ Over free-tier daily quota — will hit rate limit partway. Use Dev tier or shorter slice.`);
  }
  console.log("");

  const provider: Provider = (process.env.PROVIDER ?? "groq").toLowerCase() as Provider;
  if (provider !== "groq" && provider !== "anthropic") {
    throw new Error(`Unsupported PROVIDER=${provider}. Use groq or anthropic.`);
  }
  console.log(`Using provider: ${provider} (model: ${provider === "anthropic" ? ANTHROPIC_MODEL : AI_MODEL})`);
  console.log("");
  const clients: ProviderClients = {};
  if (provider === "groq") clients.groq = getAIClient();
  if (provider === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY env var required for anthropic provider");
    clients.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  const closedTrades: ClosedTrade[] = [];
  // Full per-bar decision audit trail (every LLM response, including holds).
  // Written to scripts/llm-trader-decisions.jsonl at end of run.
  const decisionLog: Array<{
    bar_date: string;
    bar_close: number;
    decision: string;
    confidence: number;
    reasoning: string;
    had_position: string;
  }> = [];
  let position: OpenPosition | null = null;
  let cash = capital;
  let equityHigh = capital;
  let maxDrawdown = 0;
  let llmCallCount = 0;
  let llmFailureCount = 0;

  for (let i = startIdx; i < lastIdx; i++) {
    const bar = bars[i];

    // 1) Check for SL/TP fill on the current bar (if in position).
    if (position) {
      const exit = findExitOnNextBar(bar, position);
      if (exit.triggered) {
        const pnl =
          position.side === "long"
            ? (exit.exit_price - position.entry_price) * (position.notional / position.entry_price)
            : (position.entry_price - exit.exit_price) * (position.notional / position.entry_price);
        cash += pnl;
        closedTrades.push({
          side: position.side,
          entry_price: position.entry_price,
          exit_price: exit.exit_price,
          entry_date: position.entry_date,
          exit_date: bar.date,
          realized_pnl: pnl,
          exit_reason: exit.reason,
          hold_bars: i - position.entry_index,
          entry_reasoning: position.entry_reasoning,
          exit_reasoning: "(price exit — SL/TP fill)",
        });
        equityHigh = Math.max(equityHigh, cash);
        maxDrawdown = Math.max(maxDrawdown, ((equityHigh - cash) / equityHigh) * 100);
        position = null;
      }
    }

    // 2) Ask LLM for the next decision based on this bar's close.
    const dailyContext = summariseDailyBias(dailyBars.filter((d) => new Date(d.date).getTime() <= new Date(bar.date).getTime()));
    const recentContext = summariseRecentBars(bars, i, timeframe);
    const dxyContext = summariseDxy(eurusd4h, bar.date);
    const intermarketContext = summariseIntermarket(intermarket, bar.close, bar.date);
    const positionContext = summarisePosition(position, bar.close);

    const userMessage = `${bar.date.slice(0, 16)}\n${dailyContext}\n${dxyContext}\n${intermarketContext}\n${recentContext}\nPosition: ${positionContext}\nDecide.`;

    const decision = await callLLM(provider, clients, userMessage);
    llmCallCount++;
    if (!decision) {
      llmFailureCount++;
      continue;
    }

    // Append to decision log (every bar, even holds — full audit trail)
    decisionLog.push({
      bar_date: bar.date,
      bar_close: bar.close,
      decision: decision.decision,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      had_position: position ? position.side : "flat",
    });

    // 3) Apply decision.
    if (decision.decision === "enter_long" && !position) {
      const stop = bar.close * (1 - SL_PCT);
      const target = bar.close * (1 + TP_PCT);
      const notional = capital * 0.5; // 50% notional, simple sizing for MVP
      position = {
        side: "long",
        entry_price: bar.close,
        entry_index: i,
        entry_date: bar.date,
        stop_price: stop,
        target_price: target,
        notional,
        entry_reasoning: decision.reasoning,
      };
    } else if (decision.decision === "enter_short" && !position) {
      const stop = bar.close * (1 + SL_PCT);
      const target = bar.close * (1 - TP_PCT);
      const notional = capital * 0.5;
      position = {
        side: "short",
        entry_price: bar.close,
        entry_index: i,
        entry_date: bar.date,
        stop_price: stop,
        target_price: target,
        notional,
        entry_reasoning: decision.reasoning,
      };
    } else if (decision.decision === "exit" && position) {
      const exitPrice = bar.close;
      const pnl =
        position.side === "long"
          ? (exitPrice - position.entry_price) * (position.notional / position.entry_price)
          : (position.entry_price - exitPrice) * (position.notional / position.entry_price);
      cash += pnl;
      closedTrades.push({
        side: position.side,
        entry_price: position.entry_price,
        exit_price: exitPrice,
        entry_date: position.entry_date,
        exit_date: bar.date,
        realized_pnl: pnl,
        exit_reason: "llm_exit",
        hold_bars: i - position.entry_index,
        entry_reasoning: position.entry_reasoning,
        exit_reasoning: decision.reasoning,
      });
      equityHigh = Math.max(equityHigh, cash);
      maxDrawdown = Math.max(maxDrawdown, ((equityHigh - cash) / equityHigh) * 100);
      position = null;
    }

    // Live progress
    if ((i - startIdx + 1) % 20 === 0) {
      console.log(
        `  ${i - startIdx + 1}/${numBars} bars · cash $${cash.toFixed(0)} · ${closedTrades.length} closed · ${llmCallCount} LLM calls (${llmFailureCount} fails)`
      );
    }
  }

  // Close any remaining position at the last close.
  if (position) {
    const lastBar = bars[lastIdx - 1];
    const exitPrice = lastBar.close;
    const pnl =
      position.side === "long"
        ? (exitPrice - position.entry_price) * (position.notional / position.entry_price)
        : (position.entry_price - exitPrice) * (position.notional / position.entry_price);
    cash += pnl;
    closedTrades.push({
      side: position.side,
      entry_price: position.entry_price,
      exit_price: exitPrice,
      entry_date: position.entry_date,
      exit_date: lastBar.date,
      realized_pnl: pnl,
      exit_reason: "llm_exit",
      hold_bars: lastIdx - 1 - position.entry_index,
      entry_reasoning: position.entry_reasoning,
      exit_reasoning: "(force-close at end of window)",
    });
  }

  console.log("");
  console.log("===== Backtest complete =====");
  const wins = closedTrades.filter((t) => t.realized_pnl > 0);
  const losses = closedTrades.filter((t) => t.realized_pnl <= 0);
  const totalPnl = closedTrades.reduce((s, t) => s + t.realized_pnl, 0);
  const wr = closedTrades.length === 0 ? 0 : (wins.length / closedTrades.length) * 100;
  const avgHold = closedTrades.reduce((s, t) => s + t.hold_bars, 0) / Math.max(closedTrades.length, 1);
  console.log(`Trades         : ${closedTrades.length}`);
  console.log(`Win rate       : ${wr.toFixed(1)}%`);
  console.log(`Total P&L      : $${totalPnl.toFixed(0)} (${((totalPnl / capital) * 100).toFixed(2)}%)`);
  console.log(`Max drawdown   : ${maxDrawdown.toFixed(2)}%`);
  console.log(`Avg hold       : ${avgHold.toFixed(1)} 4h bars (${(avgHold * 4).toFixed(1)}h)`);
  console.log(`LLM calls      : ${llmCallCount} (${llmFailureCount} fails)`);
  console.log("");

  console.log("Trade log (last 15):");
  for (const t of closedTrades.slice(-15)) {
    console.log(
      `  ${t.entry_date.slice(0, 16)} → ${t.exit_date.slice(0, 16)}  ${t.side}  $${t.realized_pnl.toFixed(0)}  ${t.hold_bars}b  ${t.exit_reason}`
    );
    console.log(`    entry: ${t.entry_reasoning.slice(0, 200)}`);
    console.log(`    exit : ${t.exit_reasoning.slice(0, 200)}`);
  }
  console.log("");

  // Decision distribution diagnostic — what % of bars LLM chose each action
  const dist: Record<string, number> = {};
  for (const d of decisionLog) dist[d.decision] = (dist[d.decision] ?? 0) + 1;
  console.log("Decision distribution:");
  for (const [k, v] of Object.entries(dist)) {
    console.log(`  ${k.padEnd(14)} ${v} (${((v / decisionLog.length) * 100).toFixed(1)}%)`);
  }
  console.log("");

  // Save full audit trail
  const logPath = `scripts/llm-trader-decisions-${provider}-${timeframe}-${sliceDays}d.jsonl`;
  writeFileSync(logPath, decisionLog.map((d) => JSON.stringify(d)).join("\n"));
  console.log(`Decision audit trail: ${logPath} (${decisionLog.length} entries)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
