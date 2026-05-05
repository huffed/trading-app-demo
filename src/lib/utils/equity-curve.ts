/**
 * Cumulative-pnl curve helper, used wherever the app shows a P&L-over-time
 * chart from closed positions or trades. Centralised so the dashboard,
 * the per-algorithm card, and the analytics page all feed the same
 * reducer — historically each had its own inline implementation.
 */
import { formatShortDate } from "./date";

export interface EquityPoint {
  date: string;
  value: number;
}

export interface EquityCurveRecord {
  realized_pnl: number;
  /** ISO timestamp at which the trade closed. `closed_at` for paper
   *  positions; trade-shaped callers should map their `exit_date` here. */
  closed_at: string;
}

/**
 * Cumulative pnl curve, anchored at 0 — shows pnl-since-start of the
 * input series, not absolute equity. Sorted internally by `closed_at`
 * so callers don't have to pre-sort. Records missing `realized_pnl` or
 * `closed_at` are silently dropped.
 */
export function computeEquityCurve(records: readonly EquityCurveRecord[]): EquityPoint[] {
  const valid = records.filter((r) => r.realized_pnl != null && r.closed_at);
  const sorted = [...valid].sort(
    (a, b) => new Date(a.closed_at).getTime() - new Date(b.closed_at).getTime()
  );
  let cumulative = 0;
  return sorted.map((r) => {
    cumulative += r.realized_pnl;
    return {
      date: formatShortDate(r.closed_at),
      value: Number(cumulative.toFixed(2)),
    };
  });
}
