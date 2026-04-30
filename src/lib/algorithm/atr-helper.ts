/**
 * ATR computation helper for atr_multiple SL/TP rules.
 *
 * Wraps `computeAtr` from regime-filter.ts and returns the single
 * value at a given bar index — what `priceDeltaForRule` consumes
 * when the rule's type is "atr_multiple".
 *
 * Returns undefined for non-atr_multiple rules. priceDeltaForRule
 * treats undefined as a no-op signal and falls through to its other
 * type branches, so callers can unconditionally compute and pass
 * without checking type themselves.
 */
import { computeAtr } from "@/lib/market-data/regime-filter";
import type { PriceBar } from "@/lib/market-data/types";
import type { AlgorithmRules } from "@/types/algorithm";

type StopOrTpRule = AlgorithmRules["stop_loss"];

const DEFAULT_ATR_PERIOD = 14;

export function atrForRule(
  rule: StopOrTpRule,
  bars: PriceBar[],
  idx: number
): number | undefined {
  if (rule.type !== "atr_multiple") return undefined;
  if (idx < 0 || idx >= bars.length) return undefined;
  const period = rule.atr_period ?? DEFAULT_ATR_PERIOD;
  if (idx < period) return undefined;
  const series = computeAtr(bars, period);
  const v = series[idx];
  return v ?? undefined;
}
