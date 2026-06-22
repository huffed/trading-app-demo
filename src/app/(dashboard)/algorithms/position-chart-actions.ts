"use server";

import { timeframeToInterval } from "@/lib/market-data/interval";
import { getCachedPrices } from "@/lib/market-data/price-cache";
import { fetchDailyPrices } from "@/lib/market-data/prices";
import { getAuthedUser } from "@/lib/supabase/get-authed-user";
import { rulesFromRow } from "@/lib/supabase/row-mappers";
import { type ActionResult } from "@/types/action-result";

export interface ChartBar {
  /** ISO timestamp (bar open). */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface PositionChartData {
  bars: ChartBar[];
  /** Bar timeframe (e.g. "1h"). Used for axis labelling. */
  timeframe: string;
  /** Position metadata replicated for chart-side reference lines. */
  side: "long" | "short";
  entry_price: number;
  stop_loss_price: number | null;
  take_profit_price: number | null;
  exit_price: number | null;
  /** Bar dates that mark entry / exit. Match against ChartBar.date. */
  entry_bar_date: string | null;
  exit_bar_date: string | null;
}

const CONTEXT_BARS_BEFORE_ENTRY = 10;
const CONTEXT_BARS_AFTER_EXIT = 5;

/**
 * Bars covering the position's lifetime plus a small context window
 * before entry / after exit. Used by the Chart tab to render price
 * action with entry / SL / TP / exit markers.
 *
 * Range:
 *   - 10 bars before opened_at (for context — what was the move before entry?)
 *   - all bars from opened_at to closed_at (or now if open)
 *   - 5 bars after closed_at (for closed positions — what happened next?)
 *
 * Caps the total at 200 bars so the chart stays readable; positions
 * longer than that are rare on 1h/15m timeframes anyway.
 */
export async function getPositionChartData(
  positionId: string
): Promise<ActionResult<PositionChartData | null>> {
  try {
    const { supabase, user } = await getAuthedUser();
    const { data: pos, error } = await supabase
      .from("paper_positions")
      .select(
        "id, ticker, side, entry_price, exit_price, stop_loss_price, take_profit_price, opened_at, closed_at, algorithm_id"
      )
      .eq("id", positionId)
      .eq("user_id", user.id)
      .single();
    if (error) return { success: false, error: error.message };

    const { data: algo } = await supabase
      .from("algorithms")
      .select("rules")
      .eq("id", pos.algorithm_id)
      .single();
    if (!algo) return { success: true, data: null };
    const rules = rulesFromRow(algo.rules);
    const interval = timeframeToInterval(rules.timeframe);

    let bars = await getCachedPrices(pos.ticker, "full", interval);
    if (!bars || bars.length === 0) {
      try {
        bars = await fetchDailyPrices(pos.ticker, "full", interval);
      } catch {
        return { success: true, data: null };
      }
    }
    if (!bars || bars.length === 0) return { success: true, data: null };

    const openMs = new Date(pos.opened_at).getTime();
    const closeMs = pos.closed_at ? new Date(pos.closed_at).getTime() : Date.now();

    const entryIdx = bars.findIndex((b) => new Date(b.date).getTime() >= openMs);
    if (entryIdx < 0) return { success: true, data: null };

    const exitIdx = pos.closed_at
      ? bars.findIndex((b) => new Date(b.date).getTime() >= closeMs)
      : bars.length - 1;
    const upperBound = exitIdx >= 0 ? exitIdx : bars.length - 1;

    const startIdx = Math.max(0, entryIdx - CONTEXT_BARS_BEFORE_ENTRY);
    const endIdx = Math.min(bars.length - 1, upperBound + CONTEXT_BARS_AFTER_EXIT);
    let window = bars.slice(startIdx, endIdx + 1);
    if (window.length > 200) window = window.slice(-200);

    const entryBar = bars[entryIdx];
    const exitBar = exitIdx >= 0 && pos.closed_at ? bars[exitIdx] : null;

    return {
      success: true,
      data: {
        bars: window.map((b) => ({
          date: b.date,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
        })),
        timeframe: rules.timeframe,
        side: pos.side as "long" | "short",
        entry_price: pos.entry_price,
        stop_loss_price: pos.stop_loss_price,
        take_profit_price: pos.take_profit_price,
        exit_price: pos.exit_price,
        entry_bar_date: entryBar?.date ?? null,
        exit_bar_date: exitBar?.date ?? null,
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Chart fetch failed" };
  }
}
