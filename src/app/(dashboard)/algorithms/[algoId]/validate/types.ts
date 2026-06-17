/**
 * Types + constants for the geometry sweep. Separate file because
 * `actions.ts` is `"use server"` and Next.js 16 forbids non-async
 * exports there.
 */

/** Geometry grid — expanded from the 3×3 in scripts/sweep-algo-geometry.ts.
 *  6×6 = 36 cells. Cells that breach prop_firm DD exit fast, so the
 *  total runtime grows sub-linearly. */
export const RR_GRID = [1.5, 2, 2.5, 3, 4, 5] as const;
export const LOOKBACK_GRID = [3, 4, 5, 6, 8, 12] as const;

/** Minimum win rate (%) for a cell to be eligible as the winner.
 *  Below this is too noisy to trust as the best config. */
export const WINNER_MIN_WR = 40;

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
