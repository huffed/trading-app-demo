/**
 * Walk-forward backtest harness — slices the full price history into
 * rolling out-of-sample windows and runs a portfolio backtest on each.
 *
 * Access: admin-only via /api/admin/walk-forward (Bearer CRON_SECRET).
 * Surfaced through the readiness-check admin endpoint when validating
 * an algorithm before live trading. There is no end-user UI by design —
 * the harness can take minutes to run on a long history, and the
 * results are most useful as a one-off go/no-go signal rather than
 * something traders inspect repeatedly. If you want to expose it, add a
 * card on the algorithm detail page that calls the admin endpoint via
 * a server action gated on the operator role.
 *
 * Why: a single 1-year backtest can hide regime-dependent edge. A
 * strategy that works great in trending tape but bleeds in chop will
 * average out to "looks fine" over a long sample, while every
 * individual chop period quietly drains the account. Walk-forward
 * surfaces that variance — if 6 of 10 windows are red, the aggregate
 * "+50%" doesn't mean what the user thinks it means.
 *
 * Window definition:
 *   - testWindowDays: size of each evaluation window (e.g. 60)
 *   - stepDays: how far to advance the window each iteration (e.g. 30)
 *
 * With testWindowDays=60 / stepDays=30 over 1 year of data we get ~10
 * overlapping out-of-sample windows. Overlap is fine for stability
 * sampling; for strict statistical independence the caller can set
 * stepDays >= testWindowDays.
 */
import type { AlgorithmRules } from "@/types/algorithm";
import { runPortfolioBacktest } from "./portfolio-backtest";
import type { EconomicEvent } from "./economic-calendar";
import type { BacktestMetrics, PriceBar } from "./types";

export interface WalkForwardWindow {
  index: number;
  start: string;
  end: string;
  total_trades: number;
  win_rate: number;
  total_return: number;
  max_drawdown: number;
}

export interface WalkForwardSummary {
  windows: WalkForwardWindow[];
  /** Mean of per-window stats (not the same as aggregate single backtest). */
  mean_win_rate: number;
  mean_return: number;
  mean_drawdown: number;
  /** Standard deviation across windows — higher = strategy is more regime-
   *  dependent. We surface this rather than computing it on the call site
   *  because the math is small and centralising the formula keeps the
   *  reporting consistent across endpoints. */
  std_return: number;
  /** Fraction of windows that finished in the green. ≥0.7 is "robust", */
  win_rate_of_windows: number;
  total_windows: number;
}

export interface WalkForwardOptions {
  testWindowDays: number;
  stepDays: number;
  events?: EconomicEvent[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Slice each ticker's bar series into the given date range. Inclusive
 *  of both endpoints. */
function sliceByDate(
  prices: Map<string, PriceBar[]>,
  startMs: number,
  endMs: number
): Map<string, PriceBar[]> {
  const out = new Map<string, PriceBar[]>();
  for (const [ticker, bars] of prices) {
    const sub = bars.filter((b) => {
      const t = new Date(b.date).getTime();
      return t >= startMs && t <= endMs;
    });
    if (sub.length >= 30) out.set(ticker, sub);
  }
  return out;
}

function findOverallRange(prices: Map<string, PriceBar[]>): { startMs: number; endMs: number } {
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = 0;
  for (const bars of prices.values()) {
    if (bars.length === 0) continue;
    const first = new Date(bars[0].date).getTime();
    const last = new Date(bars[bars.length - 1].date).getTime();
    if (first < startMs) startMs = first;
    if (last > endMs) endMs = last;
  }
  return { startMs, endMs };
}

function summariseWindows(windows: WalkForwardWindow[]): Omit<WalkForwardSummary, "windows" | "total_windows"> {
  if (windows.length === 0) {
    return {
      mean_win_rate: 0,
      mean_return: 0,
      mean_drawdown: 0,
      std_return: 0,
      win_rate_of_windows: 0,
    };
  }
  const sumWr = windows.reduce((s, w) => s + w.win_rate, 0);
  const sumRet = windows.reduce((s, w) => s + w.total_return, 0);
  const sumDd = windows.reduce((s, w) => s + w.max_drawdown, 0);
  const meanRet = sumRet / windows.length;
  const variance =
    windows.reduce((s, w) => s + (w.total_return - meanRet) ** 2, 0) / windows.length;
  const greenCount = windows.filter((w) => w.total_return > 0).length;
  return {
    mean_win_rate: sumWr / windows.length,
    mean_return: meanRet,
    mean_drawdown: sumDd / windows.length,
    std_return: Math.sqrt(variance),
    win_rate_of_windows: greenCount / windows.length,
  };
}

/**
 * Run the algorithm across rolling out-of-sample windows. Each window
 * is an independent backtest with its own price slice and capital
 * (capital is reset to the original each window so we measure per-
 * window edge, not compounding luck from earlier windows).
 */
export function runWalkForward(
  rules: AlgorithmRules,
  prices: Map<string, PriceBar[]>,
  capital: number,
  options: WalkForwardOptions
): WalkForwardSummary {
  const { startMs, endMs } = findOverallRange(prices);
  if (!Number.isFinite(startMs) || endMs <= startMs) {
    return {
      windows: [],
      mean_win_rate: 0,
      mean_return: 0,
      mean_drawdown: 0,
      std_return: 0,
      win_rate_of_windows: 0,
      total_windows: 0,
    };
  }
  const testMs = options.testWindowDays * DAY_MS;
  const stepMs = options.stepDays * DAY_MS;

  const windows: WalkForwardWindow[] = [];
  let i = 0;
  for (let cursor = startMs; cursor + testMs <= endMs; cursor += stepMs) {
    const sliceStart = cursor;
    const sliceEnd = cursor + testMs;
    const sliced = sliceByDate(prices, sliceStart, sliceEnd);
    if (sliced.size === 0) {
      i++;
      continue;
    }
    const result: BacktestMetrics = runPortfolioBacktest(rules, sliced, capital, options.events ?? []);
    windows.push({
      index: i++,
      start: new Date(sliceStart).toISOString().slice(0, 10),
      end: new Date(sliceEnd).toISOString().slice(0, 10),
      total_trades: result.total_trades,
      win_rate: result.win_rate,
      total_return: result.total_return,
      max_drawdown: result.max_drawdown,
    });
  }

  return {
    windows,
    total_windows: windows.length,
    ...summariseWindows(windows),
  };
}
