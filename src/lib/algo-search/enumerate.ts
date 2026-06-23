/**
 * Algorithm-search Layer A candidate enumerator.
 *
 * Pure functions. No DB. No process side-effects. Given the universe
 * (4 instruments × 3 TFs × tradable patterns × directions), produces
 * Candidate[] ready for batch insert into the algorithms table.
 *
 * Used by:
 *   - scripts/canonical/algo-search.ts (Layer A driver)
 *   - src/lib/algo-search/state.ts (frontend /reports Search tab fetcher)
 *
 * Spec: scripts/canonical/algo-search.spec.md §2.
 * Pattern catalog: src/lib/patterns/ + src/types/algorithm.ts PatternCondition.
 *
 * Layer A uses SINGLE-pattern entries (one EntryCondition per candidate,
 * entry_logic="all"). Layer B (geometry sweep) layers daily_bias-
 * composite + geometry + filters per Layer A survivor — a separate
 * concern, not enumerated here.
 *
 * Naming convention for candidate algo rows mirrors the existing
 * Library:* prefix so /reports + cohort tooling continue working
 * uniformly. The prefix CANDIDATE_NAME_PREFIX is the namespace marker:
 *   "Search: <TICKER> <Pattern>-<Direction> <TF>"
 *   e.g. "Search: XAU/USD FVG-Long 4h" / "Search: EUR/USD BOS-Short 1h"
 */
import type { AlgorithmRules, EntryCondition, PatternCondition } from "@/types/algorithm";

/** Algo-name prefix for every search-generated candidate. Used by the
 *  driver to dedup on re-runs and by the frontend Search tab to filter
 *  candidates from non-search algos (Library:*, friend-clones, etc.). */
export const CANDIDATE_NAME_PREFIX = "Search:";

export type SearchDirection = "long" | "short";
export type SearchTimeframe = "30m" | "1h" | "4h";
export type SearchInstrument = "XAU/USD" | "EUR/USD" | "GBP/USD" | "USD/JPY";

/** SearchPattern is a CURATED subset of PatternCondition.pattern — only
 *  the tradable primitives. `daily_bias` is excluded (composer, used in
 *  Layer B). `gold_session_window` + `post_news_window` are excluded
 *  (filter-only, no standalone signal). */
export type SearchPattern =
  | "fvg"
  | "ifvg"
  | "bos"
  | "choch"
  | "ote"
  | "order_block"
  | "engulfing"
  | "pin_bar"
  | "momentum"
  | "mean_reversion"
  | "liquidity_sweep"
  | "liquidity_sweep_reclaim"
  | "equal_levels"
  | "asian_range_break";

export interface SearchPatternMeta {
  pattern: SearchPattern;
  /** Whether the pattern semantically supports SHORT entries. `ote` is
   *  long-only by ICT definition (pullback INTO a long bias); short
   *  variant would be `rip_seller`, a separate primitive not enumerated
   *  here. */
  supportsShort: boolean;
  /** Restricted-TF patterns (e.g. asian_range_break needs a session-
   *  aware cadence — only meaningful on 4h primary in our setup). */
  allowedTimeframes?: SearchTimeframe[];
  /** Extra fields the pattern needs in its condition spec (lookback,
   *  ma_period, etc.). Applied per-pattern in buildEntryCondition. */
  extraFields?: Partial<Pick<PatternCondition, "lookback" | "ma_period">>;
}

export const SEARCH_PATTERNS: SearchPatternMeta[] = [
  { pattern: "fvg", supportsShort: true },
  { pattern: "ifvg", supportsShort: true },
  { pattern: "bos", supportsShort: true },
  { pattern: "choch", supportsShort: true },
  { pattern: "ote", supportsShort: false },
  { pattern: "order_block", supportsShort: true },
  { pattern: "engulfing", supportsShort: true },
  { pattern: "pin_bar", supportsShort: true },
  { pattern: "momentum", supportsShort: true, extraFields: { lookback: 3 } },
  { pattern: "mean_reversion", supportsShort: true },
  { pattern: "liquidity_sweep", supportsShort: true },
  { pattern: "liquidity_sweep_reclaim", supportsShort: true },
  { pattern: "equal_levels", supportsShort: true },
  { pattern: "asian_range_break", supportsShort: true, allowedTimeframes: ["4h"] },
];

export interface SearchInstrumentMeta {
  ticker: SearchInstrument;
  asset_class: "commodity" | "forex";
  leverage: number;
  /** Per-instrument friction baked into rules.prop_firm. Gold from CLAUDE.md.
   *  Forex catalog defaults pending B.1.8.a sampling (≥50 samples/symbol). */
  friction: { slippage_bps: number; spread_bps: number };
  /** Capital tier for the search. Standardised at $10K so candidate
   *  total_return values are directly comparable across the fleet without
   *  scale normalization. Survivors get re-capitalised at deploy time. */
  capital: number;
}

export const SEARCH_INSTRUMENTS: SearchInstrumentMeta[] = [
  { ticker: "XAU/USD", asset_class: "commodity", leverage: 50, friction: { slippage_bps: 0.5, spread_bps: 0.4 }, capital: 10000 },
  { ticker: "EUR/USD", asset_class: "forex", leverage: 30, friction: { slippage_bps: 1.0, spread_bps: 1.0 }, capital: 10000 },
  { ticker: "GBP/USD", asset_class: "forex", leverage: 30, friction: { slippage_bps: 1.0, spread_bps: 1.5 }, capital: 10000 },
  { ticker: "USD/JPY", asset_class: "forex", leverage: 30, friction: { slippage_bps: 1.0, spread_bps: 1.2 }, capital: 10000 },
];

export const SEARCH_TIMEFRAMES: SearchTimeframe[] = ["30m", "1h", "4h"];

/** Default geometry — held identical across Layer A candidates so the
 *  comparison surfaces SIGNAL strength, not geometry tuning. Layer B
 *  sweeps the geometry axes after Layer A survivors are identified. */
const DEFAULT_GEOMETRY = {
  sl_lookback: 4,
  sl_atr_buffer: 0.1,
  rr_multiple: 3,
  risk_per_trade_pct: 1.0,
} as const;

/** Pattern direction discriminator (PatternCondition.direction is
 *  `"bullish"|"bearish"` — distinct from rules.side which is
 *  `"long"|"short"`). They covary but the model uses both. */
function dirOf(side: SearchDirection): "bullish" | "bearish" {
  return side === "long" ? "bullish" : "bearish";
}

function buildEntryCondition(
  meta: SearchPatternMeta,
  tf: SearchTimeframe,
  side: SearchDirection,
): EntryCondition {
  const cond: PatternCondition = {
    type: "pattern",
    pattern: meta.pattern,
    direction: dirOf(side),
    timeframe: tf,
    ...(meta.extraFields ?? {}),
  };
  return cond;
}

function patternDisplay(p: SearchPattern): string {
  // Preserve historical naming (e.g. "FVG", "OTE", "BOS") for capitals;
  // hyphenate underscored names for readability ("liquidity_sweep_reclaim"
  // → "Sweep-Reclaim"). Used in candidate algo `name`.
  switch (p) {
    case "fvg": return "FVG";
    case "ifvg": return "IFVG";
    case "bos": return "BOS";
    case "choch": return "CHOCH";
    case "ote": return "OTE";
    case "order_block": return "OrderBlock";
    case "engulfing": return "Engulfing";
    case "pin_bar": return "PinBar";
    case "momentum": return "Momentum";
    case "mean_reversion": return "MeanRev";
    case "liquidity_sweep": return "Sweep";
    case "liquidity_sweep_reclaim": return "Sweep-Reclaim";
    case "equal_levels": return "EqualLevels";
    case "asian_range_break": return "AsianRangeBreak";
  }
}

export interface SearchCandidate {
  /** Human-readable + DB-unique name. Becomes algorithms.name on insert. */
  name: string;
  /** Logical key for resumability + dedup. Stable across re-enumerations. */
  cell_key: string;
  ticker: SearchInstrument;
  timeframe: SearchTimeframe;
  pattern: SearchPattern;
  side: SearchDirection;
  capital: number;
  rules: AlgorithmRules;
}

function buildRules(
  inst: SearchInstrumentMeta,
  tf: SearchTimeframe,
  side: SearchDirection,
  patternMeta: SearchPatternMeta,
): AlgorithmRules {
  const entry = buildEntryCondition(patternMeta, tf, side);
  return {
    entry_conditions: [entry],
    entry_logic: "all",
    exit_conditions: [],
    stop_loss: {
      type: "swing_anchor",
      value: DEFAULT_GEOMETRY.sl_atr_buffer,
      lookback: DEFAULT_GEOMETRY.sl_lookback,
    },
    take_profit: {
      type: "rr_multiple",
      value: DEFAULT_GEOMETRY.rr_multiple,
    },
    position_sizing: {
      type: "risk_per_trade",
      value: DEFAULT_GEOMETRY.risk_per_trade_pct,
    },
    max_positions: 1,
    max_per_ticker: 1,
    leverage: inst.leverage,
    timeframe: tf,
    asset_class: inst.asset_class,
    side,
    prop_firm: {
      daily_loss_limit: 5,
      max_drawdown: 10,
      profit_target: 10,
      max_consecutive_losses: 0,
      consecutive_loss_daily_halt: 2,
      consistency_rule: 0,
      slippage_bps: inst.friction.slippage_bps,
      commission_pct: 0,
      spread_bps: inst.friction.spread_bps,
      commission_per_lot: 0,
      combined_risk_cap_pct: 4,
    },
    stagnant_exit: { enabled: true },
  };
}

/** Enumerate every Layer A cell from the search universe.
 *
 *  Math (audit before sweep start so the Bonferroni denominator is honest):
 *    - 12 long+short patterns × 4 inst × 3 TFs × 2 dirs = 288
 *    - ote (long-only) × 4 inst × 3 TFs × 1 dir = 12
 *    - asian_range_break (long+short, 4h-only) × 4 inst × 1 TF × 2 dirs = 8
 *    - Total = 308
 *
 *  The total is the Bonferroni denominator for the sweep. Verified by
 *  src/lib/algo-search/enumerate.test.ts.
 */
export function enumerateLayerACandidates(): SearchCandidate[] {
  const out: SearchCandidate[] = [];
  for (const inst of SEARCH_INSTRUMENTS) {
    for (const tf of SEARCH_TIMEFRAMES) {
      for (const patternMeta of SEARCH_PATTERNS) {
        const tfAllowed = patternMeta.allowedTimeframes ?? SEARCH_TIMEFRAMES;
        if (!tfAllowed.includes(tf)) continue;
        const sides: SearchDirection[] = patternMeta.supportsShort ? ["long", "short"] : ["long"];
        for (const side of sides) {
          const sideTag = side === "long" ? "Long" : "Short";
          const name = `${CANDIDATE_NAME_PREFIX} ${inst.ticker} ${patternDisplay(patternMeta.pattern)}-${sideTag} ${tf}`;
          const cell_key = `${inst.ticker}|${tf}|${patternMeta.pattern}|${side}`;
          out.push({
            name,
            cell_key,
            ticker: inst.ticker,
            timeframe: tf,
            pattern: patternMeta.pattern,
            side,
            capital: inst.capital,
            rules: buildRules(inst, tf, side, patternMeta),
          });
        }
      }
    }
  }
  return out;
}

/** The Bonferroni denominator (= |Layer A enumeration|). Computed once
 *  at sweep start, used by validate-algo via `BONFERRONI_STATISTICAL_TESTS_PER_ALGO=1`
 *  default + nCandidates auto-derived from ALGOS_CSV cardinality. */
export function layerACardinality(): number {
  return enumerateLayerACandidates().length;
}
