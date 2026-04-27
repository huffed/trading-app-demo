"use server";

import { pnlInUsd } from "@/lib/constants/markets";
import { getCachedPrices } from "@/lib/market-data/price-cache";
import { fetchDailyPrices } from "@/lib/market-data/prices";
import { fetchBatchQuotes } from "@/lib/market-data/twelve-data";
import { scanAlgorithm, type ScanResult } from "@/lib/scan/engine";
import { executeLiveExit, resolveBrokerContext } from "@/lib/scan/live-execution";
import { closePositionSchema } from "@/lib/validators/position";
import type { AlgorithmRules } from "@/types/algorithm";
import type { PaperPosition } from "@/types/position";
import { getAuthedUser } from "./actions";

type ActionResult<T = unknown> = { success: true; data: T } | { success: false; error: string };

/**
 * Trigger a scan for one or all active algorithms.
 * Evaluates watchlist tickers against algorithm conditions and opens/closes positions.
 */
export async function triggerScan(algorithmId?: string): Promise<ActionResult<ScanResult[]>> {
  try {
    const { supabase, user } = await getAuthedUser();

    let query = supabase
      .from("algorithms")
      .select(
        "id, name, description, rules, capital, status, live_trading_enabled, broker_connection_id, algorithm_watchlist(ticker, name)"
      )
      .eq("user_id", user.id)
      .eq("status", "active");

    if (algorithmId) {
      query = query.eq("id", algorithmId);
    }

    const { data: algorithms, error } = await query;
    if (error) return { success: false, error: error.message };
    if (!algorithms || algorithms.length === 0) {
      return { success: true, data: [] };
    }

    const results: ScanResult[] = [];
    for (const algo of algorithms) {
      const result = await scanAlgorithm(supabase, user.id, {
        ...algo,
        rules: algo.rules as AlgorithmRules,
        algorithm_watchlist: algo.algorithm_watchlist ?? [],
      });
      results.push(result);
    }

    return { success: true, data: results };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Scan failed";
    return { success: false, error: msg };
  }
}

async function mirrorManualClose(
  supabase: Awaited<ReturnType<typeof getAuthedUser>>["supabase"],
  userId: string,
  position: PaperPosition & { broker_position_id?: string | null; algorithm_id: string },
  paperPositionId: string,
  currentPrice: number
): Promise<void> {
  if (!position.broker_position_id) return;
  const { data: algoMeta } = await supabase
    .from("algorithms")
    .select("broker_connection_id, live_trading_enabled")
    .eq("id", position.algorithm_id)
    .single();
  if (!algoMeta) return;
  const ctx = await resolveBrokerContext(
    supabase,
    userId,
    algoMeta.broker_connection_id ?? null,
    algoMeta.live_trading_enabled ?? false
  );
  if (!ctx) return;
  await executeLiveExit({
    supabase,
    userId,
    algorithmId: position.algorithm_id,
    paperPositionId,
    ticker: position.ticker,
    brokerPositionId: position.broker_position_id,
    closePrice: currentPrice,
    ctx,
  });
}

/**
 * Manually close an open position at the current market price.
 */
export async function closePosition(positionId: string): Promise<ActionResult<PaperPosition>> {
  const parsed = closePositionSchema.safeParse({ position_id: positionId });
  if (!parsed.success) {
    return { success: false, error: "Invalid position ID" };
  }

  try {
    const { supabase, user } = await getAuthedUser();

    const { data: position, error: posErr } = await supabase
      .from("paper_positions")
      .select("*")
      .eq("id", positionId)
      .eq("user_id", user.id)
      .eq("status", "open")
      .single();

    if (posErr || !position) {
      return { success: false, error: "Open position not found" };
    }

    // Get current price
    let prices = await getCachedPrices(position.ticker, "compact");
    if (!prices) {
      prices = await fetchDailyPrices(position.ticker, "compact");
    }
    const currentPrice = prices[prices.length - 1]?.close;
    if (!currentPrice) {
      return { success: false, error: "Could not fetch current price" };
    }

    const realizedPnl = pnlInUsd(
      position.ticker,
      position.side,
      position.entry_price,
      currentPrice,
      position.quantity
    );

    const { data: updated, error: updateErr } = await supabase
      .from("paper_positions")
      .update({
        current_price: currentPrice,
        exit_price: currentPrice,
        unrealized_pnl: 0,
        realized_pnl: realizedPnl,
        exit_reason: "manual",
        status: "closed",
        closed_at: new Date().toISOString(),
      })
      .eq("id", positionId)
      .eq("user_id", user.id)
      .select()
      .single();

    if (updateErr) return { success: false, error: updateErr.message };

    // Log the manual close
    await supabase.from("activity_log").insert({
      user_id: user.id,
      algorithm_id: position.algorithm_id,
      position_id: positionId,
      event_type: "position_closed",
      ticker: position.ticker,
      details: {
        exit_price: currentPrice,
        realized_pnl: realizedPnl,
        exit_reason: "manual",
      },
    });

    // Mirror the close to the broker if this paper position has a real
    // counterpart. Without this, "Close" in the UI leaves a real MT5
    // position dangling, blowing the user's risk budget on FTMO.
    await mirrorManualClose(supabase, user.id, position, positionId, currentPrice);

    return { success: true, data: updated as PaperPosition };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to close position";
    return { success: false, error: msg };
  }
}

/**
 * Lightweight price refresh — updates current_price and unrealized_pnl on open
 * positions without evaluating conditions or opening/closing anything.
 * Uses Twelve Data real-time quotes for live prices, falls back to daily bars.
 * Designed to be called on a 60s interval for live P&L display.
 */
export async function refreshPositionPrices(algorithmId?: string): Promise<ActionResult<number>> {
  try {
    const { supabase, user } = await getAuthedUser();

    let query = supabase
      .from("paper_positions")
      .select("id, ticker, side, entry_price, quantity")
      .eq("user_id", user.id)
      .eq("status", "open");

    if (algorithmId) {
      query = query.eq("algorithm_id", algorithmId);
    }

    const { data: positions, error } = await query;
    if (error) {
      return { success: false, error: error.message };
    }
    if (!positions || positions.length === 0) {
      return { success: true, data: 0 };
    }

    const tickers = [...new Set(positions.map((p) => p.ticker))];
    const priceMap = await fetchLivePrices(tickers);

    let updated = 0;
    for (const pos of positions) {
      const currentPrice = priceMap.get(pos.ticker);
      if (currentPrice == null) {
        continue;
      }

      const unrealizedPnl = pnlInUsd(
        pos.ticker,
        pos.side,
        pos.entry_price,
        currentPrice,
        pos.quantity
      );

      await supabase
        .from("paper_positions")
        .update({ current_price: currentPrice, unrealized_pnl: unrealizedPnl })
        .eq("id", pos.id);
      updated++;
    }

    return { success: true, data: updated };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Price refresh failed";
    return { success: false, error: msg };
  }
}

/**
 * Fetch live prices: try Twelve Data batch quotes first (real-time),
 * fall back to daily bars for any tickers that fail.
 */
async function fetchLivePrices(tickers: string[]): Promise<Map<string, number>> {
  // Try real-time batch quote first
  try {
    const quotes = await fetchBatchQuotes(tickers);
    if (quotes.size === tickers.length) {
      return quotes;
    }
    // Some tickers missing — fill gaps from daily bars
    const missing = tickers.filter((t) => !quotes.has(t.toUpperCase()));
    for (const ticker of missing) {
      const price = await fetchDailyFallback(ticker);
      if (price != null) {
        quotes.set(ticker.toUpperCase(), price);
      }
    }
    return quotes;
  } catch {
    // Batch quote failed entirely — fall back to daily bars for all
    const priceMap = new Map<string, number>();
    for (const ticker of tickers) {
      const price = await fetchDailyFallback(ticker);
      if (price != null) {
        priceMap.set(ticker.toUpperCase(), price);
      }
    }
    return priceMap;
  }
}

async function fetchDailyFallback(ticker: string): Promise<number | null> {
  try {
    let prices = await getCachedPrices(ticker, "compact");
    if (!prices) {
      prices = await fetchDailyPrices(ticker, "compact");
    }
    return prices[prices.length - 1]?.close ?? null;
  } catch {
    return null;
  }
}

/**
 * Aggregate paper trading stats for the dashboard.
 */
export async function getPaperTradingStats(): Promise<
  ActionResult<{
    active_algorithms: number;
    open_positions: number;
    total_unrealized_pnl: number;
    total_realized_pnl: number;
    last_scan_at: string | null;
  }>
> {
  try {
    const { supabase, user } = await getAuthedUser();

    const [algoRes, openRes, closedRes] = await Promise.all([
      supabase
        .from("algorithms")
        .select("last_scanned_at")
        .eq("user_id", user.id)
        .eq("status", "active"),
      supabase
        .from("paper_positions")
        .select("unrealized_pnl")
        .eq("user_id", user.id)
        .eq("status", "open"),
      supabase
        .from("paper_positions")
        .select("realized_pnl")
        .eq("user_id", user.id)
        .eq("status", "closed"),
    ]);

    const activeAlgos = algoRes.data ?? [];
    const openPositions = openRes.data ?? [];
    const closedPositions = closedRes.data ?? [];

    const totalUnrealized = openPositions.reduce((sum, p) => sum + (p.unrealized_pnl ?? 0), 0);
    const totalRealized = closedPositions.reduce((sum, p) => sum + (p.realized_pnl ?? 0), 0);

    // Most recent scan across all active algorithms
    const lastScanAt = activeAlgos.reduce<string | null>((latest, a) => {
      if (!a.last_scanned_at) return latest;
      if (!latest) return a.last_scanned_at;
      return a.last_scanned_at > latest ? a.last_scanned_at : latest;
    }, null);

    return {
      success: true,
      data: {
        active_algorithms: activeAlgos.length,
        open_positions: openPositions.length,
        total_unrealized_pnl: totalUnrealized,
        total_realized_pnl: totalRealized,
        last_scan_at: lastScanAt,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to fetch stats";
    return { success: false, error: msg };
  }
}
