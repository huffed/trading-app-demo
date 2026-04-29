/**
 * Intraday ATR liquidity gate — refuses entries when the recent
 * primary-timeframe ATR is unusually compressed.
 *
 * Replaces the previous clock-time `session_filter` which hard-coded the
 * London + NY-overlap window (07-17 UTC). The clock approach captured
 * only one feature of a multi-feature problem ("low liquidity"), and got
 * it wrong in both directions — it blocked legitimate Asian-pair entries
 * during 22-00 UTC and allowed compressed mid-session bars where price
 * has stalled. ATR percentile is data-driven: on EUR/USD a bar inside
 * the 22-00 UTC window typically falls below the 20th percentile of the
 * last 200 1h bars; on AUD/JPY the compression is around 03 UTC instead
 * of 22 UTC. The gate adapts per symbol without us encoding the
 * peculiarities by hand.
 *
 * The existing `regime_filter` is configurable per algorithm and runs
 * on the DAILY series, catching multi-day compression regimes (the
 * Sep/Mar/Feb 0% WR months). The intraday gate is unconditional and
 * runs on the PRIMARY timeframe, catching short-window compression
 * inside an otherwise normal daily regime.
 *
 * Backtest + live use the same module so the replay matches what would
 * actually fire — no path divergence.
 */
import { computeAtr } from "@/lib/market-data/regime-filter";
import type { PriceBar } from "@/lib/market-data/types";

export interface AtrLiquidityGateOptions {
  /** ATR averaging period. Default 14. */
  atrPeriod?: number;
  /** Lookback bars for the percentile distribution. Default 200. */
  lookback?: number;
  /** Skip entries when current ATR is below this percentile (0..1).
   *  Default 0.20 — the bottom fifth of recent activity. */
  floorPercentile?: number;
}

const DEFAULTS = {
  atrPeriod: 14,
  lookback: 200,
  floorPercentile: 0.2,
} as const;

export interface AtrLiquidityResult {
  /** True when the entry should be skipped. */
  skip: boolean;
  /** Human-readable reason, suitable for activity_log details.reason. */
  reason?: string;
  /** Telemetry — exposed so callers can log even when not blocked. */
  atr_current: number | null;
  atr_threshold: number | null;
  /** "no_data" when there isn't enough history to make a call;
   *  callers should treat that as "allow" (consistent with the
   *  regime_filter behaviour — never lock out from a half-formed sample). */
  status: "blocked" | "allowed" | "no_data";
}

/**
 * Check whether the bar at `bars[i]` is in a compressed-ATR state
 * where entries are unlikely to play out. Returns telemetry for
 * activity_log so we can later mine which entries were blocked vs
 * allowed and tune the percentile if 0.20 turns out wrong empirically.
 *
 * Conservatively returns `allowed / no_data` whenever there isn't
 * enough history to compute a stable percentile. The alternative —
 * blocking on insufficient samples — would lock out the algorithm
 * for the first 200+ bars of any new symbol's backtest window.
 */
export function checkAtrLiquidity(
  bars: PriceBar[],
  i: number,
  options?: AtrLiquidityGateOptions
): AtrLiquidityResult {
  const period = options?.atrPeriod ?? DEFAULTS.atrPeriod;
  const lookback = options?.lookback ?? DEFAULTS.lookback;
  const floor = options?.floorPercentile ?? DEFAULTS.floorPercentile;

  if (i < period + Math.floor(lookback / 2)) {
    return { skip: false, atr_current: null, atr_threshold: null, status: "no_data" };
  }

  const atrSeries = computeAtr(bars.slice(0, i + 1), period);
  const current = atrSeries[i];
  if (current == null) {
    return { skip: false, atr_current: null, atr_threshold: null, status: "no_data" };
  }

  const window = atrSeries
    .slice(Math.max(0, i - lookback), i + 1)
    .filter((v): v is number => v !== null);
  if (window.length < Math.floor(lookback / 2)) {
    return { skip: false, atr_current: current, atr_threshold: null, status: "no_data" };
  }

  const sorted = [...window].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * floor);
  const threshold = sorted[Math.min(idx, sorted.length - 1)];

  if (current < threshold) {
    return {
      skip: true,
      reason: `ATR ${current.toFixed(5)} below ${(floor * 100).toFixed(0)}th percentile (${threshold.toFixed(5)}) over last ${window.length} bars`,
      atr_current: current,
      atr_threshold: threshold,
      status: "blocked",
    };
  }
  return {
    skip: false,
    atr_current: current,
    atr_threshold: threshold,
    status: "allowed",
  };
}
