/**
 * Exit-condition variants enumerated as the 3rd dimension of the
 * combinatorial search. Each (template × params) pair gets evaluated
 * with each applicable exit variant; walk-forward picks the best
 * combination empirically.
 *
 * Why this exists: 2026-04-30 vetting showed exit-condition impact is
 * template-specific. Bearish-BOS exits doubled `ict_bos_orderblock` EV
 * (+0.33R → +0.66R) but destroyed `momentum_solo` (+0.25R → -0.33R).
 * Hard-coding one exit per template is wrong; testing variants per
 * template is right.
 */
import type { AlgorithmRules, EntryCondition } from "@/types/algorithm";

export interface ExitVariant {
  name: string;
  /** Returns the exit shape for this template/timeframe/side, or null
   *  to skip the variant for this candidate (e.g., signal-flip exits
   *  don't apply to AUTO-side templates because direction is unknown
   *  at template-build time). */
  build: (
    templateName: string,
    primaryTf: string,
    side: "long" | "short" | "auto"
  ) => { exit_conditions: EntryCondition[]; exit_logic: AlgorithmRules["exit_logic"] } | null;
}

export const EXIT_VARIANTS: ExitVariant[] = [
  // Baseline — no exits, rely on SL/TP/stagnant only.
  { name: "no_exit", build: () => ({ exit_conditions: [], exit_logic: undefined }) },
  // Signal-class invalidation — opposite-direction version of the entry's
  // primary pattern. Template-specific (different entries → different
  // flips). Returns null for AUTO-side templates and templates where the
  // flip doesn't have clean semantics (bare-indicator templates).
  { name: "signal_flip", build: signalFlipExit },
  // Higher-TF bias reversal — close any non-AUTO position when the daily
  // bias flips against the trade. Universal across pattern templates.
  { name: "daily_bias_flip", build: dailyBiasFlipExit },
];

/** Per-template-family signal-flip builder. Each entry returns the
 *  EntryCondition[] for the opposite-direction signal flip. The wrapper
 *  function below adds the directional dispatch + null-skips. */
const SIGNAL_FLIP_BUILDERS: Record<
  string,
  (primaryTf: string, oppDir: "bullish" | "bearish") => EntryCondition[]
> = {
  momentum_solo: (tf, dir) => [
    { type: "pattern", pattern: "momentum", direction: dir, lookback: 3, timeframe: tf },
  ],
  momentum_with_bias: (tf, dir) => [
    { type: "pattern", pattern: "momentum", direction: dir, lookback: 3, timeframe: tf },
  ],
  ict_bos_orderblock: (tf, dir) => [
    { type: "pattern", pattern: "bos", direction: dir, lookback: 5, timeframe: tf },
  ],
  ict_sweep_fvg_combo: (tf, dir) => [
    {
      type: "pattern",
      pattern: "liquidity_sweep",
      direction: dir,
      lookback: 5,
      timeframe: tf,
    },
  ],
  gold_killzone_sweep: (tf, dir) => [
    {
      type: "pattern",
      pattern: "liquidity_sweep",
      direction: dir,
      lookback: 5,
      timeframe: tf,
    },
  ],
  gold_silver_bullet: (tf, dir) => [
    {
      type: "pattern",
      pattern: "liquidity_sweep",
      direction: dir,
      lookback: 5,
      timeframe: tf,
    },
  ],
  gold_asian_breakout: (tf, dir) => [
    { type: "pattern", pattern: "momentum", direction: dir, lookback: 3, timeframe: tf },
  ],
  gold_h4_trend_pullback: (tf, dir) => [
    { type: "pattern", pattern: "pin_bar", direction: dir, timeframe: tf },
  ],
};

/** Prefix-based fallback for templates with parameter variants (e.g.,
 *  `multi_tf_engulf_bos__1h_normal_3R__conv` should still match the
 *  `multi_tf_engulf_bos` family). Order matters — first match wins. */
const SIGNAL_FLIP_PREFIX_BUILDERS: Array<{
  prefix: string;
  build: (primaryTf: string, oppDir: "bullish" | "bearish") => EntryCondition[];
}> = [
  {
    prefix: "multi_tf_engulf_bos",
    build: (_tf, dir) => [
      { type: "pattern", pattern: "engulfing", direction: dir, timeframe: "4h" },
    ],
  },
  {
    prefix: "multi_tf_pin_fvg",
    build: (_tf, dir) => [
      { type: "pattern", pattern: "pin_bar", direction: dir, timeframe: "4h" },
    ],
  },
  {
    prefix: "multi_tf_confluence_5",
    build: (_tf, dir) => [
      { type: "pattern", pattern: "engulfing", direction: dir, timeframe: "4h" },
      {
        type: "pattern",
        pattern: "daily_bias",
        direction: dir,
        ma_period: 20,
        timeframe: "1d",
      },
    ],
  },
];

function signalFlipExit(
  templateName: string,
  primaryTf: string,
  side: "long" | "short" | "auto"
): { exit_conditions: EntryCondition[]; exit_logic: AlgorithmRules["exit_logic"] } | null {
  if (side === "auto") return null;
  const oppDir: "bullish" | "bearish" = side === "long" ? "bearish" : "bullish";

  // RSI fade family — exit on extreme overshoot of the same RSI on the
  // entry's side. Long entries on RSI<30 exit when RSI>75 (price overdone
  // upward); short entries on RSI>70 exit when RSI>80 (price still climbing,
  // signal invalidated).
  if (templateName === "rsi_oversold_bounce" && side === "long") {
    return {
      exit_conditions: [
        {
          type: "technical",
          indicator: "RSI",
          operator: "greater_than",
          value: 75,
          timeframe: primaryTf,
        },
      ],
      exit_logic: "any",
    };
  }
  if (templateName === "rsi_overbought_fade" && side === "short") {
    return {
      exit_conditions: [
        {
          type: "technical",
          indicator: "RSI",
          operator: "greater_than",
          value: 80,
          timeframe: primaryTf,
        },
      ],
      exit_logic: "any",
    };
  }

  // Exact-name pattern-flip lookup
  const exact = SIGNAL_FLIP_BUILDERS[templateName];
  if (exact) {
    return { exit_conditions: exact(primaryTf, oppDir), exit_logic: "any" };
  }

  // Prefix-based fallback for parameter-variant template names
  for (const entry of SIGNAL_FLIP_PREFIX_BUILDERS) {
    if (templateName.startsWith(entry.prefix)) {
      return { exit_conditions: entry.build(primaryTf, oppDir), exit_logic: "any" };
    }
  }

  // Bare-indicator templates and unhandled families — skip rather than guess.
  return null;
}

function dailyBiasFlipExit(
  _templateName: string,
  _primaryTf: string,
  side: "long" | "short" | "auto"
): { exit_conditions: EntryCondition[]; exit_logic: AlgorithmRules["exit_logic"] } | null {
  if (side === "auto") return null;
  const oppDir: "bullish" | "bearish" = side === "long" ? "bearish" : "bullish";
  return {
    exit_conditions: [
      {
        type: "pattern",
        pattern: "daily_bias",
        direction: oppDir,
        ma_period: 20,
        timeframe: "1d",
      },
    ],
    exit_logic: "any",
  };
}
