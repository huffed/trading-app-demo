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
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { AI_MODEL, getAIClient } from "../src/lib/ai/client";
import { checkAtrLiquidity } from "../src/lib/algorithm/intraday-atr-gate";
import { checkStagnantExit } from "../src/lib/algorithm/stagnant-exit";
import { INSTRUMENT_CATALOG, type InstrumentClass } from "../src/lib/constants/markets";
import {
  type EconomicEvent,
  fetchEconomicCalendar,
  getEventCurrencies,
  isWithinVetoWindow,
} from "../src/lib/market-data/economic-calendar";
import type { BarInterval } from "../src/lib/market-data/interval";
import { fetchDailyPrices } from "../src/lib/market-data/prices";
import { resampleTo } from "../src/lib/market-data/resample";
import type { PriceBar } from "../src/lib/market-data/types";

/** Read the full Supabase `price_cache` row for a ticker+interval pair,
 *  ignoring TTL. The cache has 2.4yr of XAU/USD 1h bars; provider calls
 *  via Twelve Data cap at 5000 bars (~7mo) regardless of outputsize=full,
 *  so for any historical-window WF we have to source from the persistent
 *  cache. Production's getCachedPrices uses the server (cookie-bound)
 *  Supabase client which doesn't work in a Node script — we duplicate
 *  the read with a service-role client here.
 *  Returns null on miss; caller should fall back to fetchDailyPrices. */
async function loadFullCachedBars(
  ticker: string,
  interval: BarInterval
): Promise<PriceBar[] | null> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return null;
  const supabase = createSupabaseClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // Pick the row with the largest bar_count so we always grab the most
  // historically-deep cache entry available. Multiple rows can exist
  // (different output_size keys); we want the deepest.
  const { data, error } = await supabase
    .from("price_cache")
    .select("bars, bar_count, fetched_at")
    .eq("ticker", ticker.toUpperCase())
    .eq("interval", interval)
    .order("bar_count", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { bars: PriceBar[] }).bars ?? null;
}

/** Wrapper: prefer the Supabase cache (full historical depth) and fall
 *  back to the provider chain if the cache is empty or stale. Used by
 *  loadCorpus to source 1h primary, daily, and EUR/USD 4h bars. */
async function fetchOrCachedFull(
  ticker: string,
  interval: BarInterval
): Promise<PriceBar[]> {
  const cached = await loadFullCachedBars(ticker, interval);
  if (cached && cached.length > 0) return cached;
  return await fetchDailyPrices(ticker, "full", interval);
}
import {
  DEFAULT_PROMPT_VERSION,
  type PromptVersion,
  getPrompt,
} from "../src/lib/scan/llm-trader-prompts";

/** Production gate config — mirrors the deployed algorithm's rules so
 *  the backtest exercises exactly what live would. Tracks the deployed
 *  Gold LLM-Trader v1 row's rules (see scripts/deploy-llm-trader.ts).
 *  Deviations from this would mean backtest stats overstate live.
 *
 *  Operator path: FTMO 2-step challenge (no consistency rule). Set
 *  consistency_rule = 0 to disable. If switching back to 1-step, set
 *  to 40 (and update the deployed algo's rules.prop_firm to match). */
const PRODUCTION_GATES = {
  stagnant_exit: {
    enabled: true,
    max_bars: 48,
    min_pnl_r: -0.5,
    min_excursion_r: 0.1,
  },
  prop_firm: {
    consistency_rule: 0, // 2-step path — no best-day rule
    consecutive_loss_daily_halt: 2,
    max_consecutive_losses: 0,
    daily_loss_limit: 5,
  },
  news_veto: {
    enabled: true,
    min_impact: "high" as const,
    block_minutes_before: 5,
    block_minutes_after: 15,
  },
} as const;

/** Significant-loss cutoff for the consec-loss halt. Mirrors production
 *  (see src/lib/scan/consec-loss-halt.ts SIGNIFICANT_LOSS_R_THRESHOLD).
 *  Lowered 0.5 → 0.25 (2026-05-05) to catch mid-magnitude llm_exit
 *  losses that were silently skipped under the old threshold. */
const SIGNIFICANT_LOSS_R_THRESHOLD = 0.25;

/** A loss only counts toward the consec-streak if its magnitude is at
 *  least 0.25R. Mirrors `isSignificantLoss` in production — keeps tiny
 *  stagnant-cut nips from falsely tripping the halt. */
function isSignificantLossTrade(t: ClosedTrade): boolean {
  if (t.realized_pnl >= 0) return false;
  return Math.abs(t.r_multiple) >= SIGNIFICANT_LOSS_R_THRESHOLD;
}

/** Walk today's closed trades from most-recent backwards, count how many
 *  consecutive significant losses sit at the end. Wins/break-evens
 *  terminate immediately; micro losses (< 0.5R) are skipped without
 *  resetting. Returns the active streak length for `dateUTC`. */
function consecLossStreakOnDate(closed: ClosedTrade[], dateUTC: string): number {
  const today = closed.filter((t) => t.exit_date.slice(0, 10) === dateUTC);
  let streak = 0;
  for (let i = today.length - 1; i >= 0; i--) {
    const t = today[i];
    if (t.realized_pnl >= 0) break;
    if (!isSignificantLossTrade(t)) continue;
    streak++;
  }
  return streak;
}

/** FTMO consistency halt — refuse new entries on a day whose net profit
 *  is at or above (consistency_rule / 100) of total accumulated profit.
 *  Mirrors production's checkConsistencyHalt, including the explicit
 *  disabled-when-zero short-circuit (without it, threshold=0 trips on
 *  every winning day — the rule is OFF when consistency_rule is 0). */
function consistencyHaltState(
  closed: ClosedTrade[],
  dateUTC: string
): { ratio: number; tripped: boolean } {
  if (PRODUCTION_GATES.prop_firm.consistency_rule === 0) {
    return { ratio: 0, tripped: false };
  }
  const today = closed.filter((t) => t.exit_date.slice(0, 10) === dateUTC);
  const todayNet = today.reduce((s, t) => s + t.realized_pnl, 0);
  const totalNet = closed.reduce((s, t) => s + t.realized_pnl, 0);
  if (totalNet <= 0 || todayNet <= 0) return { ratio: 0, tripped: false };
  const ratio = todayNet / totalNet;
  const threshold = PRODUCTION_GATES.prop_firm.consistency_rule / 100;
  return { ratio, tripped: ratio >= threshold };
}

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
  decision: z.enum(["enter_long", "enter_short", "hold", "exit", "move_be"]),
  confidence: z.number().min(0).max(100),
  reasoning: z.string().min(1).max(2000),
});

export type Decision = z.infer<typeof decisionSchema>;

// Daily-structure regime tag derived from HH/LH price action. Primary
// signal for adaptation diagnostics — we want to know whether the LLM
// behaves differently in HH vs LH vs transition windows, and whether
// regime flips during a trade correlate with outcome.
export type Regime = "HH" | "LH" | "RANGING" | "n/a";

export interface OpenPosition {
  side: "long" | "short";
  entry_price: number;
  entry_index: number;
  entry_date: string;
  stop_price: number;
  /** Snapshot of the entry-to-SL distance — write-once, never mutated.
   *  stop_price gets moved to entry on `move_be`, which would otherwise
   *  destroy the original 1R needed for the R-multiple on close.
   *  Mirrors paper_positions.initial_stop_loss_price (migration 00032). */
  initial_stop_price: number;
  target_price: number;
  notional: number;
  entry_reasoning: string;
  entry_regime: Regime;
}

export interface ClosedTrade {
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
  // Outcome attribution (Layer 1 learning loop) — populated on close.
  entry_regime: Regime;
  exit_regime: Regime;
  regime_flipped_during_trade: boolean;
  // R-multiple: realised P&L expressed as multiples of risk (entry-to-SL
  // distance). +1.0 = full TP at 1:3 RR is +3.0, full SL is -1.0. Lets
  // us aggregate across position sizes / windows on a common scale.
  r_multiple: number;
}

export interface DecisionLogEntry {
  bar_date: string;
  bar_close: number;
  regime: Regime;
  decision: string;
  confidence: number;
  reasoning: string;
  had_position: string;
}

/** SL/TP profile — controlled by env vars so the same harness can test
 *  fixed-% (legacy v1/v2) AND structural placement (v3 short-term swing).
 *  Defaults preserve old behavior (1.5% / 4.5% / 3:1 RR).
 *
 *  SL:
 *    SL_TYPE=percentage|swing_anchor (default: percentage)
 *    SL_VALUE=<number> — for percentage: SL distance as fraction (0.015
 *      = 1.5%); for swing_anchor: ATR-buffer multiplier added beyond the
 *      structural swing (0.25 = 25% of ATR)
 *    SL_LOOKBACK=<int> — swing_anchor only, default 8
 *  TP:
 *    TP_TYPE=percentage|rr_multiple (default: percentage)
 *    TP_VALUE=<number> — for percentage: TP distance as fraction (0.045
 *      = 4.5%); for rr_multiple: RR ratio (3 = TP at 3× SL distance) */
const SL_TYPE = (process.env.SL_TYPE ?? "percentage") as "percentage" | "swing_anchor";
const SL_VALUE = Number(process.env.SL_VALUE ?? (SL_TYPE === "swing_anchor" ? "0.25" : "0.015"));
const SL_LOOKBACK = Number(process.env.SL_LOOKBACK ?? "8");
const TP_TYPE = (process.env.TP_TYPE ?? "percentage") as "percentage" | "rr_multiple";
const TP_VALUE = Number(process.env.TP_VALUE ?? (TP_TYPE === "rr_multiple" ? "3" : "0.045"));

// Legacy constants — only used in fallback paths if SL_TYPE/TP_TYPE are
// percentage. Real path is `computeSlForBacktest` / `computeTpForBacktest`.
const SL_PCT = SL_TYPE === "percentage" ? SL_VALUE : 0.015;
const TP_PCT = TP_TYPE === "percentage" ? TP_VALUE : 0.045;

/** SL config for backtest entries. Per-algo config in multi-algo runs;
 *  defaults to module-level env vars in single-algo runs (back-compat). */
export interface SlConfig {
  type: "percentage" | "swing_anchor";
  value: number;
  lookback?: number;
}

/** TP config for backtest entries. */
export interface TpConfig {
  type: "percentage" | "rr_multiple";
  value: number;
}

/** Adaptive TP context for the backtest harness. Mirrors production's
 *  AdaptiveTpContext (src/lib/algorithm/structural-sl.ts).
 *  - regime-aware base RR (RANGING gets 1.5R for rr_multiple rules)
 *  - ATR cap (≤ 1.5 × daily ATR)
 *  - RR-≥-1 floor */
export interface BacktestAdaptiveTpCtx {
  regime: Regime;
  dailyAtr: number;
}

const RANGING_RR = 1.5;
const ATR_CAP_MULTIPLIER = 1.5;

/** Compute SL distance for the backtest's entry. For "percentage" returns
 *  entryPrice × value. For "swing_anchor" looks back N bars to find the
 *  swing low (long) or high (short), then adds an ATR buffer of value ×
 *  ATR(14) so the SL sits just past the structural level.
 *
 *  cfg defaults to env-var values for single-algo runs. Multi-algo
 *  callers pass explicit per-algo SL config. */
export function computeSlForBacktest(
  bars: PriceBar[],
  entryIdx: number,
  side: "long" | "short",
  entryPrice: number,
  cfg: SlConfig = { type: SL_TYPE, value: SL_VALUE, lookback: SL_LOOKBACK }
): number {
  if (cfg.type === "percentage") return entryPrice * cfg.value;
  // swing_anchor
  const lookback = cfg.lookback ?? 8;
  const start = Math.max(0, entryIdx - lookback);
  let level: number;
  if (side === "long") {
    let lowest = Infinity;
    for (let j = start; j <= entryIdx; j++) lowest = Math.min(lowest, bars[j].low);
    level = lowest;
  } else {
    let highest = -Infinity;
    for (let j = start; j <= entryIdx; j++) highest = Math.max(highest, bars[j].high);
    level = highest;
  }
  const baseDistance = side === "long" ? entryPrice - level : level - entryPrice;
  if (cfg.value <= 0 || baseDistance <= 0) return Math.max(baseDistance, 0);
  // Inline ATR(14) computation — mirrors src/lib/algorithm/structural-sl.ts
  // intent. Avoids the production dependency since this script is standalone.
  const atrPeriod = 14;
  const atrStart = Math.max(1, entryIdx - atrPeriod + 1);
  let trSum = 0;
  let trCount = 0;
  for (let i = atrStart; i <= entryIdx; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
    trSum += tr;
    trCount++;
  }
  const atr = trCount > 0 ? trSum / trCount : 0;
  return baseDistance + cfg.value * atr;
}

/** Compute TP distance for the backtest's entry. Mirrors production
 *  computeTpDistance with optional adaptive context: regime-aware base
 *  RR (RANGING gets 1.5R for rr_multiple) + ATR cap + RR-≥-1 floor.
 *
 *  cfg defaults to env-var values for single-algo runs. Multi-algo
 *  callers pass explicit per-algo TP config + adaptive context. */
export function computeTpForBacktest(
  slDistance: number,
  entryPrice: number,
  cfg: TpConfig = { type: TP_TYPE, value: TP_VALUE },
  adaptiveCtx?: BacktestAdaptiveTpCtx
): number {
  let tpDistance: number;
  if (cfg.type === "percentage") {
    tpDistance = entryPrice * cfg.value;
  } else {
    const baseRr =
      adaptiveCtx?.regime === "RANGING" ? RANGING_RR : cfg.value;
    tpDistance = baseRr * slDistance;
  }
  if (adaptiveCtx?.dailyAtr !== undefined && adaptiveCtx.dailyAtr > 0) {
    tpDistance = Math.min(tpDistance, ATR_CAP_MULTIPLIER * adaptiveCtx.dailyAtr);
  }
  return Math.max(tpDistance, slDistance);
}

export function summariseDailyBias(dailyBars: PriceBar[]): { summary: string; regime: Regime } {
  if (dailyBars.length < 21) return { summary: "daily: n/a", regime: "n/a" };
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
  let regime: Regime;
  if (last3High > prev3High && last3Low > prev3Low) regime = "HH";
  else if (last3High < prev3High && last3Low < prev3Low) regime = "LH";
  else regime = "RANGING";
  // Lead with structure (the primary regime indicator per the prompt
  // hierarchy). Present SMA20 as raw data, not a "(bullish/bearish)" label,
  // so the LLM applies the hierarchy explicitly rather than anchoring on
  // the indicator alone.
  const smaPct = ((last.close - sma20) / sma20) * 100;
  const summary = `D1 structure: ${regime}. Close ${last.close.toFixed(0)} (${smaPct >= 0 ? "+" : ""}${smaPct.toFixed(2)}% vs SMA20 ${sma20.toFixed(0)}). 14d ${greenDays}G/${14 - greenDays}R. Range ${low14.toFixed(0)}-${high14.toFixed(0)}.`;
  return { summary, regime };
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

export function summariseRecentBars(bars: PriceBar[], idx: number, tfLabel: string): string {
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

export function summariseDxy(eurusdBars: PriceBar[], currentTs: string): string {
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

export interface IntermarketSeries {
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

export function summariseIntermarket(im: IntermarketSeries, goldClose: number, currentTs: string): string {
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

export function summarisePosition(position: OpenPosition | null, currentPrice: number): string {
  if (!position) return "FLAT.";
  const pnlPct =
    position.side === "long"
      ? ((currentPrice - position.entry_price) / position.entry_price) * 100
      : ((position.entry_price - currentPrice) / position.entry_price) * 100;
  return `${position.side.toUpperCase()} from ${position.entry_price.toFixed(0)}, cur ${currentPrice.toFixed(0)}, P&L ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%, SL ${position.stop_price.toFixed(0)}/TP ${position.target_price.toFixed(0)}.`;
}

/** Multi-TF structural read for the v5 prompt. Mirrors production
 *  `summariseHigherTfStructure` in src/lib/scan/llm-trader.ts. Outputs
 *  HH/LH/RANGING + 20-bar range + 3-bar momentum per higher TF. */
export function summariseHigherTfStructure(
  higherTfBars: { tfLabel: string; bars: PriceBar[] }[],
  currentTs: string
): string {
  if (higherTfBars.length === 0) return "";
  const ts = new Date(currentTs).getTime();
  const lines: string[] = [];
  for (const { tfLabel, bars } of higherTfBars) {
    const before = bars.filter((b) => new Date(b.date).getTime() <= ts);
    if (before.length < 8) continue;
    const recent = before.slice(-14);
    const last3High = Math.max(...recent.slice(-3).map((b) => b.high));
    const prev3High = Math.max(...recent.slice(-7, -3).map((b) => b.high));
    const last3Low = Math.min(...recent.slice(-3).map((b) => b.low));
    const prev3Low = Math.min(...recent.slice(-7, -3).map((b) => b.low));
    let regime: "HH" | "LH" | "RANGING";
    if (last3High > prev3High && last3Low > prev3Low) regime = "HH";
    else if (last3High < prev3High && last3Low < prev3Low) regime = "LH";
    else regime = "RANGING";
    const window20 = before.slice(-20);
    const swingHigh = Math.max(...window20.map((b) => b.high));
    const swingLow = Math.min(...window20.map((b) => b.low));
    const cur = before[before.length - 1];
    const mom3 =
      before.length >= 4
        ? ((cur.close - before[before.length - 4].close) / before[before.length - 4].close) * 100
        : 0;
    lines.push(
      `${tfLabel}: ${regime} (range ${swingLow.toFixed(0)}-${swingHigh.toFixed(0)}, mom ${mom3 >= 0 ? "+" : ""}${mom3.toFixed(2)}%)`
    );
  }
  return lines.length > 0 ? `Higher TF: ${lines.join(" | ")}.` : "";
}

export type Provider = "groq" | "anthropic";

export interface ProviderClients {
  groq?: ReturnType<typeof getAIClient>;
  anthropic?: Anthropic;
}

export const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

export function createClients(provider: Provider): ProviderClients {
  const clients: ProviderClients = {};
  if (provider === "groq") clients.groq = getAIClient();
  if (provider === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY env var required for anthropic provider");
    }
    clients.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return clients;
}

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
  systemPrompt: string,
  context: string
): Promise<{ decision: Decision | null; rawText: string }> {
  const res = await client.chat.completions.create({
    model: AI_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: context },
    ],
    response_format: { type: "json_object" },
    // 600 to match production. v3-style hold responses fit ~50; entry
    // responses with reasoning can run 150-250.
    max_tokens: 600,
    temperature: 0.2,
  });
  const text = res.choices[0]?.message?.content ?? "{}";
  const raw = extractJson(text);
  const parsed = decisionSchema.safeParse(raw);
  return { decision: parsed.success ? parsed.data : null, rawText: text };
}

async function callAnthropic(
  client: Anthropic,
  systemPrompt: string,
  context: string
): Promise<{ decision: Decision | null; rawText: string }> {
  const res = await client.messages.create({
    model: ANTHROPIC_MODEL,
    // 600 matches production llm-trader.ts. Haiku's verbose markdown
    // analyses + ```json wrappers occasionally exceed 200 tokens; 600
    // covers ~95% of observed responses without appreciably increasing cost.
    max_tokens: 600,
    system: systemPrompt,
    messages: [{ role: "user", content: context }],
  });
  const block = res.content[0];
  const text = block && block.type === "text" ? block.text : "{}";
  const raw = extractJson(text);
  const parsed = decisionSchema.safeParse(raw);
  return { decision: parsed.success ? parsed.data : null, rawText: text };
}

/** Failure-type taxonomy for diagnostics. Backtest fail rates spike under
 *  multi-algo because parallel calls hit Anthropic rate limits more often.
 *  Tracking the error type lets us tell rate-limit (transient, retry helps)
 *  from parse-fail (prompt issue, retry doesn't help). */
export type LlmFailType = "rate_limit" | "parse_fail" | "network" | "other";

export function classifyLlmError(err: unknown): LlmFailType {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("rate") || msg.includes("429") || msg.includes("overloaded"))
      return "rate_limit";
    if (msg.includes("network") || msg.includes("econnreset") || msg.includes("timeout"))
      return "network";
  }
  return "other";
}

/** LLM call with single retry + 1.5s sleep on transient errors. Returns
 *  { decision, failType, rawText } so multi-algo can track failure
 *  taxonomy AND inspect raw LLM output on parse fails. */
export async function callLLMWithDiagnostic(
  provider: Provider,
  clients: ProviderClients,
  systemPrompt: string,
  context: string
): Promise<{ decision: Decision | null; failType: LlmFailType | null; rawText: string | null }> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let result: { decision: Decision | null; rawText: string };
      if (provider === "anthropic") {
        if (!clients.anthropic) throw new Error("anthropic client not initialised");
        result = await callAnthropic(clients.anthropic, systemPrompt, context);
      } else {
        if (!clients.groq) throw new Error("groq client not initialised");
        result = await callGroq(clients.groq, systemPrompt, context);
      }
      if (result.decision === null) {
        // Parse fail — schema mismatch, retry won't help
        return { decision: null, failType: "parse_fail", rawText: result.rawText };
      }
      return { decision: result.decision, failType: null, rawText: result.rawText };
    } catch (err) {
      lastErr = err;
      const failType = classifyLlmError(err);
      // Retry rate_limit + network failures once with a short sleep.
      if (attempt === 0 && (failType === "rate_limit" || failType === "network")) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      return { decision: null, failType, rawText: null };
    }
  }
  return { decision: null, failType: classifyLlmError(lastErr), rawText: null };
}

/** Backward-compatible wrapper around callLLMWithDiagnostic — drops the
 *  failType + rawText. Single-algo runWindow uses this; multi-algo uses
 *  callLLMWithDiagnostic directly for richer failure tracking. */
async function callLLM(
  provider: Provider,
  clients: ProviderClients,
  systemPrompt: string,
  context: string
): Promise<Decision | null> {
  const { decision } = await callLLMWithDiagnostic(provider, clients, systemPrompt, context);
  return decision;
}

export function findExitOnNextBar(
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

/** R-multiple: realised P&L expressed as multiples of risk (entry-to-SL
 *  distance). For a long taken at 4000 with SL 3940 (60 pts risk), an
 *  exit at 4180 = +3R. Lets per-trade outcomes aggregate on a common
 *  scale across position sizes / capital values / windows. */
export function computeRMultiple(
  side: "long" | "short",
  entryPrice: number,
  stopPrice: number,
  exitPrice: number
): number {
  const risk = side === "long" ? entryPrice - stopPrice : stopPrice - entryPrice;
  if (risk <= 0) return 0; // defensive — bad SL placement
  const move = side === "long" ? exitPrice - entryPrice : entryPrice - exitPrice;
  return move / risk;
}

export interface RegimeStats {
  regime: Regime;
  count: number;
  wins: number;
  win_rate_pct: number;
  mean_r: number;
  sum_pnl: number;
  long_count: number;
  long_wins: number;
  short_count: number;
  short_wins: number;
}

/** Per-entry-regime trade stats. Tells us whether the LLM's edge holds
 *  symmetrically across regimes or is concentrated in (e.g.) HH-longs.
 *  Group key is `entry_regime` — what regime the LLM was looking at when
 *  it pulled the trigger. */
export function aggregateByRegime(trades: ClosedTrade[]): RegimeStats[] {
  const groups = new Map<Regime, ClosedTrade[]>();
  for (const t of trades) {
    const arr = groups.get(t.entry_regime) ?? [];
    arr.push(t);
    groups.set(t.entry_regime, arr);
  }
  const out: RegimeStats[] = [];
  for (const [regime, arr] of groups) {
    const wins = arr.filter((t) => t.realized_pnl > 0);
    const longs = arr.filter((t) => t.side === "long");
    const shorts = arr.filter((t) => t.side === "short");
    out.push({
      regime,
      count: arr.length,
      wins: wins.length,
      win_rate_pct: arr.length === 0 ? 0 : (wins.length / arr.length) * 100,
      mean_r: arr.length === 0 ? 0 : arr.reduce((s, t) => s + t.r_multiple, 0) / arr.length,
      sum_pnl: arr.reduce((s, t) => s + t.realized_pnl, 0),
      long_count: longs.length,
      long_wins: longs.filter((t) => t.realized_pnl > 0).length,
      short_count: shorts.length,
      short_wins: shorts.filter((t) => t.realized_pnl > 0).length,
    });
  }
  // Sort by count desc so the most-active regime shows first.
  out.sort((a, b) => b.count - a.count);
  return out;
}

export interface FlipCohortStats {
  flipped: { count: number; wins: number; mean_r: number; sum_pnl: number };
  not_flipped: { count: number; wins: number; mean_r: number; sum_pnl: number };
}

/** "Did the regime flip during the trade?" cohort. Directly tests the
 *  v1 prompt's regime-flip-exit logic — the LLM is told to exit
 *  HH-while-long when regime turns LH. If the prompt is working,
 *  flipped trades should still net positive (the exit caught the turn);
 *  if it's broken, flipped trades will be much worse than non-flipped. */
export function aggregateByRegimeFlip(trades: ClosedTrade[]): FlipCohortStats {
  const flipped = trades.filter((t) => t.regime_flipped_during_trade);
  const notFlipped = trades.filter((t) => !t.regime_flipped_during_trade);
  const summarise = (arr: ClosedTrade[]) => ({
    count: arr.length,
    wins: arr.filter((t) => t.realized_pnl > 0).length,
    mean_r: arr.length === 0 ? 0 : arr.reduce((s, t) => s + t.r_multiple, 0) / arr.length,
    sum_pnl: arr.reduce((s, t) => s + t.realized_pnl, 0),
  });
  return { flipped: summarise(flipped), not_flipped: summarise(notFlipped) };
}

/** What did the LLM choose at each regime? Tells us whether it's biasing
 *  decisions correctly: HH should be enter_long-heavy, LH should be
 *  enter_short-heavy. If LH bars are mostly enter_long, the prompt's
 *  regime-priority hierarchy is broken. */
export function aggregateDecisionsByRegime(
  decisions: DecisionLogEntry[]
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const d of decisions) {
    const key = d.regime;
    if (!out[key]) out[key] = {};
    out[key][d.decision] = (out[key][d.decision] ?? 0) + 1;
  }
  return out;
}

export function printRegimeReport(
  trades: ClosedTrade[],
  decisions: DecisionLogEntry[]
): void {
  const regimeStats = aggregateByRegime(trades);
  const flipStats = aggregateByRegimeFlip(trades);
  const decisionStats = aggregateDecisionsByRegime(decisions);

  console.log("Per-regime trade stats (entry-regime):");
  console.log(
    `  ${pad("regime", 10)}${pad("trades", 8)}${pad("WR", 8)}${pad("mean_R", 9)}${pad("$pnl", 10)}${pad("long(W/T)", 12)}${pad("short(W/T)", 12)}`
  );
  for (const s of regimeStats) {
    console.log(
      `  ${pad(s.regime, 10)}${pad(s.count.toString(), 8)}${pad(`${s.win_rate_pct.toFixed(0)}%`, 8)}${pad(s.mean_r.toFixed(2), 9)}${pad(`$${s.sum_pnl.toFixed(0)}`, 10)}${pad(`${s.long_wins}/${s.long_count}`, 12)}${pad(`${s.short_wins}/${s.short_count}`, 12)}`
    );
  }
  console.log("");

  console.log("Regime-flip cohort (did regime change between entry and exit?):");
  const fmtCohort = (label: string, c: { count: number; wins: number; mean_r: number; sum_pnl: number }) => {
    const wr = c.count === 0 ? 0 : (c.wins / c.count) * 100;
    console.log(
      `  ${pad(label, 16)}${pad(c.count.toString(), 8)}${pad(`${wr.toFixed(0)}%`, 8)}${pad(c.mean_r.toFixed(2), 9)}${pad(`$${c.sum_pnl.toFixed(0)}`, 10)}`
    );
  };
  console.log(`  ${pad("cohort", 16)}${pad("trades", 8)}${pad("WR", 8)}${pad("mean_R", 9)}${pad("$pnl", 10)}`);
  fmtCohort("flipped", flipStats.flipped);
  fmtCohort("not_flipped", flipStats.not_flipped);
  console.log("");

  console.log("LLM decisions per regime (does the regime hierarchy hold?):");
  console.log(
    `  ${pad("regime", 10)}${pad("enter_long", 12)}${pad("enter_short", 13)}${pad("hold", 8)}${pad("exit", 8)}`
  );
  for (const [regime, dist] of Object.entries(decisionStats)) {
    console.log(
      `  ${pad(regime, 10)}${pad((dist.enter_long ?? 0).toString(), 12)}${pad((dist.enter_short ?? 0).toString(), 13)}${pad((dist.hold ?? 0).toString(), 8)}${pad((dist.exit ?? 0).toString(), 8)}`
    );
  }
  console.log("");
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

// ---------------------------------------------------------------------------
// Reusable building blocks (Corpus + runWindow) — used by both the CLI
// single-window mode below and the walk-forward orchestrator. Loading the
// XAU/USD corpus is the expensive part (Twelve Data + intermarket fetches);
// keeping it separate lets the WF script load once and run N windows.
// ---------------------------------------------------------------------------

export type Timeframe = "4h" | "1h" | "30m" | "15m";

export interface Corpus {
  bars: PriceBar[];
  dailyBars: PriceBar[];
  /** EUR/USD 4h bars used as a DXY proxy in the LLM prompt. For
   *  commodity backtests this is intermarket context (USD strength).
   *  For forex backtests where the primary pair IS EUR/USD, this is
   *  degenerate — the runWindow loop suppresses the DXY block in
   *  that case to avoid feeding the LLM its own bars. */
  eurusd4h: PriceBar[];
  /** Gold-specific intermarket series (XAU/XAG, ^TNX, ^VIX). Always
   *  fetched for commodity tickers; empty struct for forex (the
   *  summariser then prints "Intermarket: n/a" and the LLM's prompt
   *  context skips the block entirely). */
  intermarket: IntermarketSeries;
  timeframe: Timeframe;
  /** The instrument the corpus is loaded for. Used by runWindow to
   *  pick the right news-veto currencies and to suppress gold-only
   *  intermarket context for forex pairs. */
  ticker: string;
  /** Resolved from the markets catalog. "commodity" enables the
   *  XAU/XAG + yields + VIX prompt block; "forex" suppresses it. */
  assetClass: InstrumentClass;
}

export interface WindowOptions {
  corpus: Corpus;
  /** Window end as unix ms; window covers (sliceEndMs − sliceDays·24h, sliceEndMs]. */
  sliceEndMs: number;
  sliceDays: number;
  capital: number;
  provider: Provider;
  clients: ProviderClients;
  /** Prompt version to use. Defaults to DEFAULT_PROMPT_VERSION (v2 currently).
   *  Pass "v1" to reproduce the validated baseline. */
  promptVersion?: PromptVersion;
  /** Pre-fetched economic events covering the slice range. When absent,
   *  runWindow fetches its own (uses Finnhub's in-memory cache). The WF
   *  orchestrator pre-fetches across the full grid to avoid 6 separate
   *  Finnhub round-trips. */
  economicEvents?: EconomicEvent[];
  /** Stop the replay loop after N closed trades have accumulated.
   *  Useful for early evaluation of a new prompt version (e.g. "give me
   *  40 trades and stop") without committing to the full window cost.
   *  When unset, runs through all bars in the slice. */
  maxTrades?: number;
  /** Per-trade risk as a percentage of capital (e.g. 1.0 = 1%). When
   *  set, position notional is computed dynamically per-trade so that
   *  a full SL hit always loses exactly `capital × pct/100` dollars,
   *  regardless of SL distance. This matches the live algo's
   *  `risk_per_trade` sizing — without it, the backtest uses fixed
   *  `notional = capital × 0.5` which produces variable dollar P&L
   *  per R-multiple and is NOT directly comparable to live results.
   *
   *  When unset, retains legacy fixed-notional sizing for backward
   *  compatibility with prior runs. */
  riskPerTradePct?: number;
  /** Suppress per-bar progress logs (the WF orchestrator prints its own). */
  silent?: boolean;
}

/** Aggregate gate refusal counts. Tracks how often each production gate
 *  refused entries the LLM otherwise wanted to take, so the comparison
 *  output shows the cost of each gate. */
export interface GateRefusals {
  atr_liquidity: number;
  news_veto: number;
  consec_loss_halt: number;
  ftmo_consistency_halt: number;
  stagnant_exits: number;
  ranging_regime: number;
}

export interface WindowResult {
  trades: ClosedTrade[];
  decisions: DecisionLogEntry[];
  finalCash: number;
  capital: number;
  maxDrawdown: number;
  llmCalls: number;
  llmFailures: number;
  startDate: string;
  endDate: string;
  numBars: number;
  windowLabel: string;
  promptVersion: PromptVersion;
  gateRefusals: GateRefusals;
}

export async function loadCorpus(
  timeframe: Timeframe,
  ticker: string = "XAU/USD"
): Promise<Corpus> {
  const meta = INSTRUMENT_CATALOG.find((m) => m.symbol === ticker.toUpperCase());
  if (!meta) {
    throw new Error(
      `loadCorpus: ${ticker} not in INSTRUMENT_CATALOG. Add it to FOREX_PAIRS or COMMODITIES first.`
    );
  }
  const assetClass = meta.assetClass;
  let fetchInterval: BarInterval;
  let needsResample: false | "4h" | "30m";
  if (timeframe === "4h") {
    fetchInterval = "4h";
    needsResample = false;
  } else if (timeframe === "1h") {
    fetchInterval = "1h";
    needsResample = false;
  } else if (timeframe === "30m") {
    // OANDA backfill populated price_cache with native 30min XAU bars
    // (28 months as of 2026-05-06). Use directly instead of fetching
    // 15min and resampling — matches what live's getCachedPrices does.
    fetchInterval = "30min";
    needsResample = false;
  } else {
    fetchInterval = "15min";
    needsResample = false;
  }

  console.log(
    `Loading ${ticker} ${timeframe} corpus (fetched at ${fetchInterval}${needsResample ? `, resampled to ${needsResample}` : ""})...`
  );
  const fetched = await fetchOrCachedFull(ticker, fetchInterval);
  const bars = needsResample ? resampleTo(fetched, needsResample) : fetched;
  const dailyBars = await fetchOrCachedFull(ticker, "1day");
  console.log(`  ${timeframe} corpus: ${bars.length} bars (${bars[0]?.date.slice(0, 10) ?? "?"} → ${bars[bars.length - 1]?.date.slice(0, 10) ?? "?"})`);
  console.log(`  daily corpus: ${dailyBars.length} bars`);

  // EUR/USD 4h: loaded as a DXY proxy. Pointless when backtesting
  // EUR/USD itself (the bars would equal the primary series). For
  // other forex pairs it still gives the LLM some USD-strength
  // context, so we load it everywhere except EUR/USD.
  let eurusd4h: PriceBar[] = [];
  if (ticker.toUpperCase() !== "EUR/USD") {
    console.log("Loading EUR/USD 4h proxy...");
    eurusd4h = await fetchOrCachedFull("EUR/USD", "4h");
    console.log(`  EUR/USD 4h: ${eurusd4h.length} bars`);
  } else {
    console.log("Skipping DXY proxy load (primary is EUR/USD).");
  }

  // Gold-specific intermarket (silver, yields, VIX) — only meaningful
  // for commodity backtests. For forex the summariser sees an empty
  // struct and prints "Intermarket: n/a", which the LLM ignores.
  let intermarket: IntermarketSeries = {};
  if (assetClass === "commodity") {
    console.log("Loading intermarket series (silver / yields / VIX)...");
    intermarket = await loadIntermarket();
    console.log(
      `  silver: ${intermarket.silver?.length ?? 0} bars · 10Y yield: ${intermarket.yield10y?.length ?? 0} bars · VIX: ${intermarket.vix?.length ?? 0} bars`
    );
  } else {
    console.log(`Skipping commodity intermarket load (asset class: ${assetClass}).`);
  }
  console.log("");

  return { bars, dailyBars, eurusd4h, intermarket, timeframe, ticker: ticker.toUpperCase(), assetClass };
}

export async function runWindow(opts: WindowOptions): Promise<WindowResult> {
  const {
    corpus,
    sliceEndMs,
    sliceDays,
    capital,
    provider,
    clients,
    promptVersion = DEFAULT_PROMPT_VERSION,
    maxTrades,
    riskPerTradePct,
    silent = false,
  } = opts;
  const { bars, dailyBars, eurusd4h, intermarket, timeframe, ticker } = corpus;
  const systemPrompt = getPrompt(promptVersion);

  // Position-sizing helper. When riskPerTradePct is set, sizes the
  // position so a full SL hit loses exactly `capital × pct/100`
  // dollars — matching the live algo's `risk_per_trade` config and
  // producing dollar P&L directly comparable to live. Without it,
  // falls back to legacy fixed-notional sizing (capital × 0.5) for
  // backward compatibility with older runs.
  const computeNotional = (entryPrice: number, slDistance: number): number => {
    if (riskPerTradePct === undefined || riskPerTradePct <= 0) {
      return capital * 0.5;
    }
    if (slDistance <= 0) return capital * 0.5; // defensive — degenerate SL
    const riskDollars = capital * (riskPerTradePct / 100);
    return (riskDollars * entryPrice) / slDistance;
  };

  // News veto setup. Fetch events once for this slice if not pre-fetched.
  // Forex: BOTH base + quote currencies (EUR/USD → ["EUR","USD"]).
  // Gold: USD-only. getEventCurrencies handles the split internally.
  const newsCurrencies = getEventCurrencies(ticker);
  let newsEvents: EconomicEvent[] = opts.economicEvents ?? [];
  if (newsEvents.length === 0 && PRODUCTION_GATES.news_veto.enabled) {
    const sliceStartMs = sliceEndMs - sliceDays * 24 * 3600 * 1000;
    newsEvents = await fetchEconomicCalendar(
      new Date(sliceStartMs),
      new Date(sliceEndMs)
    );
    if (!silent) {
      console.log(`  News calendar: ${newsEvents.length} events for window`);
    }
  }

  // Slice bars to (sliceEndMs − sliceDays, sliceEndMs].
  const cutoffMs = sliceEndMs - sliceDays * 24 * 3600 * 1000;
  const startIdx = bars.findIndex((b) => new Date(b.date).getTime() >= cutoffMs);
  if (startIdx === -1) throw new Error(`no ${timeframe} bars in slice window`);
  const endIdxExclusive = bars.findIndex((b) => new Date(b.date).getTime() > sliceEndMs);
  const lastIdx = endIdxExclusive === -1 ? bars.length : endIdxExclusive;
  const numBars = lastIdx - startIdx;
  if (numBars <= 0) throw new Error(`empty slice — sliceEndMs / sliceDays produced no bars`);

  const sliceEndDate = new Date(sliceEndMs).toISOString().slice(0, 10);
  const windowLabel = `${sliceEndDate} − ${sliceDays}d`;
  const startDate = bars[startIdx]?.date ?? "";
  const endDate = bars[lastIdx - 1]?.date ?? "";

  if (!silent) {
    console.log(
      `Replaying ${numBars} ${timeframe} bars (${windowLabel}: ${startDate.slice(0, 10)} → ${endDate.slice(0, 10)})...`
    );
  }

  // v5 + v5_15m prompts require multi-TF context. Precompute higher-TF
  // bars once per run; per-bar slice is by timestamp inside
  // summariseHigherTfStructure. Pairings:
  //   30m primary → 1h + 4h (v5)
  //   15m primary → 30m + 1h (v5_15m)
  //   1h primary  → 4h only (degraded — only for ad-hoc experimentation)
  const useMultiTf = promptVersion === "v5" || promptVersion === "v5_15m";
  const higherTfBars: { tfLabel: string; bars: PriceBar[] }[] = useMultiTf
    ? timeframe === "30m"
      ? [
          { tfLabel: "1h", bars: resampleTo(bars, "1h") },
          { tfLabel: "4h", bars: resampleTo(bars, "4h") },
        ]
      : timeframe === "15m"
        ? [
            { tfLabel: "30m", bars: resampleTo(bars, "30min") },
            { tfLabel: "1h", bars: resampleTo(bars, "1h") },
          ]
        : timeframe === "1h"
          ? [{ tfLabel: "4h", bars: resampleTo(bars, "4h") }]
          : []
    : [];

  const closedTrades: ClosedTrade[] = [];
  const decisionLog: DecisionLogEntry[] = [];
  let position: OpenPosition | null = null;
  let cash = capital;
  let equityHigh = capital;
  let maxDrawdown = 0;
  let llmCallCount = 0;
  let llmFailureCount = 0;
  const gateRefusals: GateRefusals = {
    atr_liquidity: 0,
    news_veto: 0,
    consec_loss_halt: 0,
    ftmo_consistency_halt: 0,
    stagnant_exits: 0,
    ranging_regime: 0,
  };

  for (let i = startIdx; i < lastIdx; i++) {
    // Early-stop: if maxTrades is set and we've hit it, break out of the
    // replay loop. Force-close path below will close any remaining open
    // position so the trade log is consistent.
    if (maxTrades && closedTrades.length >= maxTrades) {
      if (!silent) {
        console.log(`  Reached maxTrades=${maxTrades} at bar ${i - startIdx}/${numBars} — stopping early.`);
      }
      break;
    }
    const bar = bars[i];

    // Compute daily bias + regime ONCE per bar — used by both intra-bar
    // SL/TP exit attribution AND the LLM context. Threading it through
    // prevents the gnarly "regime at SL fill" attribution edge case.
    const dailyBarsBeforeNow = dailyBars.filter(
      (d) => new Date(d.date).getTime() <= new Date(bar.date).getTime()
    );
    const dailyBiasResult = summariseDailyBias(dailyBarsBeforeNow);
    const regime: Regime = dailyBiasResult.regime;
    // Daily ATR for adaptive TP cap. 0 when insufficient history.
    const dailyAtr =
      dailyBarsBeforeNow.length >= 15
        ? computeAtr(dailyBarsBeforeNow, 14, dailyBarsBeforeNow.length - 1)
        : 0;

    // 0) Stagnant exit check — runs BEFORE SL/TP check, mirroring
    //    production's manageExistingPosition order. Cuts deeply-stuck
    //    losers at small loss rather than waiting for SL.
    if (position) {
      const stagCheck = checkStagnantExit({
        bars,
        entryBarIndex: position.entry_index,
        currentBarIndex: i,
        entryPrice: position.entry_price,
        side: position.side,
        stopDistance: Math.abs(position.entry_price - position.stop_price),
        config: PRODUCTION_GATES.stagnant_exit,
      });
      if (stagCheck.exit) {
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
          exit_reason: "llm_exit", // production uses 'stagnant_no_excursion'; backtest enum is narrower — keep llm_exit + reason text
          hold_bars: i - position.entry_index,
          entry_reasoning: position.entry_reasoning,
          exit_reasoning: `(stagnant exit — ${stagCheck.reason ?? "deeply stuck"})`,
          entry_regime: position.entry_regime,
          exit_regime: regime,
          regime_flipped_during_trade: regime !== position.entry_regime,
          r_multiple: computeRMultiple(position.side, position.entry_price, position.initial_stop_price, exitPrice),
        });
        equityHigh = Math.max(equityHigh, cash);
        maxDrawdown = Math.max(maxDrawdown, ((equityHigh - cash) / equityHigh) * 100);
        position = null;
        gateRefusals.stagnant_exits++;
      }
    }

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
          entry_regime: position.entry_regime,
          exit_regime: regime,
          regime_flipped_during_trade: regime !== position.entry_regime,
          r_multiple: computeRMultiple(position.side, position.entry_price, position.initial_stop_price, exit.exit_price),
        });
        equityHigh = Math.max(equityHigh, cash);
        maxDrawdown = Math.max(maxDrawdown, ((equityHigh - cash) / equityHigh) * 100);
        position = null;
      }
    }

    // 2) Ask LLM for the next decision based on this bar's close.
    const dailyContext = dailyBiasResult.summary;
    const recentContext = summariseRecentBars(bars, i, timeframe);
    // DXY proxy: skipped when primary IS EUR/USD (degenerate — same
    // series as `bars`). For all other tickers it gives the LLM
    // USD-strength color via the EUR/USD 4h close.
    const dxyContext =
      ticker === "EUR/USD" ? "" : summariseDxy(eurusd4h, bar.date);
    const intermarketContext = summariseIntermarket(intermarket, bar.close, bar.date);
    const positionContext = summarisePosition(position, bar.close);
    const higherTfContext = useMultiTf
      ? summariseHigherTfStructure(higherTfBars, bar.date)
      : "";
    const higherTfLine = higherTfContext ? `\n${higherTfContext}` : "";

    // Compose message — empty context lines are dropped to avoid
    // feeding the LLM blank "DXY: n/a" or "Intermarket: n/a" rows.
    const contextLines = [
      bar.date.slice(0, 16),
      dailyContext,
      dxyContext,
      intermarketContext,
      recentContext,
    ].filter((l) => l && l.length > 0);
    const userMessage = `${contextLines.join("\n")}${higherTfLine}\nPosition: ${positionContext}\nDecide.`;

    const decision = await callLLM(provider, clients, systemPrompt, userMessage);
    llmCallCount++;
    if (!decision) {
      llmFailureCount++;
      continue;
    }

    decisionLog.push({
      bar_date: bar.date,
      bar_close: bar.close,
      regime,
      decision: decision.decision,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      had_position: position ? position.side : "flat",
    });

    // 3) Apply decision. Production gates run BEFORE the open in this
    //    order: ATR liquidity → news veto → consec-loss halt →
    //    FTMO consistency halt → (LLM call already done) → spread gate
    //    (live-only). Mirrors evaluateLlmTraderEntry's gate ladder.
    const isEntry =
      decision.decision === "enter_long" || decision.decision === "enter_short";
    let entryBlockedReason: string | null = null;
    if (isEntry && !position) {
      // RANGING regime block — mirrors src/lib/scan/entry.ts. Empirical
      // finding (beyr1223h 30d): 4/4 RANGING entries lost (-$2,217).
      if (regime === "RANGING") {
        entryBlockedReason = `ranging_regime: 0/4 historical WR for RANGING entries`;
        gateRefusals.ranging_regime++;
      }
      // ATR liquidity
      if (!entryBlockedReason) {
        const atrCheck = checkAtrLiquidity(bars, i);
        if (atrCheck.skip) {
          entryBlockedReason = `atr_liquidity: ${atrCheck.reason ?? "below percentile"}`;
          gateRefusals.atr_liquidity++;
        }
      }
      // News veto — refuse entries within 5min before / 15min after
      // tier-1 USD releases. Same gate as production for XAU/USD.
      if (!entryBlockedReason && PRODUCTION_GATES.news_veto.enabled && newsEvents.length > 0) {
        const blockingEvent = isWithinVetoWindow(
          new Date(bar.date),
          newsEvents,
          newsCurrencies,
          PRODUCTION_GATES.news_veto.block_minutes_before,
          PRODUCTION_GATES.news_veto.block_minutes_after,
          PRODUCTION_GATES.news_veto.min_impact
        );
        if (blockingEvent) {
          entryBlockedReason = `news_veto: within window of ${blockingEvent.currency} ${blockingEvent.event} at ${blockingEvent.time}`;
          gateRefusals.news_veto++;
        }
      }
      // Consec-loss halt — 3 strikes/day
      if (!entryBlockedReason) {
        const todayUtc = bar.date.slice(0, 10);
        const streak = consecLossStreakOnDate(closedTrades, todayUtc);
        if (streak >= PRODUCTION_GATES.prop_firm.consecutive_loss_daily_halt) {
          entryBlockedReason = `consec_loss_halt: ${streak} consecutive ≥0.5R losses today`;
          gateRefusals.consec_loss_halt++;
        }
      }
      // FTMO consistency halt — 40% rule
      if (!entryBlockedReason) {
        const todayUtc = bar.date.slice(0, 10);
        const cst = consistencyHaltState(closedTrades, todayUtc);
        if (cst.tripped) {
          entryBlockedReason = `ftmo_consistency_halt: today/total = ${(cst.ratio * 100).toFixed(0)}% ≥ ${PRODUCTION_GATES.prop_firm.consistency_rule}%`;
          gateRefusals.ftmo_consistency_halt++;
        }
      }
      // Cohort gates removed — see src/lib/scan/entry.ts comment for rationale.
    }

    if (decision.decision === "enter_long" && !position && !entryBlockedReason) {
      const slDistance = computeSlForBacktest(bars, i, "long", bar.close);
      const tpDistance = computeTpForBacktest(slDistance, bar.close, undefined, { regime, dailyAtr });
      const stop = bar.close - slDistance;
      const target = bar.close + tpDistance;
      const notional = computeNotional(bar.close, slDistance);
      position = {
        side: "long",
        entry_price: bar.close,
        entry_index: i,
        entry_date: bar.date,
        stop_price: stop,
        initial_stop_price: stop,
        target_price: target,
        notional,
        entry_reasoning: decision.reasoning,
        entry_regime: regime,
      };
    } else if (decision.decision === "enter_short" && !position && !entryBlockedReason) {
      const slDistance = computeSlForBacktest(bars, i, "short", bar.close);
      const tpDistance = computeTpForBacktest(slDistance, bar.close, undefined, { regime, dailyAtr });
      const stop = bar.close + slDistance;
      const target = bar.close - tpDistance;
      const notional = computeNotional(bar.close, slDistance);
      position = {
        side: "short",
        entry_price: bar.close,
        entry_index: i,
        entry_date: bar.date,
        stop_price: stop,
        initial_stop_price: stop,
        target_price: target,
        notional,
        entry_reasoning: decision.reasoning,
        entry_regime: regime,
      };
    } else if (decision.decision === "move_be" && position) {
      // LLM-judged break-even: lock in profit by moving SL to entry
      // price. Only valid when in a profitable position with current
      // P&L >= +1R favorable. Trade continues; subsequent bars'
      // SL/TP fill check uses the new (entry-price) SL.
      // Gate against initial_stop_price so a second move_be on the same
      // trade can't divide by zero (post-BE, stop_price == entry_price).
      const slDistance = Math.abs(position.entry_price - position.initial_stop_price);
      const currentPnlR =
        position.side === "long"
          ? (bar.close - position.entry_price) / slDistance
          : (position.entry_price - bar.close) / slDistance;
      if (currentPnlR >= 1.0) {
        position.stop_price = position.entry_price;
        position.entry_reasoning = `${position.entry_reasoning} | BE moved at ${bar.date.slice(0, 16)} (+${currentPnlR.toFixed(2)}R): ${decision.reasoning}`;
      }
      // No close — just SL adjustment.
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
        entry_regime: position.entry_regime,
        exit_regime: regime,
        regime_flipped_during_trade: regime !== position.entry_regime,
        r_multiple: computeRMultiple(position.side, position.entry_price, position.initial_stop_price, exitPrice),
      });
      equityHigh = Math.max(equityHigh, cash);
      maxDrawdown = Math.max(maxDrawdown, ((equityHigh - cash) / equityHigh) * 100);
      position = null;
    }

    // Live progress (suppressed for WF orchestrator runs).
    if (!silent && (i - startIdx + 1) % 20 === 0) {
      console.log(
        `  ${i - startIdx + 1}/${numBars} bars · cash $${cash.toFixed(0)} · ${closedTrades.length} closed · ${llmCallCount} LLM calls (${llmFailureCount} fails)`
      );
    }
  }

  // Force-close any remaining position at the last bar's close.
  if (position) {
    const lastBar = bars[lastIdx - 1];
    const exitPrice = lastBar.close;
    const pnl =
      position.side === "long"
        ? (exitPrice - position.entry_price) * (position.notional / position.entry_price)
        : (position.entry_price - exitPrice) * (position.notional / position.entry_price);
    cash += pnl;
    const lastBarRegime = summariseDailyBias(
      dailyBars.filter((d) => new Date(d.date).getTime() <= new Date(lastBar.date).getTime())
    ).regime;
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
      entry_regime: position.entry_regime,
      exit_regime: lastBarRegime,
      regime_flipped_during_trade: lastBarRegime !== position.entry_regime,
      r_multiple: computeRMultiple(position.side, position.entry_price, position.initial_stop_price, exitPrice),
    });
    equityHigh = Math.max(equityHigh, cash);
    maxDrawdown = Math.max(maxDrawdown, ((equityHigh - cash) / equityHigh) * 100);
    position = null;
  }

  return {
    trades: closedTrades,
    decisions: decisionLog,
    finalCash: cash,
    capital,
    maxDrawdown,
    llmCalls: llmCallCount,
    llmFailures: llmFailureCount,
    startDate,
    endDate,
    numBars,
    windowLabel,
    promptVersion,
    gateRefusals,
  };
}

/** Print the same end-of-run summary the original CLI produced. Used by
 *  single-window mode; the WF orchestrator has its own across-window
 *  aggregator. */
export function printWindowSummary(result: WindowResult): void {
  const { trades, decisions, capital, finalCash, maxDrawdown, llmCalls, llmFailures, gateRefusals } = result;
  const totalPnl = finalCash - capital;
  const wins = trades.filter((t) => t.realized_pnl > 0);
  const wr = trades.length === 0 ? 0 : (wins.length / trades.length) * 100;
  const avgHold = trades.reduce((s, t) => s + t.hold_bars, 0) / Math.max(trades.length, 1);

  console.log("");
  console.log("===== Backtest complete =====");
  console.log(`Trades         : ${trades.length}`);
  console.log(`Win rate       : ${wr.toFixed(1)}%`);
  console.log(`Total P&L      : $${totalPnl.toFixed(0)} (${((totalPnl / capital) * 100).toFixed(2)}%)`);
  console.log(`Max drawdown   : ${maxDrawdown.toFixed(2)}%`);
  console.log(`Avg hold       : ${avgHold.toFixed(1)} bars`);
  console.log(`LLM calls      : ${llmCalls} (${llmFailures} fails)`);
  const totalRefusals =
    gateRefusals.atr_liquidity +
    gateRefusals.news_veto +
    gateRefusals.consec_loss_halt +
    gateRefusals.ftmo_consistency_halt +
    gateRefusals.ranging_regime;
  if (totalRefusals > 0) {
    console.log(
      `Gate refusals  : ${totalRefusals} (atr=${gateRefusals.atr_liquidity}, news=${gateRefusals.news_veto}, consec=${gateRefusals.consec_loss_halt}, ftmo_cst=${gateRefusals.ftmo_consistency_halt}, ranging=${gateRefusals.ranging_regime}, stagnant_exits=${gateRefusals.stagnant_exits})`
    );
  }
  console.log("");

  console.log("Trade log (last 15):");
  for (const t of trades.slice(-15)) {
    const flipMarker = t.regime_flipped_during_trade ? "↻" : " ";
    console.log(
      `  ${t.entry_date.slice(0, 16)} → ${t.exit_date.slice(0, 16)}  ${t.side}  $${t.realized_pnl.toFixed(0)}  ${t.r_multiple >= 0 ? "+" : ""}${t.r_multiple.toFixed(2)}R  ${flipMarker}${t.entry_regime}→${t.exit_regime}  ${t.hold_bars}b  ${t.exit_reason}`
    );
    console.log(`    entry: ${t.entry_reasoning.slice(0, 200)}`);
    console.log(`    exit : ${t.exit_reasoning.slice(0, 200)}`);
  }
  console.log("");

  const dist: Record<string, number> = {};
  for (const d of decisions) dist[d.decision] = (dist[d.decision] ?? 0) + 1;
  console.log("Decision distribution:");
  for (const [k, v] of Object.entries(dist)) {
    console.log(`  ${k.padEnd(14)} ${v} (${((v / decisions.length) * 100).toFixed(1)}%)`);
  }
  console.log("");

  // Per-regime / regime-flip / decisions-per-regime breakdown — Layer 1
  // attribution for the learning loop.
  printRegimeReport(trades, decisions);
}

async function main(): Promise<void> {
  const sliceDays = Number(process.env.SLICE_DAYS ?? "60");
  const capital = Number(process.env.CAPITAL ?? "100000");
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
  // SLICE_END_DATE optional: end the slice at this date instead of "now".
  const sliceEndStr = process.env.SLICE_END_DATE;
  const sliceEndMs = sliceEndStr ? new Date(`${sliceEndStr}T23:59:59Z`).getTime() : Date.now();
  if (Number.isNaN(sliceEndMs)) throw new Error(`Invalid SLICE_END_DATE=${sliceEndStr}`);

  const provider: Provider = (process.env.PROVIDER ?? "groq").toLowerCase() as Provider;
  if (provider !== "groq" && provider !== "anthropic") {
    throw new Error(`Unsupported PROVIDER=${provider}. Use groq or anthropic.`);
  }

  const promptVersionRaw = (process.env.PROMPT_VERSION ?? DEFAULT_PROMPT_VERSION).toLowerCase();
  if (
    promptVersionRaw !== "v1" &&
    promptVersionRaw !== "v2" &&
    promptVersionRaw !== "v3" &&
    promptVersionRaw !== "v4" &&
    promptVersionRaw !== "v5" &&
    promptVersionRaw !== "v5_15m"
  ) {
    throw new Error(
      `Unsupported PROMPT_VERSION=${promptVersionRaw}. Use v1, v2, v3, v4, v5, or v5_15m.`
    );
  }
  const promptVersion: PromptVersion = promptVersionRaw;

  const maxTrades = process.env.MAX_TRADES ? Number(process.env.MAX_TRADES) : undefined;
  if (maxTrades !== undefined && (Number.isNaN(maxTrades) || maxTrades <= 0)) {
    throw new Error(`Invalid MAX_TRADES=${process.env.MAX_TRADES}`);
  }

  const riskPerTradePct = process.env.RISK_PER_TRADE_PCT
    ? Number(process.env.RISK_PER_TRADE_PCT)
    : undefined;
  if (riskPerTradePct !== undefined && (Number.isNaN(riskPerTradePct) || riskPerTradePct <= 0 || riskPerTradePct > 5)) {
    throw new Error(`Invalid RISK_PER_TRADE_PCT=${process.env.RISK_PER_TRADE_PCT} (must be 0 < x ≤ 5)`);
  }

  const corpus = await loadCorpus(timeframe);
  const tfHoursPerBar = timeframe === "4h" ? 4 : timeframe === "1h" ? 1 : timeframe === "30m" ? 0.5 : 0.25;
  const numBarsHint = Math.round((sliceDays * 24) / tfHoursPerBar);
  const estTokens = numBarsHint * 530;
  const windowLabel = sliceEndStr ? `${sliceEndStr} − ${sliceDays}d` : `last ${sliceDays} days`;
  console.log(
    `Window: ${windowLabel} · est ~${(estTokens / 1000).toFixed(0)}K tokens (Groq free 100K/day, Dev 6M/day)`
  );
  if (estTokens > 100_000 && provider === "groq") {
    console.log("  ⚠ Over Groq free-tier daily quota — will hit rate limit partway. Use Dev tier or shorter slice.");
  }
  console.log(`Provider: ${provider} (model: ${provider === "anthropic" ? ANTHROPIC_MODEL : AI_MODEL})`);
  console.log(`Prompt:   ${promptVersion}`);
  console.log(
    `SL/TP:    ${SL_TYPE}=${SL_VALUE}${SL_TYPE === "swing_anchor" ? ` lookback=${SL_LOOKBACK}` : ""} / ${TP_TYPE}=${TP_VALUE}`
  );
  console.log(
    `Sizing:   ${riskPerTradePct !== undefined ? `risk_per_trade=${riskPerTradePct}% (live-equivalent — full SL hit = $${(capital * riskPerTradePct / 100).toFixed(0)})` : `fixed notional ${(capital * 0.5).toLocaleString()} (legacy — dollar P&L NOT directly comparable to live)`}`
  );
  console.log("");

  const clients = createClients(provider);

  const result = await runWindow({
    corpus,
    sliceEndMs,
    sliceDays,
    capital,
    provider,
    clients,
    promptVersion,
    maxTrades,
    riskPerTradePct,
  });

  printWindowSummary(result);

  // Save full audit trail (existing CLI behavior preserved). File names
  // include the prompt version so v1 vs v2 runs don't overwrite each other.
  // OUTPUT_TAG appends a suffix so parallel runs (different windows /
  // configs) don't clobber each other's audit + trade logs.
  const outputTag = process.env.OUTPUT_TAG ? `-${process.env.OUTPUT_TAG}` : "";
  const decisionLogPath = `scripts/llm-trader-decisions-${provider}-${timeframe}-${sliceDays}d-${promptVersion}${outputTag}.jsonl`;
  writeFileSync(decisionLogPath, result.decisions.map((d) => JSON.stringify(d)).join("\n"));
  console.log(`Decision audit trail: ${decisionLogPath} (${result.decisions.length} entries)`);

  const tradeLogPath = `scripts/llm-trader-trades-${provider}-${timeframe}-${sliceDays}d-${promptVersion}${outputTag}.jsonl`;
  writeFileSync(tradeLogPath, result.trades.map((t) => JSON.stringify(t)).join("\n"));
  console.log(`Trade log: ${tradeLogPath} (${result.trades.length} entries)`);
}

// Only execute main when this file is run directly (not when imported by
// scripts/llm-trader-walk-forward.ts). tsx leaves require.main set on the
// entry script; this guard keeps imports side-effect-free.
const isEntryScript = process.argv[1]?.endsWith("llm-trader-backtest.ts");
if (isEntryScript) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
