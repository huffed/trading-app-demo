/**
 * Types + constants for the geometry sweep. Separate file because
 * `actions.ts` is `"use server"` and Next.js 16 forbids non-async
 * exports there.
 */

/** All variables the sweep can vary. The operator picks any TWO as the
 *  heatmap axes per run; the other seven stay at the algo's deployed
 *  value. Each axis has a fixed value range + a label + a category
 *  (numeric vs boolean) so the UI can render gate-toggle axes as
 *  on/off cells without special-casing. */
export type AxisKey =
  | "rr"
  | "lookback"
  | "sl_pct"
  | "risk_per_trade"
  | "sl_buffer"
  | "stagnant_max_bars"
  | "stagnant_min_excursion_r"
  | "regime_filter"
  | "adx_filter"
  | "dxy_filter";

export interface AxisDef {
  key: AxisKey;
  label: string;
  /** Numeric / boolean. Booleans render as "on" / "off" cells. */
  kind: "numeric" | "boolean";
  values: readonly (number | boolean)[];
  /** Optional unit suffix for cell labels (e.g. "%"). */
  unit?: string;
}

export const AXES: Record<AxisKey, AxisDef> = {
  rr: { key: "rr", label: "RR", kind: "numeric", values: [1.5, 2, 2.5, 3, 4, 5] },
  lookback: { key: "lookback", label: "Lookback", kind: "numeric", values: [3, 4, 5, 6, 8, 12] },
  sl_pct: {
    key: "sl_pct",
    label: "SL %",
    kind: "numeric",
    unit: "%",
    values: [0.15, 0.2, 0.3, 0.4, 0.5, 0.75],
  },
  risk_per_trade: {
    key: "risk_per_trade",
    label: "Risk/trade",
    kind: "numeric",
    unit: "%",
    values: [0.3, 0.5, 0.6, 0.75, 1.0],
  },
  sl_buffer: {
    key: "sl_buffer",
    label: "SL buffer",
    kind: "numeric",
    values: [0.0, 0.1, 0.25, 0.5, 1.0],
  },
  stagnant_max_bars: {
    key: "stagnant_max_bars",
    label: "Stagnant bars",
    kind: "numeric",
    values: [12, 24, 36, 48],
  },
  stagnant_min_excursion_r: {
    key: "stagnant_min_excursion_r",
    label: "Stagnant min-R",
    kind: "numeric",
    values: [0.3, 0.5, 0.75, 1.0],
  },
  regime_filter: {
    key: "regime_filter",
    label: "Regime filter",
    kind: "boolean",
    values: [false, true],
  },
  adx_filter: { key: "adx_filter", label: "ADX filter", kind: "boolean", values: [false, true] },
  dxy_filter: { key: "dxy_filter", label: "DXY filter", kind: "boolean", values: [false, true] },
};

export const DEFAULT_X_AXIS: AxisKey = "lookback";
export const DEFAULT_Y_AXIS: AxisKey = "rr";

/** Minimum win rate (%) for a cell to be eligible as the winner.
 *  Below this is too noisy to trust as the best config. */
export const WINNER_MIN_WR = 37;

export interface GeometryCell {
  /** The two axis values for this cell. Stored as a record keyed by
   *  axis key so the UI can read either dimension generically. */
  x: number | boolean;
  y: number | boolean;
  total_return: number;
  max_drawdown: number;
  total_trades: number;
  win_rate: number;
  /** Average P&L per trade ($). */
  avg_pnl: number;
  /** Calmar-like ratio = total_return / max_drawdown%. Higher is better.
   *  null when max_drawdown is 0 (no DD recorded). */
  calmar: number | null;
  /** True when the run terminated early due to a prop_firm DD breach. */
  dd_breached: boolean;
  per_year: Record<string, { trades: number; pnl: number; win_pct: number }>;
}

export interface GeometrySweep {
  cells: GeometryCell[];
  x_axis: AxisKey;
  y_axis: AxisKey;
  x_values: (number | boolean)[];
  y_values: (number | boolean)[];
  /** Snapshot of the FIXED dims (the 7 not on either axis) — what
   *  values they were held at for this run. Lets the operator see
   *  "this sweep was for risk=0.6%, regime_off, ..." */
  fixed: Partial<Record<AxisKey, number | boolean>>;
  ran_at: string;
}
