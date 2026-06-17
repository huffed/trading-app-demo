/**
 * Types + constants for the geometry sweep. Separate file because
 * `actions.ts` is `"use server"` and Next.js 16 forbids non-async
 * exports there.
 */

/** Geometry grid — same as scripts/sweep-algo-geometry.ts. */
export const RR_GRID = [2, 3, 5] as const;
export const LOOKBACK_GRID = [3, 4, 6] as const;

export interface GeometryCell {
  rr: number;
  lookback: number;
  total_return: number;
  max_drawdown: number;
  total_trades: number;
  win_rate: number;
  /** True when the run terminated early due to a prop_firm DD breach. */
  dd_breached: boolean;
  per_year: Record<string, { trades: number; pnl: number; win_pct: number }>;
}

export interface GeometrySweep {
  cells: GeometryCell[];
  grid: { rr: number[]; lookback: number[] };
  ran_at: string;
}
