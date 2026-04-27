/**
 * Technical-condition evaluation primitives. Compares an indicator value
 * against the threshold in a TechnicalCondition, with the special
 * `value === 0` cases that compare against price (or against EMA26 for
 * the standard MACD-style EMA12 crossover).
 *
 * Pure: no DB, no fetches, no I/O. The indicator cache + close series
 * come from the caller so this can run inside both the backtest loop
 * and the live scan path.
 */
import type { TechnicalCondition } from "@/types/algorithm";
import { getValues, isPriceIndicator, type Cache } from "./indicator-registry";

function evalPriceComparison(
  cond: TechnicalCondition,
  indVals: (number | null)[],
  closes: number[],
  cache: Cache,
  i: number
): boolean {
  const ind = indVals[i];
  if (ind === null) return false;
  const prevInd = indVals[i - 1] ?? null;

  // EMA12 with value=0 → compare against EMA26 (standard MACD crossover).
  if (cond.indicator.toLowerCase() === "ema12") {
    const ema26Vals = getValues("EMA26", cache, closes);
    const comp = ema26Vals[i];
    const prevComp = ema26Vals[i - 1] ?? null;
    if (comp === null) return false;
    switch (cond.operator) {
      case "less_than":
        return ind < comp;
      case "greater_than":
        return ind > comp;
      case "crosses_above":
        return prevInd !== null && prevComp !== null && prevInd <= prevComp && ind > comp;
      case "crosses_below":
        return prevInd !== null && prevComp !== null && prevInd >= prevComp && ind < comp;
    }
  }
  const price = closes[i];
  const prevPrice = closes[i - 1] ?? null;
  switch (cond.operator) {
    case "less_than":
      return price < ind;
    case "greater_than":
      return price > ind;
    case "crosses_above":
      return prevPrice !== null && prevInd !== null && prevPrice <= prevInd && price > ind;
    case "crosses_below":
      return prevPrice !== null && prevInd !== null && prevPrice >= prevInd && price < ind;
    default:
      return false;
  }
}

export function evaluateTechnical(
  cond: TechnicalCondition,
  indVals: (number | null)[],
  closes: number[],
  cache: Cache,
  i: number
): boolean {
  const val = indVals[i];
  if (val === null) return false;
  if (cond.value === 0 && isPriceIndicator(cond.indicator)) {
    return evalPriceComparison(cond, indVals, closes, cache, i);
  }
  const prev = indVals[i - 1] ?? null;
  switch (cond.operator) {
    case "less_than":
      return val < cond.value;
    case "greater_than":
      return val > cond.value;
    case "crosses_above":
      return prev !== null && prev <= cond.value && val > cond.value;
    case "crosses_below":
      return prev !== null && prev >= cond.value && val < cond.value;
    default:
      return false;
  }
}
