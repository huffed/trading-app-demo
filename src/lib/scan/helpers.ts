/**
 * Scan engine helpers — position sizing, risk price calculation, activity logging.
 */
import {
  getContractSize,
  notionalInUsd,
  priceDeltaForRule,
  riskToLots,
  ruleAsPctOfEntry,
} from "@/lib/constants/markets";
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
  symbol?: string,
  convictionMultiplier: number = 1,
  /** Pre-computed SL distance in price units. Required for structural
   *  rule types (swing_anchor / rr_multiple) whose distance can't be
   *  derived from the rule + entry price alone. For percentage / fixed
   *  / pips rules, omitting this is fine — the function falls back to
   *  ruleAsPctOfEntry which handles those types deterministically. */
  slDistanceOverride?: number
): PositionSizingResult | null {
  const available = capital - openPositionsValue;
  if (available <= 0) return null;

  const sizing = rules.position_sizing;

  if (
    sizing.type === "lots" ||
    sizing.type === "risk_per_trade" ||
    sizing.type === "conviction_scaled"
  ) {
    const contractSize = getContractSize(symbol ?? "", rules.asset_class);
    const leverage = rules.leverage ?? 30;
    let lots: number;
    if (sizing.type === "lots") {
      lots = sizing.value;
    } else {
      // risk_per_trade / conviction_scaled: derive lots from SL distance +
      // capital + cross-rate. conviction_scaled additionally multiplies the
      // base risk percentage by the caller-provided multiplier (defaults to
      // 1, equivalent to risk_per_trade behaviour).
      const slPct =
        slDistanceOverride !== undefined && currentPrice > 0
          ? (slDistanceOverride / currentPrice) * 100
          : ruleAsPctOfEntry(rules.stop_loss, currentPrice, symbol);
      const effectiveRiskPct =
        sizing.type === "conviction_scaled"
          ? sizing.value * Math.max(1, convictionMultiplier)
          : sizing.value;
      lots = riskToLots(symbol ?? "", capital, effectiveRiskPct, currentPrice, slPct);
    }
    if (lots <= 0) return null;
    const notional = notionalInUsd(symbol ?? "", lots, currentPrice);
    const marginRequired = notional / leverage;
    if (marginRequired > available) return null;
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
  side: "long" | "short",
  symbol?: string,
  /** Pre-computed SL/TP distances in price units. When provided, used
   *  directly to set SL/TP prices. Required for structural rule types
   *  (swing_anchor / rr_multiple) whose distance can't be derived from
   *  the rule alone. For percentage / fixed / pips rules, callers can
   *  omit and the function recomputes via priceDeltaForRule. */
  slDistance?: number,
  tpDistance?: number
): { stopLossPrice: number; takeProfitPrice: number } {
  const slDelta = slDistance ?? priceDeltaForRule(rules.stop_loss, entryPrice, symbol);
  const tpDelta = tpDistance ?? priceDeltaForRule(rules.take_profit, entryPrice, symbol);

  if (side === "long") {
    return {
      stopLossPrice: entryPrice - slDelta,
      takeProfitPrice: entryPrice + tpDelta,
    };
  }
  return {
    stopLossPrice: entryPrice + slDelta,
    takeProfitPrice: entryPrice - tpDelta,
  };
}

export async function logActivity(
  supabase: SupabaseClient,
  userId: string,
  entry: {
    algorithm_id: string | null;
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
