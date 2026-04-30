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
 *   SLICE_DAYS=60   how many days back to replay (default 60)
 *   CAPITAL=100000  starting capital (default $100K)
 */
import { readFileSync } from "fs";
import { z } from "zod";
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
  reasoning: string;
}

const SYSTEM_PROMPT = `You are a gold (XAU/USD) discretionary trader on 4h. Take only HIGH-CONVICTION setups; most bars should be "hold". Align with daily trend. Long on bullish bias + bullish 4h trigger (sweep+reversal, engulfing/pin at level, BOS+retest, pullback to MA/FVG). Short on bearish mirror. Pass when sideways.

Intermarket context (factor in):
- DXY rising = headwind for gold longs (dollar strength)
- 10Y yields rising = headwind for gold (real-rate pressure)
- VIX rising = risk-off = gold tailwind (safe haven flows)
- Gold-silver ratio rising = gold leading (often late-cycle bullish); falling = silver leading (often broad risk-on)

Hold winners through normal pullbacks; exit only on structural thesis break. SL/TP are fixed (1.5%/4.5%); your job is direction + timing.

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
  const last3High = Math.max(...recent.slice(-3).map((b) => b.high));
  const prev3High = Math.max(...recent.slice(-7, -3).map((b) => b.high));
  const structure = last3High > prev3High ? "HH" : "LH";
  const above = last.close > sma20 ? "above" : "below";
  return `D1: close ${last.close.toFixed(0)} ${above} SMA20 ${sma20.toFixed(0)}, 14d ${greenDays}G/${14 - greenDays}R, range ${low14.toFixed(0)}-${high14.toFixed(0)}, structure ${structure}.`;
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

function summariseRecent4h(bars: PriceBar[], idx: number): string {
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
    `4h: cur ${cur.close.toFixed(0)}, 20-bar range ${swingLow.toFixed(0)}-${swingHigh.toFixed(0)} ` +
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

async function callLLM(
  client: ReturnType<typeof getAIClient>,
  context: string
): Promise<Decision | null> {
  try {
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
    const raw = JSON.parse(text);
    const parsed = decisionSchema.safeParse(raw);
    if (!parsed.success) return null;
    return parsed.data;
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

  console.log("Loading XAU/USD 4h corpus...");
  const hourly = await fetchDailyPrices("XAU/USD", "full", "1h");
  const bars4h = resampleTo(hourly, "4h");
  const dailyBars = await fetchDailyPrices("XAU/USD", "full", "1day");
  console.log(`  4h corpus: ${bars4h.length} bars`);
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

  // Slice 4h bars to last N days but keep daily history (need 21 bars for SMA20).
  const cutoffMs = Date.now() - sliceDays * 24 * 3600 * 1000;
  const start4hIdx = bars4h.findIndex((b) => new Date(b.date).getTime() >= cutoffMs);
  if (start4hIdx === -1) throw new Error("no 4h bars in slice window");

  const numBars = bars4h.length - start4hIdx;
  console.log(`Replaying ${numBars} 4h bars (last ${sliceDays} days)...`);
  console.log("");

  const client = getAIClient();
  const closedTrades: ClosedTrade[] = [];
  let position: OpenPosition | null = null;
  let cash = capital;
  let equityHigh = capital;
  let maxDrawdown = 0;
  let llmCallCount = 0;
  let llmFailureCount = 0;

  for (let i = start4hIdx; i < bars4h.length; i++) {
    const bar = bars4h[i];

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
          reasoning: "(price exit)",
        });
        equityHigh = Math.max(equityHigh, cash);
        maxDrawdown = Math.max(maxDrawdown, ((equityHigh - cash) / equityHigh) * 100);
        position = null;
      }
    }

    // 2) Ask LLM for the next decision based on this bar's close.
    const dailyContext = summariseDailyBias(dailyBars.filter((d) => new Date(d.date).getTime() <= new Date(bar.date).getTime()));
    const recentContext = summariseRecent4h(bars4h, i);
    const dxyContext = summariseDxy(eurusd4h, bar.date);
    const intermarketContext = summariseIntermarket(intermarket, bar.close, bar.date);
    const positionContext = summarisePosition(position, bar.close);

    const userMessage = `${bar.date.slice(0, 16)}\n${dailyContext}\n${dxyContext}\n${intermarketContext}\n${recentContext}\nPosition: ${positionContext}\nDecide.`;

    const decision = await callLLM(client, userMessage);
    llmCallCount++;
    if (!decision) {
      llmFailureCount++;
      continue;
    }

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
        reasoning: decision.reasoning,
      });
      equityHigh = Math.max(equityHigh, cash);
      maxDrawdown = Math.max(maxDrawdown, ((equityHigh - cash) / equityHigh) * 100);
      position = null;
    }

    // Live progress
    if ((i - start4hIdx + 1) % 20 === 0) {
      console.log(
        `  ${i - start4hIdx + 1}/${numBars} bars · cash $${cash.toFixed(0)} · ${closedTrades.length} closed · ${llmCallCount} LLM calls (${llmFailureCount} fails)`
      );
    }
  }

  // Close any remaining position at the last close.
  if (position) {
    const lastBar = bars4h[bars4h.length - 1];
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
      hold_bars: bars4h.length - 1 - position.entry_index,
      reasoning: "(force-close at end of window)",
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
  console.log(
    pad("entry", 19) + pad("exit", 19) + pad("side", 7) + pad("$pnl", 9) + pad("hold", 6) + pad("reason", 14) + "why"
  );
  for (const t of closedTrades.slice(-15)) {
    console.log(
      pad(t.entry_date.slice(0, 16), 19) +
        pad(t.exit_date.slice(0, 16), 19) +
        pad(t.side, 7) +
        pad(`$${t.realized_pnl.toFixed(0)}`, 9) +
        pad(`${t.hold_bars}b`, 6) +
        pad(t.exit_reason, 14) +
        t.reasoning.slice(0, 80)
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
