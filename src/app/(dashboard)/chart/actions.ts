"use server";

import { sma } from "@/lib/market-data/indicators";
import { fetchDailyPrices } from "@/lib/market-data/prices";
import { createClient } from "@/lib/supabase/server";
import { type ActionResult } from "@/lib/types/action-result";

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

export interface ChartData {
  ticker: string;
  timeframe: ChartTimeframe;
  bars: ChartBar[];
  /** SMA20 overlay computed from bars closes. Aligned 1:1 with bars
   *  (null for the first 19 indices). */
  sma20: (number | null)[];
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
    // Sort ascending — fetchDailyPrices generally returns ascending but
    // some providers flip; lightweight-charts requires ascending.
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
    const sma20 = sma(closes, 20);

    // Trade markers from paper_positions on this ticker. Limit to the
    // window the chart covers so we don't show off-screen markers.
    const firstBarTime = bars[0]?.time ?? 0;
    const sinceIso = new Date(firstBarTime * 1000).toISOString();
    const markers = await fetchTradeMarkers(supabase, ticker, sinceIso);

    return {
      success: true,
      data: { ticker, timeframe, bars, sma20, markers },
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

