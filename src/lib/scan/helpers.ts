/**
 * Scan engine helpers — position sizing, risk price calculation, activity logging.
 */
import type { AlgorithmRules } from "@/types/algorithm";
import type { SupabaseClient } from "@supabase/supabase-js";

export function calculatePositionSize(
  rules: AlgorithmRules,
  capital: number,
  openPositionsValue: number,
  currentPrice: number
): { quantity: number; notionalValue: number } | null {
  const available = capital - openPositionsValue;
  if (available <= 0) {
    return null;
  }

  let notional: number;
  switch (rules.position_sizing.type) {
    case "percentage_of_capital":
      notional = capital * (rules.position_sizing.value / 100);
      break;
    case "fixed_amount":
      notional = rules.position_sizing.value;
      break;
    case "fixed_quantity":
      return {
        quantity: rules.position_sizing.value,
        notionalValue: rules.position_sizing.value * currentPrice,
      };
  }

  if (notional > available) {
    return null;
  }
  const quantity = notional / currentPrice;
  if (quantity <= 0) {
    return null;
  }
  return { quantity, notionalValue: notional };
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
