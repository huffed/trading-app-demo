"use server";

import { bollingerBands, ema, macd, rsi, sma } from "@/lib/market-data/indicators";
import { fetchDailyPrices } from "@/lib/market-data/prices";
import { createClient } from "@/lib/supabase/server";
import { type ActionResult } from "@/lib/types/action-result";
import { computePatterns } from "./pattern-scan";

export type ChartTimeframe = "15min" | "30min" | "1h" | "4h" | "1day";

export interface ChartBar {
  time: number; // UTC seconds (lightweight-charts native format)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ChartMarker {
  time: number;
  side: "long" | "short";
  kind: "entry" | "exit";
  price: number;
  /** Realized R-multiple when known (exit markers on closed positions). */
  r_multiple: number | null;
  /** Human-readable label shown in tooltip. */
  label: string;
}

/** Per-bar indicator series — same length as `bars`, with null prefix
 *  for periods before each indicator's warm-up window completes. */
export interface ChartIndicators {
  sma20: (number | null)[];
  sma50: (number | null)[];
  sma200: (number | null)[];
  ema12: (number | null)[];
  ema26: (number | null)[];
  bb_upper: (number | null)[];
  bb_middle: (number | null)[];
  bb_lower: (number | null)[];
  rsi: (number | null)[];
  /** MACD = (EMA12 − EMA26); signal = EMA9(MACD); histogram = MACD − signal. */
  macd_line: (number | null)[];
  macd_signal: (number | null)[];
  macd_histogram: (number | null)[];
}

/** A detected pattern at a specific bar. `time` is UTC seconds.
 *  Used for marker-style annotations (single-candle events). */
export interface PatternPoint {
  time: number;
  direction: "bullish" | "bearish" | "neutral";
  label: string;
  /** Optional price anchor (for FVG/OB zones — gap edges or block edges). */
  top?: number;
  bottom?: number;
}

/** A pattern annotation rendered as a horizontal line or bracketing zone
 *  on the price pane. Annotations span time (from_time → to_time)
 *  because ICT/SMC patterns are MULTI-BAR structures — BOS connects a
 *  swing high to a break bar, FVG zones live until filled, etc. The
 *  marker-style PatternPoint is kept for short-text labels at single
 *  bars; this is the line/zone shape. */
export interface PatternAnnotation {
  pattern_type: "bos" | "choch" | "sweep" | "fvg" | "ifvg" | "order_block";
  kind: "line" | "zone";
  direction: "bullish" | "bearish" | "neutral";
  /** UTC-seconds time range the annotation spans. */
  from_time: number;
  to_time: number;
  /** Price level for `line` kind; upper edge for `zone` kind. */
  top: number;
  /** Lower edge for `zone` kind (omitted for `line`). */
  bottom?: number;
  /** Short label rendered near the right edge of the line/zone. */
  label: string;
}

/** Swing high / low marker on the price pane. Single-candle event, so
 *  rendered via the markers API, not as a line. */
export interface SwingMarker {
  time: number;
  type: "HH" | "HL" | "LH" | "LL";
  price: number;
}

export interface ChartPatterns {
  fvg: PatternPoint[];
  ifvg: PatternPoint[];
  bos: PatternPoint[];
  sweep: PatternPoint[];
  order_block: PatternPoint[];
  choch: PatternPoint[];
  /** Line/zone annotations — the trader-familiar render shape. */
  annotations: PatternAnnotation[];
  /** Swing point labels (HH/HL/LH/LL) for trend structure. */
  swings: SwingMarker[];
  /** Daily bias is one-per-chart, not one-per-bar. */
  daily_bias: {
    bias: "bullish" | "bearish" | "neutral";
    ma_value: number;
    ma_period: number;
  } | null;
}

export interface ChartData {
  ticker: string;
  timeframe: ChartTimeframe;
  bars: ChartBar[];
  indicators: ChartIndicators;
  patterns: ChartPatterns;
  markers: ChartMarker[];
}

function isoToUnixSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function computeR(
  side: "long" | "short",
  entry: number,
  stop: number | null,
  exit: number
): number | null {
  if (stop == null || stop === entry) return null;
  const risk = side === "long" ? entry - stop : stop - entry;
  if (risk <= 0) return null;
  const move = side === "long" ? exit - entry : entry - exit;
  return move / risk;
}

/** EMA-9 over the MACD line, NaN-safe. Used to derive the signal line +
 *  histogram in the standard MACD(12,26,9) configuration. */
function emaOfNullable(values: (number | null)[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let ema: number | null = null;
  let seeded = 0;
  let seedSum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    if (ema == null) {
      seedSum += v;
      seeded++;
      if (seeded === period) {
        ema = seedSum / period;
        out[i] = ema;
      }
      continue;
    }
    ema = v * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function computeIndicators(closes: number[]): ChartIndicators {
  const bb = bollingerBands(closes);
  const macdLine = macd(closes);
  const macdSignal = emaOfNullable(macdLine, 9);
  const macdHistogram = macdLine.map((v, i) =>
    v != null && macdSignal[i] != null ? v - (macdSignal[i] as number) : null
  );
  return {
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    ema12: ema(closes, 12),
    ema26: ema(closes, 26),
    bb_upper: bb.upper,
    bb_middle: bb.middle,
    bb_lower: bb.lower,
    rsi: rsi(closes),
    macd_line: macdLine,
    macd_signal: macdSignal,
    macd_histogram: macdHistogram,
  };
}

export async function getChartDataAction(
  ticker: string,
  timeframe: ChartTimeframe,
  outputSize: "compact" | "full" = "compact"
): Promise<ActionResult<ChartData>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  try {
    const rawBars = await fetchDailyPrices(ticker, outputSize, timeframe);
    if (rawBars.length === 0) {
      return { success: false, error: `No bars returned for ${ticker} ${timeframe}` };
    }
    const sortedBars = [...rawBars].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );
    const bars: ChartBar[] = sortedBars.map((b) => ({
      time: isoToUnixSeconds(b.date),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));

    const closes = bars.map((b) => b.close);
    const indicators = computeIndicators(closes);
    const patterns = computePatterns(sortedBars, bars);

    const firstBarTime = bars[0]?.time ?? 0;
    const sinceIso = new Date(firstBarTime * 1000).toISOString();
    const markers = await fetchTradeMarkers(supabase, ticker, sinceIso);

    return {
      success: true,
      data: { ticker, timeframe, bars, indicators, patterns, markers },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Chart data query failed";
    return { success: false, error: msg };
  }
}

type Supa = Awaited<ReturnType<typeof createClient>>;

async function fetchTradeMarkers(
  supabase: Supa,
  ticker: string,
  sinceIso: string
): Promise<ChartMarker[]> {
  const { data, error } = await supabase
    .from("paper_positions")
    .select(
      "side, entry_price, exit_price, opened_at, closed_at, initial_stop_loss_price, stop_loss_price, realized_pnl, status"
    )
    .eq("ticker", ticker)
    .gte("opened_at", sinceIso)
    .order("opened_at", { ascending: true });
  if (error) return [];
  const rows = (data ?? []) as Array<{
    side: string;
    entry_price: number;
    exit_price: number | null;
    opened_at: string;
    closed_at: string | null;
    initial_stop_loss_price: number | null;
    stop_loss_price: number | null;
    realized_pnl: number | null;
    status: string;
  }>;

  const markers: ChartMarker[] = [];
  for (const p of rows) {
    if (p.side !== "long" && p.side !== "short") continue;
    const side = p.side as "long" | "short";
    markers.push({
      time: isoToUnixSeconds(p.opened_at),
      side,
      kind: "entry",
      price: p.entry_price,
      r_multiple: null,
      label: `${side} entry @ ${p.entry_price.toFixed(5)}`,
    });
    if (p.closed_at && p.exit_price != null) {
      const stop = p.initial_stop_loss_price ?? p.stop_loss_price;
      const r = computeR(side, p.entry_price, stop, p.exit_price);
      markers.push({
        time: isoToUnixSeconds(p.closed_at),
        side,
        kind: "exit",
        price: p.exit_price,
        r_multiple: r,
        label: `${side} exit @ ${p.exit_price.toFixed(5)}${r != null ? ` (${r >= 0 ? "+" : ""}${r.toFixed(2)}R)` : ""}`,
      });
    }
  }
  return markers;
}
