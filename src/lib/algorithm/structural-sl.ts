/**
 * Structural SL/TP placement — anchors stops to recent price structure
 * (swing low/high) instead of fixed-% or ATR-multiple distance.
 *
 * Two new rule types:
 *   - `swing_anchor` SL: SL = swing-low (long) or swing-high (short)
 *     within `lookback` bars before entry, plus an optional ATR buffer
 *     to push it just beyond the structural level. The `value` field
 *     is the buffer multiplier (fraction of ATR added beyond the swing).
 *   - `rr_multiple` TP: TP distance = `value` × SL distance. The
 *     standard pro setup once the SL is structurally placed: position
 *     sizing's `risk_per_trade` already adapts lot count so dollar-
 *     risk stays constant per trade regardless of SL distance.
 *
 * Engine pattern: compute distances ONCE at entry-bar, store on the
 * position (slDistance / tpDistance fields). All subsequent calls
 * (trailing init, stagnant gate, exit-price detection) use the stored
 * values. Mirrors how a live order's SL/TP prices are set at order
 * placement and never re-derived.
 */
import { computeAtr } from "@/lib/market-data/regime-filter";
import type { PriceBar } from "@/lib/market-data/types";
import type { AlgorithmRules } from "@/types/algorithm";
import { priceDeltaForRule } from "@/lib/constants/markets";

const DEFAULT_SWING_LOOKBACK = 8;
const DEFAULT_BUFFER_ATR_PERIOD = 14;

/** Compute SL distance for any rule type. For "swing_anchor" the
 *  distance is anchored to the swing low/high in `lookback` bars
 *  preceding (and including) the entry bar; otherwise dispatches to
 *  priceDeltaForRule. */
export function computeSlDistance(
  rule: AlgorithmRules["stop_loss"],
  side: "long" | "short",
  entryPrice: number,
  symbol: string | undefined,
  bars: PriceBar[],
  entryIdx: number
): number {
  if (rule.type !== "swing_anchor") {
    return priceDeltaForRule(rule, entryPrice, symbol);
  }
  const lookback = rule.lookback ?? DEFAULT_SWING_LOOKBACK;
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
  // ATR buffer pushes SL just beyond the swing point. value=0.25 means
  // the SL sits 0.25×ATR beyond the structural level, escaping any
  // immediate sweep.
  const bufferMultiplier = rule.value;
  if (bufferMultiplier <= 0 || baseDistance <= 0) return Math.max(baseDistance, 0);
  const series = computeAtr(bars, rule.atr_period ?? DEFAULT_BUFFER_ATR_PERIOD);
  const atr = series[entryIdx] ?? 0;
  return baseDistance + bufferMultiplier * atr;
}

/** Compute TP distance for any rule type. For "rr_multiple" the
 *  distance is `value` × slDistance; otherwise dispatches to
 *  priceDeltaForRule. Caller must compute slDistance first. */
export function computeTpDistance(
  rule: AlgorithmRules["take_profit"],
  slDistance: number,
  entryPrice: number,
  symbol: string | undefined
): number {
  if (rule.type !== "rr_multiple") {
    return priceDeltaForRule(rule, entryPrice, symbol);
  }
  return rule.value * slDistance;
}
