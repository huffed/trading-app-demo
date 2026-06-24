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
import { detectDoji } from "./doji";
import { detectEqualLevels } from "./equal-levels";
import { detectOte } from "./ote";
import { detectDailyBias } from "./daily-bias";
import { detectEngulfing } from "./engulfing";
import { detectFvg, scanFvgs } from "./fvg";
import { detectSessionWindow } from "./gold-session-window";
import { detectInsideBar } from "./inside-bar";
import { detectLiquiditySweep } from "./liquidity-sweep";
import { detectLiquiditySweepReclaim } from "./liquidity-sweep-reclaim";
import { detectMeanReversion } from "./mean-reversion";
import { detectMomentum } from "./momentum";
import { detectOrderBlock } from "./order-block";
import { detectOutsideBar } from "./outside-bar";
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
  // Try the SMC/ICT structural patterns first, then candle patterns,
  // then bias patterns. Each helper returns null for "not my pattern" so
  // the dispatch chain can fall through without false-positives.
  const ict = evaluateIctSmcPattern(cond, bars, idx, effectiveDir);
  if (ict !== null) return ict;
  const candle = evaluateCandlePattern(cond, bars, idx, effectiveDir);
  if (candle !== null) return candle;
  if (cond.pattern === "daily_bias") {
    return evaluateDailyBiasPattern(cond, bars, idx, higherTfBars, effectiveDir);
  }
  return false;
}

/** ICT/SMC structural patterns (sweeps, FVG, IFVG, BOS, CHOCH, OTE,
 *  equal-levels, order-block). Returns null when cond.pattern isn't one
 *  of them so the orchestrator can fall through. */
function evaluateIctSmcPattern(
  cond: PatternCondition,
  bars: PriceBar[],
  idx: number,
  effectiveDir: "bullish" | "bearish" | undefined
): boolean | null {
  const matchDir = (dir: "bullish" | "bearish" | undefined): boolean =>
    !effectiveDir || dir === effectiveDir;
  switch (cond.pattern) {
    case "liquidity_sweep": {
      const r = detectLiquiditySweep(bars, idx, cond.lookback ?? 5);
      return Boolean(r.detected && r.details && matchDir(r.details.direction));
    }
    case "liquidity_sweep_reclaim": {
      const r = detectLiquiditySweepReclaim(bars, idx, { lookback: cond.lookback ?? 5, reclaim_window: 3 });
      return Boolean(r.detected && r.details && matchDir(r.details.direction));
    }
    case "fvg": {
      // detectFvg anchors at middle bar; pass idx-1 for causal entry on confirming bar.
      if (idx < 2) return false;
      const r = detectFvg(bars, idx - 1);
      return Boolean(r.detected && r.details && matchDir(r.details.direction));
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
    case "bos": {
      const r = detectBos(bars, idx, cond.lookback ?? 5);
      return Boolean(r.detected && r.details && matchDir(r.details.direction));
    }
    case "choch": {
      const r = detectChoch(bars, idx, cond.lookback ?? 5);
      return Boolean(r.detected && r.details && matchDir(r.details.direction));
    }
    case "ote": {
      const r = detectOte(bars, idx, cond.lookback ?? 5);
      return Boolean(r.detected && r.details && matchDir(r.details.direction));
    }
    case "equal_levels": {
      // Equal highs/lows — ICT liquidity pools. Direction selects swing
      // pole (high vs low); refuse without it.
      if (!effectiveDir) return false;
      const r = detectEqualLevels(bars, idx, effectiveDir, { swingLookback: cond.lookback });
      return Boolean(r.detected && r.details);
    }
    case "order_block": {
      const r = detectOrderBlock(bars, idx, { lookback: cond.lookback });
      return Boolean(r.detected && r.details && matchDir(r.details.direction));
    }
    default:
      return null;
  }
}

/** Candle + momentum/mean-reversion patterns. Returns null when
 *  cond.pattern isn't one of them. */
function evaluateCandlePattern(
  cond: PatternCondition,
  bars: PriceBar[],
  idx: number,
  effectiveDir: "bullish" | "bearish" | undefined
): boolean | null {
  const matchDir = (dir: "bullish" | "bearish" | undefined): boolean =>
    !effectiveDir || dir === effectiveDir;
  switch (cond.pattern) {
    case "engulfing": {
      const r = detectEngulfing(bars, idx);
      return Boolean(r.detected && r.details && matchDir(r.details.direction));
    }
    case "pin_bar": {
      const r = detectPinBar(bars, idx);
      return Boolean(r.detected && r.details && matchDir(r.details.direction));
    }
    case "momentum": {
      const r = detectMomentum(bars, idx, { lookback: cond.lookback });
      return Boolean(r.detected && r.details && matchDir(r.details.direction));
    }
    case "mean_reversion": {
      const r = detectMeanReversion(bars, idx, { lookback: cond.lookback });
      return Boolean(r.detected && r.details && matchDir(r.details.direction));
    }
    case "inside_bar": {
      const r = detectInsideBar(bars, idx);
      return Boolean(r.detected && r.details && matchDir(r.details.direction));
    }
    case "outside_bar": {
      const r = detectOutsideBar(bars, idx);
      return Boolean(r.detected && r.details && matchDir(r.details.direction));
    }
    case "doji": {
      // Doji is direction-agnostic (close ≈ open). When a direction filter
      // is set, the doji condition cannot satisfy it on its own — the
      // caller must combine with another directional pattern (daily_bias,
      // BOS, etc.). When no direction filter is set, any detected doji fires.
      if (effectiveDir) return false;
      const r = detectDoji(bars, idx);
      return Boolean(r.detected);
    }
    default:
      return null;
  }
}

/** Daily-bias evaluator — aligns higherTfBars to the current primary
 *  bar's date so backtest doesn't get the look-ahead bias from the
 *  detector's default "last 20 bars" semantics. */
function evaluateDailyBiasPattern(
  cond: PatternCondition,
  bars: PriceBar[],
  idx: number,
  higherTfBars: PriceBar[] | undefined,
  effectiveDir: "bullish" | "bearish" | undefined
): boolean {
  if (!higherTfBars || higherTfBars.length === 0) return false;
  const dIdx = alignBarIndex(higherTfBars, bars[idx].date);
  if (dIdx < 0) return false;
  const alignedDaily = higherTfBars.slice(0, dIdx + 1);
  const r = detectDailyBias(alignedDaily, cond.ma_period ?? 20);
  if (!r.detected || !r.details) return false;
  return !effectiveDir || r.details.bias === effectiveDir;
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
