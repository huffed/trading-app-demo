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
import type { EconomicEvent } from "@/lib/market-data/economic-calendar";
import { alignBarIndex } from "@/lib/market-data/resample";
import type { PriceBar } from "@/lib/market-data/types";
import type { PatternCondition } from "@/types/algorithm";
import { detectAsianRangeBreak } from "./asian-range-break";
import { detectBos } from "./bos";
import { detectChoch } from "./choch";
import { detectEqualLevels } from "./equal-levels";
import { detectOte } from "./ote";
import { detectDailyBias } from "./daily-bias";
import { detectEngulfing } from "./engulfing";
import { detectFvg, scanFvgs } from "./fvg";
import { detectSessionWindow } from "./gold-session-window";
import { detectLiquiditySweep } from "./liquidity-sweep";
import { detectLiquiditySweepReclaim } from "./liquidity-sweep-reclaim";
import { detectMeanReversion } from "./mean-reversion";
import { detectMomentum } from "./momentum";
import { detectOrderBlock } from "./order-block";
import { detectPinBar } from "./pin-bar";
import { detectPostNewsWindow } from "./post-news-window";

/**
 * Optional context for patterns that depend on data outside the bar
 * series (currently only `post_news_window`, which needs a news feed).
 * Backwards compatible — callers that don't supply context get the
 * pre-existing behaviour.
 */
export interface PatternEvaluationContext {
  /** Economic events available for `post_news_window` matching. Empty /
   *  undefined causes that pattern to return false. */
  news_events?: EconomicEvent[];
  /** Currencies relevant to the algorithm's symbol — passed to
   *  `post_news_window` so it only fires on news affecting the traded
   *  symbol. Typically populated via `getEventCurrencies(symbol)`. */
  relevant_currencies?: string[];
}

/**
 * Evaluate a pattern condition against the bar series at index `idx`.
 * `higherTfBars` is optional — only used by the daily-bias pattern; if
 * omitted, daily-bias conditions always return false (caller should
 * supply resampled D1 bars for that case).
 *
 * `directionOverride` (auto-side regime mode) overrides the condition's
 * configured `direction` filter. Pass undefined to use cond.direction.
 *
 * `context` carries data needed by news-aware patterns. Pass undefined
 * for backwards compatibility — only `post_news_window` consults it.
 */
export function evaluatePatternCondition(
  cond: PatternCondition,
  bars: PriceBar[],
  idx: number,
  higherTfBars?: PriceBar[],
  directionOverride?: "bullish" | "bearish",
  context?: PatternEvaluationContext
): boolean {
  const effectiveDir = directionOverride ?? cond.direction;
  if (
    cond.pattern === "gold_session_window" ||
    cond.pattern === "asian_range_break" ||
    cond.pattern === "post_news_window"
  ) {
    return evaluateGoldOnlyPattern(cond, bars, idx, effectiveDir, context);
  }
  return evaluateClassicPattern(cond, bars, idx, higherTfBars, effectiveDir);
}

/** Classic ICT/SMC pattern dispatch — the original nine patterns. Split
 *  out so the main `evaluatePatternCondition` stays a thin dispatcher
 *  between the gold-scoped exception set and the general-purpose set. */
function evaluateClassicPattern(
  cond: PatternCondition,
  bars: PriceBar[],
  idx: number,
  higherTfBars: PriceBar[] | undefined,
  effectiveDir: "bullish" | "bearish" | undefined
): boolean {
  switch (cond.pattern) {
    case "liquidity_sweep": {
      const r = detectLiquiditySweep(bars, idx, cond.lookback ?? 5);
      if (!r.detected || !r.details) return false;
      if (effectiveDir && r.details.direction !== effectiveDir) return false;
      return true;
    }
    case "liquidity_sweep_reclaim": {
      const r = detectLiquiditySweepReclaim(bars, idx, {
        lookback: cond.lookback ?? 5,
        reclaim_window: 3,
      });
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
      // Previously-filled FVG retest — gap acts inverse to its original direction.
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
      // detectDailyBias reads `bars.slice(-period)` — the LAST 20 daily
      // bars regardless of which primary bar we're evaluating. That's
      // correct for live trading (the last bar IS today) but is a
      // look-ahead bias in backtest: every historical bar gets asked
      // "is TODAY (June 2026) bullish?" instead of "was THAT day
      // bullish?". The bug suppressed all entries on instruments whose
      // present-day bias didn't match the rule's direction (the 7+
      // zero-trade library algos). Align higherTfBars to the current
      // primary bar's date first.
      const dIdx = alignBarIndex(higherTfBars, bars[idx].date);
      if (dIdx < 0) return false;
      const alignedDaily = higherTfBars.slice(0, dIdx + 1);
      const r = detectDailyBias(alignedDaily, cond.ma_period ?? 20);
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
    case "choch": {
      // Trend-reversal break — opposite-direction structural break.
      // cond.lookback controls swing detection (default 5, ICT default).
      const r = detectChoch(bars, idx, cond.lookback ?? 5);
      if (!r.detected || !r.details) return false;
      if (effectiveDir && r.details.direction !== effectiveDir) return false;
      return true;
    }
    case "ote": {
      // Optimal Trade Entry — fib retracement [62%, 79%] of the most
      // recent confirmed leg. cond.lookback controls swing detection.
      const r = detectOte(bars, idx, cond.lookback ?? 5);
      if (!r.detected || !r.details) return false;
      if (effectiveDir && r.details.direction !== effectiveDir) return false;
      return true;
    }
    case "equal_levels": {
      // Equal highs / equal lows — ICT liquidity pools. cond.lookback is
      // passed as swingLookback (default 5, ICT default); the cluster
      // tolerance + scanWindow + minCount stay at the detector's defaults
      // (0.1%, 50 bars, 2 swings). The bullish/bearish direction is required
      // — it selects swing-low vs swing-high cluster.
      if (!effectiveDir) return false;
      const r = detectEqualLevels(bars, idx, effectiveDir, { swingLookback: cond.lookback });
      if (!r.detected || !r.details) return false;
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
    case "mean_reversion": {
      // Stretched-from-mean + reversal candle. cond.lookback overrides
      // the trailing-window length (default 20). No condition-level
      // stdev-threshold knob currently — uses pattern defaults (1.5).
      const r = detectMeanReversion(bars, idx, { lookback: cond.lookback });
      if (!r.detected || !r.details) return false;
      if (effectiveDir && r.details.direction !== effectiveDir) return false;
      return true;
    }
    default:
      return false;
  }
}

/** Gold-only pattern dispatch — split out so the main switch stays
 *  inside the function-size lint budget and the carve-out is visually
 *  isolated from the general-purpose patterns. */
function evaluateGoldOnlyPattern(
  cond: PatternCondition,
  bars: PriceBar[],
  idx: number,
  effectiveDir: "bullish" | "bearish" | undefined,
  context: PatternEvaluationContext | undefined
): boolean {
  switch (cond.pattern) {
    case "gold_session_window": {
      // Time gate, not a directional signal — direction filter is
      // intentionally NOT applied. The session field carries the
      // window name; without it the condition is degenerate.
      if (!cond.session) return false;
      return detectSessionWindow(bars, idx, { session: cond.session }).detected;
    }
    case "asian_range_break": {
      const r = detectAsianRangeBreak(bars, idx);
      if (!r.detected || !r.details) return false;
      if (effectiveDir && r.details.direction !== effectiveDir) return false;
      return true;
    }
    case "post_news_window": {
      // Strict context requirement — refuse to fire without news data
      // rather than silently approximating. Backtest engines populate
      // context.news_events from WalkForwardOptions.events; live scan
      // populates from the economic-calendar fetch.
      if (!context?.news_events || context.news_events.length === 0) return false;
      const r = detectPostNewsWindow(bars, idx, {
        events: context.news_events,
        min_minutes_after: cond.min_minutes_after,
        max_minutes_after: cond.max_minutes_after,
        min_impact: cond.min_impact,
        relevant_currencies: context.relevant_currencies,
      });
      // Time-window detector — direction filter doesn't apply.
      return r.detected;
    }
    default:
      return false;
  }
}
