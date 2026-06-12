/**
 * Structural SL/TP placement — anchors stops to recent price structure
 * (swing low/high) instead of fixed-% or ATR-multiple distance.
 *
 * Two new rule types:
 *   - `swing_anchor` SL: SL = swing-low (long) or swing-high (short)
 *     within `lookback` bars before entry, plus an optional ATR buffer
 *     to push it just beyond the structural level. The `value` field
 *     is the buffer multiplier (fraction of ATR added beyond the swing).
 *   - `rr_multiple` TP: TP distance = `value` × SL distance. The
 *     standard pro setup once the SL is structurally placed: position
 *     sizing's `risk_per_trade` already adapts lot count so dollar-
 *     risk stays constant per trade regardless of SL distance.
 *
 * Engine pattern: compute distances ONCE at entry-bar, store on the
 * position (slDistance / tpDistance fields). All subsequent calls
 * (trailing init, stagnant gate, exit-price detection) use the stored
 * values. Mirrors how a live order's SL/TP prices are set at order
 * placement and never re-derived.
 */
import { priceDeltaForRule } from "@/lib/constants/markets";
import { computeAtr } from "@/lib/market-data/regime-filter";
import type { PriceBar } from "@/lib/market-data/types";
import type { AlgorithmRules } from "@/types/algorithm";

const DEFAULT_SWING_LOOKBACK = 8;
const DEFAULT_BUFFER_ATR_PERIOD = 14;

/** Compute SL distance for any rule type. For "swing_anchor" the
 *  distance is anchored to the swing low/high in `lookback` bars
 *  preceding (and including) the entry bar; otherwise dispatches to
 *  priceDeltaForRule. */
export function computeSlDistance(
  rule: AlgorithmRules["stop_loss"],
  side: "long" | "short",
  entryPrice: number,
  symbol: string | undefined,
  bars: PriceBar[],
  entryIdx: number
): number {
  if (rule.type !== "swing_anchor") {
    return priceDeltaForRule(rule, entryPrice, symbol);
  }
  const lookback = rule.lookback ?? DEFAULT_SWING_LOOKBACK;
  const start = Math.max(0, entryIdx - lookback);
  let level: number;
  if (side === "long") {
    let lowest = Infinity;
    for (let j = start; j <= entryIdx; j++) lowest = Math.min(lowest, bars[j].low);
    level = lowest;
  } else {
    let highest = -Infinity;
    for (let j = start; j <= entryIdx; j++) highest = Math.max(highest, bars[j].high);
    level = highest;
  }
  const baseDistance = side === "long" ? entryPrice - level : level - entryPrice;
  // ATR buffer pushes SL just beyond the swing point. value=0.25 means
  // the SL sits 0.25×ATR beyond the structural level, escaping any
  // immediate sweep.
  const bufferMultiplier = rule.value;
  if (bufferMultiplier <= 0 || baseDistance <= 0) return Math.max(baseDistance, 0);
  const series = computeAtr(bars, rule.atr_period ?? DEFAULT_BUFFER_ATR_PERIOD);
  const atr = series[entryIdx] ?? 0;
  return baseDistance + bufferMultiplier * atr;
}

/** Adaptive context for TP computation. When provided, applies two
 *  layers of regime/volatility awareness on top of the rule's nominal
 *  TP:
 *
 *  1. Regime-aware base RR (rr_multiple rules only): RANGING regime
 *     drops to a smaller RR (default 1.5) since chop rarely produces
 *     full continuation moves; HH/LH (trending) keeps the rule's
 *     configured value.
 *
 *  2. ATR cap (all rule types): TP distance won't exceed
 *     atrCapMultiplier × dailyAtr. In low-vol conditions a mechanical
 *     1.5%-percentage or 3R-multiple TP can land outside the day's
 *     likely range entirely; the cap brings TP back into a reachable
 *     zone without sacrificing trending-day wide targets (those days
 *     have wide ATR too).
 *
 *  Floors at slDistance so RR can't drop below 1:1. */
export interface AdaptiveTpContext {
  regime?: "HH" | "LH" | "RANGING" | "n/a";
  /** Most recent daily ATR (absolute price units). 0 = no cap. */
  dailyAtr?: number;
  /** Cap multiplier on dailyAtr. Default 1.5 = ~1.5 daily ranges. */
  atrCapMultiplier?: number;
  /** RR override for RANGING regime. Default 1.5. */
  rangingRr?: number;
}

const DEFAULT_RANGING_RR = 1.5;
const DEFAULT_ATR_CAP_MULTIPLIER = 1.5;

/** Context for LEVEL-based TP rules (prior_day_extreme). The level is
 *  computed from the daily series at entry time — callers that can't
 *  supply it (or whose level sits at/behind entry) fall back to the
 *  rule's `value` as an rr_multiple. */
export interface LevelTpContext {
  side: "long" | "short";
  /** Entry bar timestamp ("YYYY-MM-DD HH:mm[:ss]" or ISO). */
  entryDate: string;
  /** Native daily bars up to entry (deeper history fine — the lookup
   *  takes the last day strictly before the entry's UTC day). */
  dailyBars: PriceBar[];
}

/** Previous UTC day's extreme — the liquidity pool a trade runs toward
 *  (low for shorts, high for longs). Null when unavailable. */
function priorDayLevel(ctx: LevelTpContext): number | null {
  const day = ctx.entryDate.slice(0, 10);
  for (let i = ctx.dailyBars.length - 1; i >= 0; i--) {
    const b = ctx.dailyBars[i];
    if (b.date.slice(0, 10) < day) {
      return ctx.side === "short" ? b.low : b.high;
    }
  }
  return null;
}

/** Compute TP distance for any rule type. For "rr_multiple" the
 *  distance is `value` × slDistance; for "prior_day_extreme" the
 *  distance runs to the previous UTC day's low/high (falling back to
 *  `value` as an RR multiple when no valid level exists beyond entry
 *  or levelCtx is missing); otherwise dispatches to priceDeltaForRule.
 *  Caller must compute slDistance first.
 *
 *  When `adaptiveCtx` is provided, regime + ATR awareness tightens the
 *  rr paths. Level-resolved distances take ONLY the RR≥1 floor — no
 *  ATR cap, no RANGING adjust — matching the structural-TP screen that
 *  validated them (capping a structural level would target a price
 *  that isn't there). Without `adaptiveCtx` the rr paths behave
 *  exactly as before — backwards compatible. */
export function computeTpDistance(
  rule: AlgorithmRules["take_profit"],
  slDistance: number,
  entryPrice: number,
  symbol: string | undefined,
  adaptiveCtx?: AdaptiveTpContext,
  levelCtx?: LevelTpContext
): number {
  if (rule.type === "prior_day_extreme" && levelCtx) {
    const level = priorDayLevel(levelCtx);
    if (level !== null) {
      const distance =
        levelCtx.side === "short" ? entryPrice - level : level - entryPrice;
      if (distance > 0) {
        // Floor only — mirror the screen exactly (no ATR cap on levels).
        return Math.max(distance, slDistance);
      }
    }
    // No valid level beyond entry → fall through to rr fallback below.
  }

  let tpDistance: number;
  if (rule.type === "rr_multiple" || rule.type === "prior_day_extreme") {
    const baseRr =
      adaptiveCtx?.regime === "RANGING"
        ? (adaptiveCtx.rangingRr ?? DEFAULT_RANGING_RR)
        : rule.value;
    tpDistance = baseRr * slDistance;
  } else {
    tpDistance = priceDeltaForRule(rule, entryPrice, symbol);
  }

  if (adaptiveCtx?.dailyAtr !== undefined && adaptiveCtx.dailyAtr > 0) {
    const cap =
      (adaptiveCtx.atrCapMultiplier ?? DEFAULT_ATR_CAP_MULTIPLIER) * adaptiveCtx.dailyAtr;
    tpDistance = Math.min(tpDistance, cap);
  }

  // Floor: TP can't be closer than SL (RR ≥ 1).
  tpDistance = Math.max(tpDistance, slDistance);

  return tpDistance;
}

/** Per-side TP rule resolution. Gold's fall-fast-reverse asymmetry
 *  (short-geometry screen 2026-06-12, n=134 recorded shorts: rr1.5
 *  +0.38R/58% WR vs the symmetric rr3's +0.26R/45%, while longs need
 *  the rr3 room) means shorts may carry their own TP rule. Falls back
 *  to the symmetric take_profit when no override is configured. EVERY
 *  entry path that computes a TP must resolve through this — live,
 *  portfolio backtest, harness — or validation silently diverges from
 *  live. */
export function takeProfitRuleForSide(
  rules: Pick<AlgorithmRules, "take_profit" | "take_profit_short">,
  side: "long" | "short"
): AlgorithmRules["take_profit"] {
  return side === "short" && rules.take_profit_short ? rules.take_profit_short : rules.take_profit;
}

/** Convenience: extract the most recent daily ATR from a D1 bar
 *  series. Returns 0 when insufficient history (caller should treat
 *  as "no cap"). */
export function dailyAtrFromBars(dailyBars: PriceBar[], period: number = 14): number {
  if (dailyBars.length < period + 1) return 0;
  const series = computeAtr(dailyBars, period);
  return series[series.length - 1] ?? 0;
}
