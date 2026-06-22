/**
 * Strategy template catalog + parameter grid for the combinatorial
 * search. Extracted from `grid.ts` on 2026-06-22 (CB.H1 pass 18). The
 * orchestrator (enumerateCandidates) imports TEMPLATES + PARAMETER_GRID
 * from here and combines them with EXIT_VARIANTS to produce the
 * cartesian product fed into walk-forward.
 *
 * Adding a new template:
 *   1. Add an entry to `TEMPLATES` with name, default_side, build, and
 *      allowed_timeframes (optional whitelist).
 *   2. If the template has tunable thresholds, populate param_variants.
 *   3. The orchestrator handles the rest — no changes needed in grid.ts.
 */
import type { EntryCondition, EntryLogic } from "@/types/algorithm";
// CB.H1 pass 19 (2026-06-22): gold + indicator template arrays + helper
// builders extracted to sibling files so this file stays focused on the
// pattern/multi-TF templates + parameter-grid + interfaces.
import {
  buildIctBosOrderBlock,
  buildIctSweepFvg,
  buildMultiTfConfluence5,
  buildMultiTfEngulfBos,
  buildMultiTfPinFvg,
} from "./grid-template-builders";
import {
  GOLD_TEMPLATES,
  INDICATOR_TEMPLATES,
} from "./grid-templates-gold-indicators";

/**
 * Parameter-sweep variant of a base template. Each variant produces a
 * separate candidate per (param-combo × exit-variant) so the 4D search
 * tests RSI thresholds, momentum lookbacks, MA periods, etc.
 *
 * The default (un-swept) variant is implicit: the template's `build`
 * is always emitted as candidate name `${tmpl.name}__${combo}__${exit}`.
 * Explicit `param_variants` add `${tmpl.name}__${variantName}__${combo}__${exit}`
 * candidates on top.
 */
export interface ParamVariant {
  /** Variant suffix in candidate labels (e.g. "rsi65", "lb5", "ma50").
   *  Distinguishes from the un-suffixed default variant. */
  name: string;
  /** Replaces the template's default `build` for this variant. Same
   *  shape: takes primary timeframe → entry conditions + logic. */
  build: (tf: string) => { entry: EntryCondition[]; logic: EntryLogic } | null;
}

export interface Template {
  name: string;
  /** Entry conditions, parametrised by primary timeframe. The factory
   *  receives the primary tf string and returns the condition list +
   *  entry logic so patterns / indicators that don't fit certain
   *  timeframes can be filtered out per-template. */
  build: (tf: string) => { entry: EntryCondition[]; logic: EntryLogic } | null;
  /** Default trade direction. "auto" means D1 bias decides per-bar. */
  default_side: "long" | "short" | "auto";
  /** Timeframes the template is allowed to run on. Patterns that
   *  reference D1-bias don't make sense on a 4h primary that already
   *  resamples → empty list = "any timeframe". */
  allowed_timeframes?: string[];
  /** When true, the grid emits an additional candidate per parameter
   *  combo with `conviction_scaled + tf_agreement` sizing. Only useful
   *  for templates with conditions spanning ≥2 timeframes — single-TF
   *  templates have no agreement signal to scale on. */
  include_tf_conviction_variant?: boolean;
  /** Optional parameter sweeps. Each variant adds a separate candidate
   *  per (combo × exit). Used for tunable thresholds (RSI 65/70/75,
   *  momentum lookback 2/3/5/8, MA period 20/50, etc.). The default
   *  build is always emitted; these are additive. */
  param_variants?: ParamVariant[];
}

// Template order matters: candidates are enumerated in this order and
// the search runner caps to `max_candidates`. The data-validated
// (replay-confirmed) templates go first — momentum first because it
// cleared 44.7% hit / 76.5% WR against the friend's actual FTMO
// trades, then multi_tf, then ICT, then bare indicators.
const PATTERN_TEMPLATES: Template[] = [
  // Momentum continuation templates — derived from the direction-split
  // feature dump of friend-trade history. Solo 1h momentum cleared
  // 44.7% hit rate / 76.5% WR against the friend's
  // FTMO trades — the first template to clear the 30% clone-claim
  // threshold AND beat his 58% baseline. The d1_bias + momentum 2-of-2
  // variant is also enumerated so walk-forward decides whether the
  // bias filter helps or hurts on out-of-sample data.
  //
  // Both directions: feature dump showed momentum continuation works
  // for longs AND shorts (long wins +0.18 ATR median, short wins
  // -0.72 ATR median). Default side stays long here — search engine
  // can produce a short variant separately, and `auto` routing depends
  // on D1 bias which the solo template intentionally omits.
  {
    name: "momentum_solo",
    default_side: "long",
    build: (tf) => ({
      entry: [
        { type: "pattern", pattern: "momentum", direction: "bullish", lookback: 3, timeframe: tf },
      ],
      logic: "all",
    }),
    allowed_timeframes: ["1h", "4h"],
    // Sweep momentum lookback. Default (lookback=3) goes through the
    // normal path; these variants test alternative bar-count windows
    // for the same in-direction-net-move signal.
    param_variants: [
      {
        name: "lb2",
        build: (tf) => ({
          entry: [
            { type: "pattern", pattern: "momentum", direction: "bullish", lookback: 2, timeframe: tf },
          ],
          logic: "all",
        }),
      },
      {
        name: "lb5",
        build: (tf) => ({
          entry: [
            { type: "pattern", pattern: "momentum", direction: "bullish", lookback: 5, timeframe: tf },
          ],
          logic: "all",
        }),
      },
      {
        name: "lb8",
        build: (tf) => ({
          entry: [
            { type: "pattern", pattern: "momentum", direction: "bullish", lookback: 8, timeframe: tf },
          ],
          logic: "all",
        }),
      },
    ],
  },
  {
    name: "momentum_with_bias",
    default_side: "long",
    build: (tf) => ({
      entry: [
        { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "1d" },
        { type: "pattern", pattern: "momentum", direction: "bullish", lookback: 3, timeframe: tf },
      ],
      // 2-of-2 — both must fire. Stricter filter; lower hit rate
      // against the friend's data but cleaner trend alignment.
      logic: { type: "n_of_m", n: 2 },
    }),
    allowed_timeframes: ["1h"],
  },
  // Multi-TF confluence templates — derived from a friend-trade
  // multi-TF replay analysis. His trades showed 61.5% WR when ≥2 TFs
  // agreed, vs 33% on single-TF signals.
  // Each template requires an explicit cross-TF mix: daily_bias on 1d
  // anchors the bias, then 4h + 1h candle / structure patterns
  // confirm. n_of_m=2 across the {4h, 1h} confirmations replicates
  // the "2-TF agreement" sweet spot.
  {
    name: "multi_tf_engulf_bos",
    default_side: "long",
    build: (tf) => buildMultiTfEngulfBos(tf),
    allowed_timeframes: ["1h"],
    include_tf_conviction_variant: true,
  },
  {
    name: "multi_tf_pin_fvg",
    default_side: "long",
    build: (tf) => buildMultiTfPinFvg(tf),
    allowed_timeframes: ["1h"],
    include_tf_conviction_variant: true,
  },
  {
    name: "multi_tf_confluence_5",
    default_side: "long",
    build: (tf) => buildMultiTfConfluence5(tf),
    allowed_timeframes: ["1h"],
    include_tf_conviction_variant: true,
  },
  // ICT/SMC templates — older single-TF pattern combos. Kept in the
  // grid because they sometimes still win walk-forward on specific
  // SL/TP combos, but ranked below the data-validated templates above.
  {
    name: "ict_sweep_fvg_combo",
    default_side: "long",
    build: (tf) => buildIctSweepFvg(tf),
    allowed_timeframes: ["1h"],
  },
  {
    name: "ict_bos_orderblock",
    default_side: "long",
    build: (tf) => buildIctBosOrderBlock(tf),
    allowed_timeframes: ["1h"],
  },
];

// Aggregate the per-category arrays into the canonical TEMPLATES catalog.
// Priority order matters: orchestrator enumerates in this order and caps
// to max_candidates. Pattern/multi-TF first → gold → bare indicator.
export const TEMPLATES: Template[] = [
  ...PATTERN_TEMPLATES,
  ...GOLD_TEMPLATES,
  ...INDICATOR_TEMPLATES,
];

export interface ParameterCombo {
  timeframe: string;
  sl_pct: number;
  tp_pct: number;
  /** Static label for the combo, used to build candidate names. */
  label: string;
}

// Exit variants live in `./exit-variants.ts` so the per-template flip
// rules are isolated from the entry-side template definitions, and so
// this file stays inside the per-function size budget. See
// `EXIT_VARIANTS` import above.

export const PARAMETER_GRID: ParameterCombo[] = [
  // 1h timeframe
  { timeframe: "1h", sl_pct: 0.8, tp_pct: 2.4, label: "1h_tight_3R" },
  { timeframe: "1h", sl_pct: 1.2, tp_pct: 3.6, label: "1h_normal_3R" },
  { timeframe: "1h", sl_pct: 1.5, tp_pct: 4.5, label: "1h_loose_3R" },
  // 4h timeframe — for trend-follow templates that benefit from larger bars
  { timeframe: "4h", sl_pct: 1.5, tp_pct: 4.5, label: "4h_normal_3R" },
  // 4h tighter combo — for gold_h4_trend_pullback (counter-evidence to
  // the 15m-only intuition; SL 0.8% targets the typical H4 pullback depth).
  { timeframe: "4h", sl_pct: 0.8, tp_pct: 2.0, label: "4h_tight_2R5" },
  // 15m combos for gold scalp templates. SL bounds match gold's typical
  // 15m ATR (~$5 / 0.2% on $2400) — 0.3% catches small ATR setups,
  // 0.5% gives the trade slightly more room. 3R retained.
  { timeframe: "15m", sl_pct: 0.3, tp_pct: 0.9, label: "15m_tight_3R" },
  { timeframe: "15m", sl_pct: 0.5, tp_pct: 1.5, label: "15m_normal_3R" },
  // 1d combo — the SMA200 trend filter template needs daily bars; SL
  // wide enough to absorb intraday noise inside the trend.
  { timeframe: "1d", sl_pct: 1.5, tp_pct: 4.5, label: "1d_normal_3R" },
];
