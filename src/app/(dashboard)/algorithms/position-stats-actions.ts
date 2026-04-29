"use server";

import { getInstrumentMeta } from "@/lib/constants/markets";
import { timeframeToInterval } from "@/lib/market-data/interval";
import { getCachedPrices } from "@/lib/market-data/price-cache";
import { fetchDailyPrices } from "@/lib/market-data/prices";
import { resolveBrokerContext } from "@/lib/scan/live-execution";
import { getAuthedUser } from "@/lib/supabase/get-authed-user";
import { type ActionResult } from "@/lib/types/action-result";
import type { AlgorithmRules } from "@/types/algorithm";

export interface PositionLiveQuote {
  bid: number;
  ask: number;
  /** Raw price difference (ask − bid). */
  spread: number;
  /** Spread expressed in pips for the symbol. */
  spread_pips: number;
  /** ISO timestamp the quote was sampled. */
  fetched_at: string;
}

/**
 * Fetch a live bid/ask quote for the open position via its algorithm's
 * broker connection. Returns null when the algorithm has no live broker
 * (paper-only) or when the broker adapter doesn't expose one-shot quotes
 * (cTrader streams only). Caller treats null as "live data unavailable".
 */
export async function getPositionLiveQuote(
  positionId: string
): Promise<ActionResult<PositionLiveQuote | null>> {
  try {
    const { supabase, user } = await getAuthedUser();
    const { data: pos, error } = await supabase
      .from("paper_positions")
      .select("id, ticker, algorithm_id, status")
      .eq("id", positionId)
      .eq("user_id", user.id)
      .single();
    if (error) return { success: false, error: error.message };
    if (pos.status !== "open") {
      return { success: true, data: null };
    }

    const { data: algo } = await supabase
      .from("algorithms")
      .select("broker_connection_id, live_trading_enabled")
      .eq("id", pos.algorithm_id)
      .single();
    if (!algo) return { success: true, data: null };

    const ctx = await resolveBrokerContext(
      supabase,
      user.id,
      algo.broker_connection_id ?? null,
      algo.live_trading_enabled ?? false
    );
    if (!ctx) return { success: true, data: null };

    const quote = await ctx.adapter.fetchQuote(ctx.conn, pos.ticker);
    if (!quote) return { success: true, data: null };

    const meta = getInstrumentMeta(pos.ticker);
    const pipSize = meta?.pipSize ?? 0.0001;
    const spread = quote.ask - quote.bid;

    return {
      success: true,
      data: {
        bid: quote.bid,
        ask: quote.ask,
        spread,
        spread_pips: spread / pipSize,
        fetched_at: quote.time ?? new Date().toISOString(),
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Quote failed" };
  }
}

export interface PositionMaeMfe {
  /** Worst adverse price reached during the position's life. */
  mae_price: number;
  /** Adverse excursion in pips (always positive — the worst the trade got). */
  mae_pips: number;
  /** ISO timestamp the MAE bar opened. */
  mae_at: string;
  /** Best favorable price reached. */
  mfe_price: number;
  /** Favorable excursion in pips (always positive). */
  mfe_pips: number;
  /** ISO timestamp the MFE bar opened. */
  mfe_at: string;
  /** Bars examined. Useful for diagnostics — small window may misrepresent
   *  intraday extremes when only daily bars are cached. */
  bars_examined: number;
}

/**
 * Compute MAE (max adverse excursion) and MFE (max favorable excursion)
 * for an open or closed position from the price_cache bars covering the
 * position's lifetime. Bars are at the algorithm's primary timeframe —
 * intraday extremes between bars are NOT captured (true tick-level MAE
 * would need broker history). Surface this caveat via `bars_examined`.
 */
export async function getPositionMaeMfe(
  positionId: string
): Promise<ActionResult<PositionMaeMfe | null>> {
  try {
    const { supabase, user } = await getAuthedUser();
    const { data: pos, error } = await supabase
      .from("paper_positions")
      .select("id, ticker, side, entry_price, opened_at, closed_at, algorithm_id")
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
    const rules = algo.rules as AlgorithmRules;
    const interval = timeframeToInterval(rules.timeframe);

    // Try cache first; fall back to live fetch if missing. The position's
    // lifetime might span less than the cache TTL, so a cache hit is the
    // common path.
    let bars = await getCachedPrices(pos.ticker, "full", interval);
    if (!bars || bars.length === 0) {
      try {
        bars = await fetchDailyPrices(pos.ticker, "full", interval);
      } catch {
        return { success: true, data: null };
      }
    }
    if (!bars || bars.length === 0) return { success: true, data: null };

    const startMs = new Date(pos.opened_at).getTime();
    const endMs = pos.closed_at ? new Date(pos.closed_at).getTime() : Date.now();

    const window = bars.filter((b) => {
      const t = new Date(b.date).getTime();
      return t >= startMs && t <= endMs;
    });
    if (window.length === 0) return { success: true, data: null };

    let worstAdverse = pos.entry_price;
    let worstAdverseAt = pos.opened_at;
    let bestFavorable = pos.entry_price;
    let bestFavorableAt = pos.opened_at;
    const isLong = pos.side === "long";

    for (const bar of window) {
      // For a long: adverse = low (price down), favorable = high (price up).
      // For a short: mirror.
      const adverse = isLong ? bar.low : bar.high;
      const favorable = isLong ? bar.high : bar.low;
      if (isLong) {
        if (adverse < worstAdverse) {
          worstAdverse = adverse;
          worstAdverseAt = bar.date;
        }
        if (favorable > bestFavorable) {
          bestFavorable = favorable;
          bestFavorableAt = bar.date;
        }
      } else {
        if (adverse > worstAdverse) {
          worstAdverse = adverse;
          worstAdverseAt = bar.date;
        }
        if (favorable < bestFavorable) {
          bestFavorable = favorable;
          bestFavorableAt = bar.date;
        }
      }
    }

    const meta = getInstrumentMeta(pos.ticker);
    const pipSize = meta?.pipSize ?? 0.0001;
    const maePips = Math.abs(pos.entry_price - worstAdverse) / pipSize;
    const mfePips = Math.abs(bestFavorable - pos.entry_price) / pipSize;

    return {
      success: true,
      data: {
        mae_price: worstAdverse,
        mae_pips: maePips,
        mae_at: worstAdverseAt,
        mfe_price: bestFavorable,
        mfe_pips: mfePips,
        mfe_at: bestFavorableAt,
        bars_examined: window.length,
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "MAE/MFE failed" };
  }
}
