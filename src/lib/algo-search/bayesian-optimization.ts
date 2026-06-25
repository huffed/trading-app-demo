/**
 * H.9 Bayesian Optimization library — TS-side glue for the Python
 * scikit-optimize sidecar. Pure functions + types; the driver
 * (`scripts/canonical/bo-search.ts`) handles the eval loop + I/O.
 *
 * Why BO over Layer B grid (operator-stamped 2026-06-25): two consecutive
 * F+F2 failures on grid-search winners (v3 Engulfing + ARB top) both
 * failed F2.3 0/10 + PBO 0.93. Diagnosis: 96-variant grid on retail
 * data volume produces flat Sharpe distributions; the "winner" is
 * selected by tiny noise differences that don't survive bar resampling.
 * BO finds peaks via continuous parameter resolution + adaptive sampling
 * → 5-10 candidates with discriminating Sharpe gaps → F2.3 + PBO pass
 * naturally at strict thresholds.
 *
 * Search space mirrors layer-b-enumerate.ts axes but continuous-relaxed:
 *   rr_multiple ∈ [1.5, 5.0]          (was {2, 2.5, 3, 5})
 *   sl_lookback ∈ Integer[3, 12]      (was {3, 4, 6})
 *   risk_per_trade_pct ∈ [0.3, 1.2]   (was {0.6, 1.0})
 *   regime_filter ∈ Integer{0, 1}     (binary)
 *   adx_filter ∈ Integer{0, 1}        (binary)
 */
import type { AlgorithmRules } from "@/types/algorithm";

/** Layer B axis spec passed to Python sidecar. Mirrors skopt dimension types. */
export interface BoDimensionSpec {
  type: "Real" | "Integer";
  low: number;
  high: number;
  name: string;
}

/** Canonical 5-axis Layer B search space. Operator override via env not
 *  exposed yet — locked to these bounds for the first H.9 run. */
export const LAYER_B_BO_DIMENSIONS: readonly BoDimensionSpec[] = [
  { type: "Real", low: 1.5, high: 5.0, name: "rr_multiple" },
  { type: "Integer", low: 3, high: 12, name: "sl_lookback" },
  { type: "Real", low: 0.3, high: 1.2, name: "risk_per_trade_pct" },
  { type: "Integer", low: 0, high: 1, name: "regime_filter" },
  { type: "Integer", low: 0, high: 1, name: "adx_filter" },
] as const;

export interface BoEvalEntry {
  params: number[]; // ordered to match dimensions
  /** Objective value — what BO minimizes. Caller passes -Sharpe when maximizing. */
  objective: number;
  /** Optional: original Sharpe (un-negated) for reporting. */
  sharpe?: number;
  /** Optional: human-readable variant tag for log lines. */
  variant_tag?: string;
}

export interface BoSidecarRequest {
  dimensions: readonly BoDimensionSpec[];
  eval_history: BoEvalEntry[];
  n_initial_points: number;
  acq_func: "EI" | "PI" | "LCB" | "gp_hedge";
  random_seed: number;
}

export interface BoSidecarResponse {
  next_params: number[];
  iteration: number;
  evals_so_far: number;
  is_initial_random_phase: boolean;
}

/** Decode a params vector into a {axis_name: value} record. Length must
 *  match dimensions.length; throws on mismatch (catches sidecar/driver
 *  drift). */
export function decodeParams(
  params: number[],
  dimensions: readonly BoDimensionSpec[],
): Record<string, number> {
  if (params.length !== dimensions.length) {
    throw new Error(
      `decodeParams: got ${params.length} params but ${dimensions.length} dimensions`,
    );
  }
  const out: Record<string, number> = {};
  for (let i = 0; i < dimensions.length; i++) {
    out[dimensions[i].name] = params[i];
  }
  return out;
}

/** Build a Layer B geometry tag from BO params (mirrors layer-b-enumerate's
 *  geometryTag() but for continuous rr/risk values). Fractional values get
 *  multiplied + truncated so the tag is filename-safe + sortable.
 *  e.g. rr=3.7, lb=5, risk=0.85, rf=1, af=0 → "bo_rr37_lb5_r085_rf1_af0" */
export function boVariantTag(params: number[]): string {
  const decoded = decodeParams(params, LAYER_B_BO_DIMENSIONS);
  const rr = Math.round(decoded.rr_multiple * 10);
  const lb = Math.round(decoded.sl_lookback);
  const risk = Math.round(decoded.risk_per_trade_pct * 100);
  const rf = decoded.regime_filter > 0.5 ? 1 : 0;
  const af = decoded.adx_filter > 0.5 ? 1 : 0;
  return `bo_rr${rr}_lb${lb}_r${risk}_rf${rf}_af${af}`;
}

/** Apply BO params to a base AlgorithmRules. Mirrors applyGeometry() in
 *  layer-b-enumerate.ts but accepts continuous values. Preserves all
 *  non-geometry fields from base. */
export function applyBoParams(
  baseRules: AlgorithmRules,
  params: number[],
): AlgorithmRules {
  const decoded = decodeParams(params, LAYER_B_BO_DIMENSIONS);
  return {
    ...baseRules,
    stop_loss: {
      ...baseRules.stop_loss,
      lookback: Math.round(decoded.sl_lookback),
    },
    take_profit: {
      ...baseRules.take_profit,
      value: decoded.rr_multiple,
    },
    position_sizing: {
      ...baseRules.position_sizing,
      value: decoded.risk_per_trade_pct,
    },
    regime_filter:
      decoded.regime_filter > 0.5
        ? { enabled: true, atr_period: 20, lookback_days: 90, percentile_floor: 0.3 }
        : undefined,
    adx_filter:
      decoded.adx_filter > 0.5
        ? { enabled: true, adx_period: 14, min_adx: 20 }
        : undefined,
  };
}

/** Compute Sharpe from per-trade R-multiples. Returns 0 for n<2.
 *  Mirrors the same math used in F2 drivers + augmentation validator. */
export function computeSharpe(perTradeR: readonly number[]): number {
  if (perTradeR.length < 2) return 0;
  const mean = perTradeR.reduce((a, b) => a + b, 0) / perTradeR.length;
  let var_ = 0;
  for (const x of perTradeR) var_ += (x - mean) ** 2;
  const std = Math.sqrt(var_ / perTradeR.length);
  return std === 0 ? 0 : mean / std;
}

/** Best entry from eval history by lowest objective (most negative when
 *  caller minimizes -Sharpe). Returns null on empty history. */
export function bestEntry(history: readonly BoEvalEntry[]): BoEvalEntry | null {
  if (history.length === 0) return null;
  let best = history[0];
  for (const e of history.slice(1)) {
    if (e.objective < best.objective) best = e;
  }
  return best;
}

/** Sort history ascending by objective (best first). */
export function sortedByObjective(history: readonly BoEvalEntry[]): BoEvalEntry[] {
  return [...history].sort((a, b) => a.objective - b.objective);
}
