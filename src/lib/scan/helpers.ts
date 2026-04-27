/**
 * Scan engine helpers — position sizing, risk price calculation, activity logging.
 */
import { getContractSize, notionalInUsd } from "@/lib/constants/markets";
import type { AlgorithmRules } from "@/types/algorithm";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface PositionSizingResult {
  quantity: number;
  notionalValue: number;
  /** Margin required from the account to open this position. For
   *  percentage/fixed sizing this equals notional (no leverage modelled).
   *  For lot sizing it's notional / leverage. */
  marginRequired: number;
}

/**
 * Compute notional + margin for a new position. Returns null if the
 * algorithm doesn't have enough free margin to open it.
 *
 * `openPositionsValue` is summed margin (NOT notional) of currently open
 * positions, so legacy callers passing notional still work for the
 * non-leveraged paths because margin == notional there.
 */
export function calculatePositionSize(
  rules: AlgorithmRules,
  capital: number,
  openPositionsValue: number,
  currentPrice: number,
  symbol?: string
): PositionSizingResult | null {
  const available = capital - openPositionsValue;
  if (available <= 0) return null;

  const sizing = rules.position_sizing;

  if (sizing.type === "lots") {
    const contractSize = getContractSize(symbol ?? "", rules.asset_class);
    const leverage = rules.leverage ?? 30;
    const lots = sizing.value;
    // Notional in USD respects cross-pair quote currency (EUR/JPY etc.).
    const notional = notionalInUsd(symbol ?? "", lots, currentPrice);
    const marginRequired = notional / leverage;
    if (marginRequired > available || lots <= 0) return null;
    return { quantity: lots * contractSize, notionalValue: notional, marginRequired };
  }

  if (sizing.type === "fixed_quantity") {
    const notional = sizing.value * currentPrice;
    return { quantity: sizing.value, notionalValue: notional, marginRequired: notional };
  }

  let notional: number;
  if (sizing.type === "percentage_of_capital") {
    notional = capital * (sizing.value / 100);
  } else {
    notional = sizing.value; // fixed_amount
  }

  if (notional > available) return null;
  const quantity = notional / currentPrice;
  if (quantity <= 0) return null;
  return { quantity, notionalValue: notional, marginRequired: notional };
}

export function calculateRiskPrices(
  entryPrice: number,
  rules: AlgorithmRules,
  side: "long" | "short"
): { stopLossPrice: number; takeProfitPrice: number } {
  const slPct = rules.stop_loss.type === "percentage";
  const tpPct = rules.take_profit.type === "percentage";

  if (side === "long") {
    return {
      stopLossPrice: slPct
        ? entryPrice * (1 - rules.stop_loss.value / 100)
        : entryPrice - rules.stop_loss.value,
      takeProfitPrice: tpPct
        ? entryPrice * (1 + rules.take_profit.value / 100)
        : entryPrice + rules.take_profit.value,
    };
  }
  return {
    stopLossPrice: slPct
      ? entryPrice * (1 + rules.stop_loss.value / 100)
      : entryPrice + rules.stop_loss.value,
    takeProfitPrice: tpPct
      ? entryPrice * (1 - rules.take_profit.value / 100)
      : entryPrice - rules.take_profit.value,
  };
}

export async function logActivity(
  supabase: SupabaseClient,
  userId: string,
  entry: {
    algorithm_id: string;
    position_id?: string;
    event_type: string;
    ticker?: string;
    details?: Record<string, unknown>;
  }
) {
  await supabase.from("activity_log").insert({
    user_id: userId,
    algorithm_id: entry.algorithm_id,
    position_id: entry.position_id ?? null,
    event_type: entry.event_type,
    ticker: entry.ticker ?? null,
    details: entry.details ?? {},
  });
}
