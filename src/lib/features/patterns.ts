/**
 * H.3 — Pattern-primitive features. Wraps each of the 14 canonical
 * ICT/SMC patterns (the non-gold-session subset of PatternCondition's
 * pattern enum) as a Feature returning a SIGNED value:
 *   +1  → bullish variant fires at this bar
 *   −1  → bearish variant fires at this bar
 *    0  → neither fires, OR both fire (ambiguous → neutral)
 *
 * The signed representation lets xgboost (H.3) split on directionality
 * in a single feature instead of requiring 28 boolean features
 * (2 directions × 14 patterns). Spec line: "14 pattern primitives".
 *
 * Gold-session-scoped patterns (gold_session_window, asian_range_break,
 * post_news_window) are intentionally EXCLUDED here — they need
 * session-time / news-event context that the bar-level feature
 * interface doesn't carry; they're handled by their own gates in the
 * scan path.
 *
 * Consumed by H.3 (feature importance via xgboost) and H.4 (top-K
 * features composed as Layer B axes).
 */
import { evaluatePatternCondition } from "@/lib/patterns";
import type { PatternCondition } from "@/types/algorithm";
import type { Feature } from "./types";

const PATTERN_NAMES = [
  "liquidity_sweep",
  "liquidity_sweep_reclaim",
  "fvg",
  "ifvg",
  "daily_bias",
  "bos",
  "choch",
  "ote",
  "equal_levels",
  "order_block",
  "engulfing",
  "pin_bar",
  "momentum",
  "mean_reversion",
] as const;

type PatternName = (typeof PATTERN_NAMES)[number];

function patternFeature(pattern: PatternName): Feature {
  return {
    name: `pattern_${pattern}_signed`,
    category: "pattern",
    description: `${pattern} pattern signed (+1=bullish, −1=bearish, 0=absent/ambiguous)`,
    compute: (bars, idx, ctx) => {
      // Patterns each have their own lookback requirements; failures
      // (insufficient bars, missing higherTfBars for daily_bias, etc.)
      // are converted to null per the H.2 registry contract.
      try {
        const bullCond = {
          type: "pattern" as const,
          pattern,
          direction: "bullish" as const,
          timeframe: "4h",
        } satisfies PatternCondition;
        const bearCond = {
          type: "pattern" as const,
          pattern,
          direction: "bearish" as const,
          timeframe: "4h",
        } satisfies PatternCondition;
        const bull = evaluatePatternCondition(bullCond, bars, idx, ctx?.higherTfBars);
        const bear = evaluatePatternCondition(bearCond, bars, idx, ctx?.higherTfBars);
        if (bull && !bear) return 1;
        if (bear && !bull) return -1;
        return 0; // neither, OR both → neutral
      } catch {
        return null;
      }
    },
  };
}

export const PATTERN_FEATURES: readonly Feature[] = PATTERN_NAMES.map(patternFeature);
