/**
 * H.4a — Pluggable training-label functions for the feature-importance
 * driver. H.3's empirical AUC of 0.5378 fell 0.012 short of the 0.55
 * floor; the bottleneck was identified as the LABEL definition (next-
 * bar-direction-sign), not the feature set. H.4a tests alternative
 * labels against the same 48-feature library to see if any of them
 * surface a discriminable target.
 *
 * Each label function returns `0 | 1 | null`:
 *   - `1` = "positive class" (per the label's semantic — see below)
 *   - `0` = "negative class"
 *   - `null` = "label undefined for this bar" (e.g. insufficient lookahead,
 *     ambiguous geometry, regime not matching). Caller MUST drop null rows
 *     from training (they're not a third class — they're missing labels).
 *
 * Label semantics (locked at H.4a v1):
 *   - `next_bar_sign` (H.3 baseline): 1 if next bar's close > current bar's close.
 *   - `next_n_bar_sign(N)`: 1 if close at bar idx+N > current bar's close. Tests
 *     whether a longer prediction horizon carries more signal than 1 bar.
 *   - `r_aware(rules)`: simulates a HYPOTHETICAL trade entered at this bar's
 *     close, with SL + TP derived from the algo's rules; 1 if TP would hit
 *     before SL within `max_bars` lookahead, 0 if SL hits first, null if
 *     neither hits inside the window. This is the "would the algo's
 *     geometry win on this bar?" label — most directly aligned with the
 *     trading objective.
 *   - `regime_conditioned(regimeFn)`: only labels bars in a SINGLE regime;
 *     all other bars return null. Default regime = "medium_vol" (the one
 *     with the strongest H.6 per-regime evidence). Tests whether label
 *     signal exists within a single regime that's diluted across regimes.
 *   - `r_aware_regime_conditioned(rules, regimeFn)`: composite — r-aware
 *     label within a single regime. Most theoretically motivated:
 *     concentrates both the geometry alignment AND the regime homogeneity.
 *
 * Pure functions; no I/O. Reuses the existing `classifyRegime` from
 * regime-classifier.ts so the regime axis stays consistent with H.6.
 */
import { classifyRegime, type Regime } from "@/lib/algorithm/regime-classifier";
import type { PriceBar } from "@/lib/market-data/types";
import type { AlgorithmRules } from "@/types/algorithm";

export type LabelValue = 0 | 1 | null;
export type LabelFn = (bars: PriceBar[], idx: number) => LabelValue;

/** Canonical names — used for env-var dispatch + result-file labelling. */
export const LABEL_FN_NAMES = [
  "next_bar_sign",
  "next_4_bar_sign",
  "next_24_bar_sign",
  "r_aware",
  "regime_conditioned",
  "r_aware_regime_conditioned",
] as const;
export type LabelFnName = (typeof LABEL_FN_NAMES)[number];

// ─── 1. Sign labels (H.3 baseline + 2 horizons) ────────────────────────

export function nextBarSignLabel(bars: PriceBar[], idx: number): LabelValue {
  if (idx >= bars.length - 1) return null;
  const cur = bars[idx].close;
  const next = bars[idx + 1].close;
  if (!Number.isFinite(cur) || !Number.isFinite(next) || cur <= 0) return null;
  return next > cur ? 1 : 0;
}

export function makeNextNBarSignLabel(n: number): LabelFn {
  if (n < 1 || !Number.isInteger(n)) {
    throw new Error(`nextNBarSignLabel requires positive integer n; got ${n}`);
  }
  return (bars: PriceBar[], idx: number): LabelValue => {
    if (idx >= bars.length - n) return null;
    const cur = bars[idx].close;
    const target = bars[idx + n].close;
    if (!Number.isFinite(cur) || !Number.isFinite(target) || cur <= 0) return null;
    return target > cur ? 1 : 0;
  };
}

// ─── 2. R-aware label (TP-before-SL given algo geometry) ───────────────

export interface RAwareGeometryConfig {
  /** Simplified geometry the label simulator uses. Maps to the algo's
   *  rules.take_profit.value + a fixed ATR multiple for SL distance.
   *  Caller passes `extractRAwareGeometryConfig(rules)` to derive these
   *  from AlgorithmRules. */
  rrMultiple: number;
  /** SL distance as ATR multiple (1.0 = 1 ATR). Default 1.5. */
  slAtrMultiple: number;
  /** ATR lookback for SL distance computation. Default 14. */
  atrPeriod: number;
  /** Max bars to look ahead before giving up + returning null. Default 50. */
  maxLookahead: number;
  /** "long" = bullish bias (long position simulated); "short" = bearish.
   *  For algos with `rules.side`, pass the side directly. */
  side: "long" | "short";
}

/** Derive an RAwareGeometryConfig from AlgorithmRules. Reads rr_multiple
 *  from take_profit (when type=rr_multiple) + side from rules.side. ATR
 *  multiple + period left at sensible defaults (no AlgorithmRules field
 *  maps to "SL distance as ATR multiple" directly — algo's actual SL is
 *  swing_anchor-based which is path-dependent and not analytically
 *  simulable per-bar without re-running the full backtest). */
export function extractRAwareGeometryConfig(rules: AlgorithmRules): RAwareGeometryConfig {
  const rr = rules.take_profit.type === "rr_multiple" ? rules.take_profit.value : 3;
  const side: "long" | "short" = rules.side === "short" ? "short" : "long";
  return { rrMultiple: rr, slAtrMultiple: 1.5, atrPeriod: 14, maxLookahead: 50, side };
}

/** Compute the ATR(period) at bar idx (true-range mean over the last
 *  `period` bars including idx). Returns null when there's insufficient
 *  lookback. */
function atrAt(bars: PriceBar[], idx: number, period: number): number | null {
  if (idx < period) return null;
  let trSum = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    const high = bars[i].high;
    const low = bars[i].low;
    const prevClose = i > 0 ? bars[i - 1].close : bars[i].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
    trSum += tr;
  }
  return trSum / period;
}

export function makeRAwareLabel(config: RAwareGeometryConfig): LabelFn {
  return (bars: PriceBar[], idx: number): LabelValue => {
    if (idx >= bars.length - 1) return null;
    const entryClose = bars[idx].close;
    if (!Number.isFinite(entryClose) || entryClose <= 0) return null;
    const atr = atrAt(bars, idx, config.atrPeriod);
    if (atr === null || atr <= 0) return null;
    const slDistance = atr * config.slAtrMultiple;
    const tpDistance = slDistance * config.rrMultiple;

    const slPrice = config.side === "long" ? entryClose - slDistance : entryClose + slDistance;
    const tpPrice = config.side === "long" ? entryClose + tpDistance : entryClose - tpDistance;

    const maxJ = Math.min(bars.length, idx + 1 + config.maxLookahead);
    for (let j = idx + 1; j < maxJ; j++) {
      const high = bars[j].high;
      const low = bars[j].low;
      if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

      // Conservative tie-break: if both touch in the SAME bar, SL hits
      // first (worst-case for the trade; matches live execution where
      // SL is checked before TP in the engine's per-bar simulator).
      const slHit = config.side === "long" ? low <= slPrice : high >= slPrice;
      const tpHit = config.side === "long" ? high >= tpPrice : low <= tpPrice;
      if (slHit && tpHit) return 0; // ambiguous → conservative loss
      if (slHit) return 0;
      if (tpHit) return 1;
    }
    return null; // neither hit inside the window → undefined label
  };
}

// ─── 3. Regime-conditioned (delegates to inner label inside one regime) ───

/** Wraps an inner label fn so it ONLY emits non-null labels when the
 *  current bar's regime equals `targetRegime`. Other bars get null
 *  (dropped from training). Reuses H.6's `classifyRegime`. */
export function makeRegimeConditionedLabel(
  innerLabel: LabelFn,
  targetRegime: Regime,
): LabelFn {
  return (bars: PriceBar[], idx: number): LabelValue => {
    const r = classifyRegime(bars, idx);
    if (r === null || r !== targetRegime) return null;
    return innerLabel(bars, idx);
  };
}

// ─── 4. Dispatcher (env-var → LabelFn) ──────────────────────────────────

export interface ResolveLabelFnOptions {
  /** Algo rules — only needed for r_aware variants. Caller may pass null
   *  when picking a sign-only variant. */
  rules: AlgorithmRules | null;
  /** Default regime for regime-conditioned variants. Defaults to
   *  "medium_vol" per H.6 evidence (best per-regime Sharpe). */
  targetRegime?: Regime;
}

export function resolveLabelFn(
  name: LabelFnName,
  opts: ResolveLabelFnOptions,
): LabelFn {
  const targetRegime: Regime = opts.targetRegime ?? "medium_vol";
  switch (name) {
    case "next_bar_sign":
      return nextBarSignLabel;
    case "next_4_bar_sign":
      return makeNextNBarSignLabel(4);
    case "next_24_bar_sign":
      return makeNextNBarSignLabel(24);
    case "r_aware":
      if (!opts.rules) throw new Error("r_aware label requires AlgorithmRules");
      return makeRAwareLabel(extractRAwareGeometryConfig(opts.rules));
    case "regime_conditioned":
      return makeRegimeConditionedLabel(nextBarSignLabel, targetRegime);
    case "r_aware_regime_conditioned": {
      if (!opts.rules) throw new Error("r_aware_regime_conditioned label requires AlgorithmRules");
      const r = makeRAwareLabel(extractRAwareGeometryConfig(opts.rules));
      return makeRegimeConditionedLabel(r, targetRegime);
    }
  }
}

/** Type guard for env-var dispatch — validates the user-supplied name
 *  matches the canonical list before passing to resolveLabelFn. */
export function isLabelFnName(name: string): name is LabelFnName {
  return (LABEL_FN_NAMES as readonly string[]).includes(name);
}
