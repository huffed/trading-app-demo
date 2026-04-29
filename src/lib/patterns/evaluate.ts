/**
 * Bridge between AlgorithmRules' PatternCondition and the pure detector
 * primitives in this module. Single entry point that the backtest engine
 * + scan engine call to evaluate "does this pattern condition fire on
 * bar `idx`?".
 *
 * Direction filtering: a `liquidity_sweep` condition with
 * `direction: "bullish"` only fires on bullish sweeps. When the caller
 * supplies a `directionOverride` (auto-side regime mode), it takes
 * precedence over the condition's configured direction so a single algo
 * can adapt to whichever direction the market is currently trending.
 *
 * Stateful patterns (IFVG = a previously-filled FVG that price retests)
 * are computed here from the bar history rather than persisted across
 * scans — keeps the engine deterministic for backtest replay.
 */
import type { PriceBar } from "@/lib/market-data/types";
import type { PatternCondition } from "@/types/algorithm";
import { detectBos } from "./bos";
import { detectDailyBias } from "./daily-bias";
import { detectEngulfing } from "./engulfing";
import { detectFvg, scanFvgs } from "./fvg";
import { detectLiquiditySweep } from "./liquidity-sweep";
import { detectMomentum } from "./momentum";
import { detectOrderBlock } from "./order-block";
import { detectPinBar } from "./pin-bar";

/**
 * Evaluate a pattern condition against the bar series at index `idx`.
 * `higherTfBars` is optional — only used by the daily-bias pattern; if
 * omitted, daily-bias conditions always return false (caller should
 * supply resampled D1 bars for that case).
 *
 * `directionOverride` (auto-side regime mode) overrides the condition's
 * configured `direction` filter. Pass undefined to use cond.direction.
 */
export function evaluatePatternCondition(
  cond: PatternCondition,
  bars: PriceBar[],
  idx: number,
  higherTfBars?: PriceBar[],
  directionOverride?: "bullish" | "bearish"
): boolean {
  // Effective direction filter: override beats configured. Unset means
  // any direction matches — preserves the original "no filter" behaviour.
  const effectiveDir = directionOverride ?? cond.direction;
  switch (cond.pattern) {
    case "liquidity_sweep": {
      const r = detectLiquiditySweep(bars, idx, cond.lookback ?? 5);
      if (!r.detected || !r.details) return false;
      if (effectiveDir && r.details.direction !== effectiveDir) return false;
      return true;
    }
    case "fvg": {
      const r = detectFvg(bars, idx);
      if (!r.detected || !r.details) return false;
      if (effectiveDir && r.details.direction !== effectiveDir) return false;
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
        const inverseDir = g.gap.direction === "bullish" ? "bearish" : "bullish";
        if (effectiveDir && inverseDir !== effectiveDir) continue;
        return true;
      }
      return false;
    }
    case "daily_bias": {
      if (!higherTfBars || higherTfBars.length === 0) return false;
      const r = detectDailyBias(higherTfBars, cond.ma_period ?? 20);
      if (!r.detected || !r.details) return false;
      if (effectiveDir && r.details.bias !== effectiveDir) return false;
      return true;
    }
    case "bos": {
      const r = detectBos(bars, idx, cond.lookback ?? 5);
      if (!r.detected || !r.details) return false;
      if (effectiveDir && r.details.direction !== effectiveDir) return false;
      return true;
    }
    case "order_block": {
      // OB lookback is broader than swing-style patterns — caller-supplied
      // `lookback` overrides the default 30-bar zone-search window.
      const r = detectOrderBlock(bars, idx, { lookback: cond.lookback });
      if (!r.detected || !r.details) return false;
      if (effectiveDir && r.details.direction !== effectiveDir) return false;
      return true;
    }
    case "engulfing": {
      // Strict body-engulfing reversal candle. Single-bar lookback —
      // ignores cond.lookback (the pattern only ever looks at idx-1).
      const r = detectEngulfing(bars, idx);
      if (!r.detected || !r.details) return false;
      if (effectiveDir && r.details.direction !== effectiveDir) return false;
      return true;
    }
    case "pin_bar": {
      // Long-wick rejection candle. cond.lookback is ignored — pin bar
      // is a single-bar pattern. Defaults: wick ≥ 2× body, opposite
      // wick ≤ 0.5× dominant wick.
      const r = detectPinBar(bars, idx);
      if (!r.detected || !r.details) return false;
      if (effectiveDir && r.details.direction !== effectiveDir) return false;
      return true;
    }
    case "momentum": {
      // N-bar in-direction net move (ATR-scaled). cond.lookback sets
      // the bar count; defaults to 3 (matches feature analysis).
      // No condition-level threshold knob — uses pattern defaults.
      const r = detectMomentum(bars, idx, { lookback: cond.lookback });
      if (!r.detected || !r.details) return false;
      if (effectiveDir && r.details.direction !== effectiveDir) return false;
      return true;
    }
    default:
      return false;
  }
}
