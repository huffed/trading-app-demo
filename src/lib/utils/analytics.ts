import type { PaperPosition } from "@/types/position";
import type { Trade } from "@/types/trade";
import { formatMonthYearShort, formatShortDate } from "./date";
import { computeEquityCurve as computeEquityCurveGeneric } from "./equity-curve";

export type { EquityPoint } from "./equity-curve";

// ---- Types ----

export interface AnalyticsMetrics {
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  bestTrade: number;
  worstTrade: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  avgDurationDays: number;
  totalPnl: number;
  winRate: number;
  totalTrades: number;
}

export interface DrawdownPoint {
  date: string;
  drawdown: number;
  /** "%" when starting capital is known and we can express drawdown
   *  relative to NAV; "$" when capital is unknown and we fall back to
   *  raw dollar drawdown. */
  unit: "%" | "$";
}

export interface DistributionBucket {
  range: string;
  count: number;
  midpoint: number;
}

export interface MonthlyReturn {
  month: string;
  pnl: number;
}

export interface SymbolPerformance {
  symbol: string;
  pnl: number;
  trades: number;
}

export interface DayPerformance {
  day: string;
  avgPnl: number;
  winRate: number;
  trades: number;
}

// ---- Helpers ----

type ClosedTrade = Trade & { realized_pnl: number; exit_date: string };

function getClosedTrades(trades: Trade[]): ClosedTrade[] {
  return trades
    .filter(
      (t): t is ClosedTrade =>
        t.status === "closed" && t.realized_pnl != null && t.exit_date != null
    )
    .sort((a, b) => new Date(a.exit_date).getTime() - new Date(b.exit_date).getTime());
}

function daysBetween(a: string, b: string): number {
  return Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
}

// ---- Computation functions ----

export function computeMetrics(
  trades: Trade[],
  /** Account starting capital, used as the denominator for
   *  `maxDrawdownPercent`. When null/undefined/≤0, the percent falls
   *  back to "% of running peak" (the prior behaviour) which is 0 for
   *  accounts that have been underwater from inception. Pass the user's
   *  `trading_profile.answers.capital` here. */
  startingCapital?: number | null
): AnalyticsMetrics {
  const closed = getClosedTrades(trades);
  if (closed.length === 0) {
    return {
      profitFactor: 0,
      avgWin: 0,
      avgLoss: 0,
      bestTrade: 0,
      worstTrade: 0,
      maxDrawdown: 0,
      maxDrawdownPercent: 0,
      avgDurationDays: 0,
      totalPnl: 0,
      winRate: 0,
      totalTrades: 0,
    };
  }

  const wins = closed.filter((t) => t.realized_pnl > 0);
  const losses = closed.filter((t) => t.realized_pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.realized_pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.realized_pnl, 0));

  // Max drawdown from equity curve. Peak starts at 0 (account NAV at
  // inception, expressed as cumulative P&L) and only updates on new
  // highs. For accounts underwater from inception, peak stays at 0 and
  // every drawdown reading is just (-equity) — meaningful only when we
  // can express it as % of starting capital, hence the fallback below.
  const useCapital = startingCapital != null && startingCapital > 0;
  let peak = 0;
  let maxDd = 0;
  let maxDdPct = 0;
  let equity = 0;
  for (const t of closed) {
    equity += t.realized_pnl;
    if (equity > peak) {
      peak = equity;
    }
    const dd = peak - equity;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdPct = useCapital
        ? (dd / (startingCapital as number)) * 100
        : peak > 0
          ? (dd / peak) * 100
          : 0;
    }
  }

  const durations = closed
    .filter((t) => t.entry_date)
    .map((t) => daysBetween(t.entry_date, t.exit_date));
  const avgDuration =
    durations.length > 0 ? durations.reduce((s, d) => s + d, 0) / durations.length : 0;

  let profitFactor = 0;
  if (grossLoss > 0) {
    profitFactor = grossProfit / grossLoss;
  } else if (grossProfit > 0) {
    profitFactor = Infinity;
  }

  return {
    profitFactor,
    avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLoss: losses.length > 0 ? -(grossLoss / losses.length) : 0,
    bestTrade: closed.length > 0 ? Math.max(...closed.map((t) => t.realized_pnl)) : 0,
    worstTrade: closed.length > 0 ? Math.min(...closed.map((t) => t.realized_pnl)) : 0,
    maxDrawdown: maxDd,
    maxDrawdownPercent: maxDdPct,
    avgDurationDays: Math.round(avgDuration * 10) / 10,
    totalPnl: equity,
    winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
    totalTrades: closed.length,
  };
}

export function computeEquityCurve(trades: Trade[]) {
  return computeEquityCurveGeneric(
    getClosedTrades(trades).map((t) => ({
      realized_pnl: t.realized_pnl,
      closed_at: t.exit_date ?? "",
    }))
  );
}

export function computeDrawdownSeries(
  trades: Trade[],
  /** Same semantics as `computeMetrics(...)`. When provided + positive,
   *  the series is in percent of starting capital. Otherwise it falls
   *  back to dollar drawdown so the chart still renders something
   *  useful (every point will be ≤ 0). */
  startingCapital?: number | null
): DrawdownPoint[] {
  const closed = getClosedTrades(trades);
  const useCapital = startingCapital != null && startingCapital > 0;
  let peak = 0;
  let equity = 0;
  return closed.map((t) => {
    equity += t.realized_pnl;
    if (equity > peak) {
      peak = equity;
    }
    // dd is ≤ 0 (current equity below or at peak). Express either as %
    // of starting capital (preferred — matches industry convention and
    // works while underwater from inception) or as raw dollars.
    const ddDollars = equity - peak;
    const value = useCapital ? (ddDollars / (startingCapital as number)) * 100 : ddDollars;
    return {
      date: formatShortDate(t.exit_date),
      drawdown: Number(value.toFixed(2)),
      unit: useCapital ? "%" : "$",
    };
  });
}

export function computeDistribution(trades: Trade[], bucketSize = 100): DistributionBucket[] {
  const closed = getClosedTrades(trades);
  if (closed.length === 0) {
    return [];
  }

  const pnls = closed.map((t) => t.realized_pnl);
  const min = Math.min(...pnls);
  const max = Math.max(...pnls);
  const range = max - min;

  // Auto-adjust bucket size for small ranges
  let size = bucketSize;
  if (range > 0 && range < size * 3) {
    size = Math.ceil(range / 6);
  }
  if (size <= 0) {
    size = 1;
  }

  const bucketStart = Math.floor(min / size) * size;
  const bucketEnd = Math.ceil(max / size) * size;
  const buckets: DistributionBucket[] = [];

  for (let start = bucketStart; start < bucketEnd; start += size) {
    const end = start + size;
    const count = pnls.filter((p) => p >= start && p < end).length;
    buckets.push({
      range: `${start >= 0 ? "+" : ""}$${start}`,
      count,
      midpoint: start + size / 2,
    });
  }
  return buckets;
}

export function computeMonthlyReturns(trades: Trade[]): MonthlyReturn[] {
  const closed = getClosedTrades(trades);
  const byMonth = new Map<string, number>();

  for (const t of closed) {
    const d = new Date(t.exit_date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    byMonth.set(key, (byMonth.get(key) ?? 0) + t.realized_pnl);
  }

  return Array.from(byMonth.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, pnl]) => {
      const [y, m] = key.split("-");
      const label = formatMonthYearShort(new Date(Number(y), Number(m) - 1));
      return { month: label, pnl: Number(pnl.toFixed(2)) };
    });
}

export function computeBySymbol(trades: Trade[], limit = 10): SymbolPerformance[] {
  const closed = getClosedTrades(trades);
  const bySymbol = new Map<string, { pnl: number; trades: number }>();

  for (const t of closed) {
    const cur = bySymbol.get(t.symbol) ?? { pnl: 0, trades: 0 };
    cur.pnl += t.realized_pnl;
    cur.trades++;
    bySymbol.set(t.symbol, cur);
  }

  const sorted = Array.from(bySymbol.entries())
    .map(([symbol, v]) => ({ symbol, pnl: Number(v.pnl.toFixed(2)), trades: v.trades }))
    .sort((a, b) => b.pnl - a.pnl);

  if (sorted.length <= limit * 2) {
    return sorted;
  }
  const top = sorted.slice(0, limit);
  const bottom = sorted.slice(-limit);
  // Dedupe in case overlap
  const seen = new Set(top.map((s) => s.symbol));
  return [...top, ...bottom.filter((s) => !seen.has(s.symbol))];
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function computeByDayOfWeek(trades: Trade[]): DayPerformance[] {
  const closed = getClosedTrades(trades);
  const byDay = new Map<number, { total: number; wins: number; count: number }>();

  for (const t of closed) {
    const day = new Date(t.exit_date).getDay();
    const cur = byDay.get(day) ?? { total: 0, wins: 0, count: 0 };
    cur.total += t.realized_pnl;
    if (t.realized_pnl > 0) {
      cur.wins++;
    }
    cur.count++;
    byDay.set(day, cur);
  }

  return Array.from(byDay.entries())
    .sort(([a], [b]) => a - b)
    .map(([day, v]) => ({
      day: DAY_NAMES[day],
      avgPnl: Number((v.total / v.count).toFixed(2)),
      winRate: Number(((v.wins / v.count) * 100).toFixed(1)),
      trades: v.count,
    }));
}

export function normalizePaperPositions(positions: PaperPosition[]): Trade[] {
  return positions.map((p) => ({
    id: p.id,
    user_id: p.user_id,
    symbol: p.ticker,
    asset_class: "equity" as const,
    side: p.side,
    quantity: p.quantity,
    entry_price: p.entry_price,
    exit_price: p.exit_price,
    entry_date: p.opened_at,
    exit_date: p.closed_at,
    commission: 0,
    fees: 0,
    strategy: null,
    tags: [],
    notes: null,
    status: p.status as "open" | "closed",
    currency: "USD",
    realized_pnl: p.realized_pnl,
    created_at: p.created_at,
    updated_at: p.updated_at,
  }));
}
