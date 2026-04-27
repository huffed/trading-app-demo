/**
 * Bridge between AlgorithmRules' PatternCondition and the pure detector
 * primitives in this module. Single entry point that the backtest engine
 * + scan engine call to evaluate "does this pattern condition fire on
 * bar `idx`?".
 *
 * Direction filtering is applied here: a `liquidity_sweep` condition with
 * `direction: "bullish"` only fires on bullish sweeps (price pierced a
 * swing low and closed back above). When direction is omitted, any sweep
 * matches.
 *
 * Stateful patterns (IFVG = a previously-filled FVG that price retests)
 * are computed here from the bar history rather than persisted across
 * scans — keeps the engine deterministic for backtest replay.
 */
import type { PriceBar } from "@/lib/market-data/types";
import type { PatternCondition } from "@/types/algorithm";
import { detectDailyBias } from "./daily-bias";
import { detectFvg, scanFvgs } from "./fvg";
import { detectLiquiditySweep } from "./liquidity-sweep";

/**
 * Evaluate a pattern condition against the bar series at index `idx`.
 * `higherTfBars` is optional — only used by the daily-bias pattern; if
 * omitted, daily-bias conditions always return false (caller should fetch
 * + supply D1 bars for that case).
 */
export function evaluatePatternCondition(
  cond: PatternCondition,
  bars: PriceBar[],
  idx: number,
  higherTfBars?: PriceBar[]
): boolean {
  switch (cond.pattern) {
    case "liquidity_sweep": {
      const r = detectLiquiditySweep(bars, idx, cond.lookback ?? 5);
      if (!r.detected || !r.details) return false;
      if (cond.direction && r.details.direction !== cond.direction) return false;
      return true;
    }
    case "fvg": {
      const r = detectFvg(bars, idx);
      if (!r.detected || !r.details) return false;
      if (cond.direction && r.details.direction !== cond.direction) return false;
      return true;
    }
    case "ifvg": {
      // An IFVG signal: a previously-detected FVG that has been filled
      // AND the current bar is interacting with the gap zone again. The
      // gap acts in the inverse direction post-fill (bullish FVG that
      // got filled → now resistance on retest).
      const inventory = scanFvgs(bars.slice(0, idx + 1));
      const filled = inventory.filter((g) => g.filled_at != null && g.filled_at < idx);
      if (filled.length === 0) return false;
      const bar = bars[idx];
      for (const g of filled) {
        const inZone = bar.low <= g.gap.gap_top && bar.high >= g.gap.gap_bottom;
        if (!inZone) continue;
        // Inverted direction — a bullish FVG flipped is a bearish signal.
        const inverseDir = g.gap.direction === "bullish" ? "bearish" : "bullish";
        if (cond.direction && inverseDir !== cond.direction) continue;
        return true;
      }
      return false;
    }
    case "daily_bias": {
      if (!higherTfBars || higherTfBars.length === 0) return false;
      const r = detectDailyBias(higherTfBars, cond.ma_period ?? 20);
      if (!r.detected || !r.details) return false;
      if (cond.direction && r.details.bias !== cond.direction) return false;
      return true;
    }
    default:
      return false;
  }
}
