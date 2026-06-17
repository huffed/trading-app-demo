/**
 * Types + constants for the geometry sweep. Separate file because
 * `actions.ts` is `"use server"` and Next.js 16 forbids non-async
 * exports there.
 */

/** Geometry grid — expanded from the 3×3 in scripts/sweep-algo-geometry.ts
 *  to give the operator more visibility into the geometry surface
 *  without ballooning runtime (cells that breach DD early exit fast). */
export const RR_GRID = [1.5, 2, 3, 4, 5] as const;
export const LOOKBACK_GRID = [3, 4, 6, 8, 12] as const;

export interface GeometryCell {
  rr: number;
  lookback: number;
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
  grid: { rr: number[]; lookback: number[] };
  ran_at: string;
}
