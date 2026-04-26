/**
 * Paper trading scan engine — evaluates active algorithms against their
 * watchlist tickers and opens/closes virtual positions.
 *
 * Uses the backtest engine's condition evaluation to guarantee consistency
 * between backtested and live-scanned signals.
 */
import { checkConditions, normalize, type Cache } from "@/lib/market-data/backtest-engine";
import { getCachedPrices, savePricesToCache } from "@/lib/market-data/price-cache";
import { fetchDailyPrices } from "@/lib/market-data/prices";
import { fetchBatchQuotes } from "@/lib/market-data/twelve-data";
import {
  isTechnicalCondition,
  type AlgorithmRules,
  type TechnicalCondition,
} from "@/types/algorithm";
import type { PaperPosition, PositionEvent } from "@/types/position";
import { evaluateEntry } from "./entry";
import { logActivity } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---- Types ----

export interface ScanResult {
  algorithm_id: string;
  algorithm_name: string;
  tickers_scanned: number;
  positions_opened: number;
  positions_closed: number;
  positions_updated: number;
  opened_details: PositionEvent[];
  closed_details: PositionEvent[];
  errors: { ticker: string; error: string }[];
}

interface AlgorithmWithWatchlist {
  id: string;
  name: string;
  description: string;
  rules: AlgorithmRules;
  capital: number;
  status: string;
  algorithm_watchlist: { ticker: string; name: string }[];
}

// ---- Position management ----

async function manageExistingPosition(
  supabase: SupabaseClient,
  userId: string,
  algo: AlgorithmWithWatchlist,
  ticker: string,
  position: PaperPosition,
  closes: number[],
  livePrice: number | null
): Promise<{ closed: number; updated: number; closeEvent?: PositionEvent }> {
  const currentPrice = livePrice ?? closes[closes.length - 1];
  const unrealizedPnl =
    position.side === "long"
      ? (currentPrice - position.entry_price) * position.quantity
      : (position.entry_price - currentPrice) * position.quantity;

  // Check stop loss / take profit / exit conditions
  const exitCheck = checkExitTrigger(position, currentPrice, algo.rules, closes);

  if (exitCheck) {
    const realizedPnl = unrealizedPnl;
    await supabase
      .from("paper_positions")
      .update({
        current_price: currentPrice,
        exit_price: currentPrice,
        unrealized_pnl: 0,
        realized_pnl: realizedPnl,
        exit_reason: exitCheck,
        status: "closed",
        closed_at: new Date().toISOString(),
      })
      .eq("id", position.id);

    let eventType = "position_closed";
    if (exitCheck === "stop_loss") {
      eventType = "stop_loss_hit";
    } else if (exitCheck === "take_profit") {
      eventType = "take_profit_hit";
    }

    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      position_id: position.id,
      event_type: eventType,
      ticker,
      details: { exit_price: currentPrice, realized_pnl: realizedPnl, exit_reason: exitCheck },
    });
    return {
      closed: 1,
      updated: 0,
      closeEvent: { ticker, reason: exitCheck, pnl: realizedPnl, price: currentPrice },
    };
  }

  // Just update price
  await supabase
    .from("paper_positions")
    .update({ current_price: currentPrice, unrealized_pnl: unrealizedPnl })
    .eq("id", position.id);
  return { closed: 0, updated: 1 };
}

function checkExitTrigger(
  position: PaperPosition,
  currentPrice: number,
  rules: AlgorithmRules,
  closes: number[]
): string | null {
  const isLong = position.side === "long";

  // Stop loss
  if (position.stop_loss_price != null) {
    const slHit = isLong
      ? currentPrice <= position.stop_loss_price
      : currentPrice >= position.stop_loss_price;
    if (slHit) {
      return "stop_loss";
    }
  }

  // Take profit
  if (position.take_profit_price != null) {
    const tpHit = isLong
      ? currentPrice >= position.take_profit_price
      : currentPrice <= position.take_profit_price;
    if (tpHit) {
      return "take_profit";
    }
  }

  // Technical exit conditions
  const normalizedExit = normalize(rules.exit_conditions);
  const techExit = normalizedExit.filter(isTechnicalCondition) as TechnicalCondition[];
  if (techExit.length > 0) {
    const cache: Cache = new Map();
    if (checkConditions(techExit, cache, closes, closes.length - 1)) {
      return "exit_signal";
    }
  }

  return null;
}

// ---- Per-ticker processing ----

async function processTicker(
  supabase: SupabaseClient,
  userId: string,
  algo: AlgorithmWithWatchlist,
  ticker: string,
  positions: PaperPosition[],
  result: ScanResult,
  liveQuotes: Map<string, number>
) {
  try {
    let prices = await getCachedPrices(ticker, "compact");
    if (!prices) {
      prices = await fetchDailyPrices(ticker, "compact");
      savePricesToCache(ticker, "compact", prices).catch(() => {});
    }
    if (prices.length < 10) {
      result.errors.push({ ticker, error: "Not enough price data" });
      result.tickers_scanned++;
      return;
    }

    const closes = prices.map((p) => p.close);
    const livePrice = liveQuotes.get(ticker.toUpperCase()) ?? null;
    const existing = positions.find((p) => p.ticker === ticker);

    if (existing) {
      const r = await manageExistingPosition(
        supabase,
        userId,
        algo,
        ticker,
        existing,
        closes,
        livePrice
      );
      result.positions_closed += r.closed;
      result.positions_updated += r.updated;
      if (r.closeEvent) {
        result.closed_details.push(r.closeEvent);
      }
    } else {
      const openCount = positions.filter((p) => p.status === "open").length;
      const alreadyHolding = positions.some((p) => p.ticker === ticker);
      if (openCount < algo.rules.max_positions && !alreadyHolding) {
        const r = await evaluateEntry(supabase, userId, algo, ticker, closes, positions, livePrice);
        result.positions_opened += r.opened;
        if (r.openEvent) {
          result.opened_details.push(r.openEvent);
        }
      }
    }
    result.tickers_scanned++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    result.errors.push({ ticker, error: msg });
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "error",
      ticker,
      details: { error: msg },
    });
  }
}

// ---- Core scan ----

/**
 * Scan a single algorithm against all its watchlist tickers.
 */
export async function scanAlgorithm(
  supabase: SupabaseClient,
  userId: string,
  algo: AlgorithmWithWatchlist
): Promise<ScanResult> {
  const result: ScanResult = {
    algorithm_id: algo.id,
    algorithm_name: algo.name,
    tickers_scanned: 0,
    positions_opened: 0,
    positions_closed: 0,
    positions_updated: 0,
    opened_details: [],
    closed_details: [],
    errors: [],
  };

  const tickers = algo.algorithm_watchlist.map((w) => w.ticker);
  if (tickers.length === 0) {
    return result;
  }

  await logActivity(supabase, userId, {
    algorithm_id: algo.id,
    event_type: "scan_started",
    details: { tickers_count: tickers.length },
  });

  const { data: openPositions } = await supabase
    .from("paper_positions")
    .select("*")
    .eq("algorithm_id", algo.id)
    .eq("user_id", userId)
    .eq("status", "open");

  const positions = (openPositions ?? []) as PaperPosition[];

  // Fetch real-time prices in one batch call for accurate entry/exit pricing
  let liveQuotes = new Map<string, number>();
  try {
    liveQuotes = await fetchBatchQuotes(tickers);
  } catch {
    // Fall back to daily closes if real-time quotes unavailable
  }

  for (const ticker of tickers) {
    await processTicker(supabase, userId, algo, ticker, positions, result, liveQuotes);
  }

  await logActivity(supabase, userId, {
    algorithm_id: algo.id,
    event_type: "scan_completed",
    details: {
      tickers_scanned: result.tickers_scanned,
      positions_opened: result.positions_opened,
      positions_closed: result.positions_closed,
      positions_updated: result.positions_updated,
      errors_count: result.errors.length,
    },
  });

  await supabase
    .from("algorithms")
    .update({ last_scanned_at: new Date().toISOString() })
    .eq("id", algo.id);

  return result;
}
