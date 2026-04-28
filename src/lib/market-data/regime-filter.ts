/**
 * Regime / volatility filter — skip entries when the market is in a
 * narrow, choppy state where the strategy historically gets whipsawed.
 *
 * Heuristic: the algorithm's strategies (ICT/SMC patterns + indicator
 * crossovers) need real range to play out. When 20-period ATR drops
 * below the 30th percentile of its 90-day distribution, price has
 * compressed enough that stops typically hit before take-profits ever
 * develop — the data-driven rationale being testing 3's Sep/Feb/Mar
 * months, all sub-30% WR while ATR was unusually low.
 *
 * Configurable via `rules.regime_filter`:
 *   atr_period          — bars used for the ATR average (default 20)
 *   lookback_days       — sample window for the percentile (default 90)
 *   percentile_floor    — skip when current ATR is below this percentile
 *                         of the lookback window (default 0.30)
 *
 * Filter is OFF by default — algos opt in.
 */
import type { PriceBar } from "./types";

export interface RegimeFilterConfig {
  enabled: boolean;
  atr_period?: number;
  lookback_days?: number;
  percentile_floor?: number;
}

export const DEFAULT_REGIME_FILTER = {
  atr_period: 20,
  lookback_days: 90,
  percentile_floor: 0.3,
} as const;

/** Compute ATR over an OHLC series. Returns one value per bar; entries
 *  where there isn't enough history are null. Wilder-smoothed (the
 *  classic ATR formulation), which is what most charting platforms
 *  show for "ATR(20)". */
export function computeAtr(bars: PriceBar[], period: number): (number | null)[] {
  if (bars.length === 0 || period < 1) return bars.map(() => null);
  const tr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) {
      tr.push(bars[0].high - bars[0].low);
      continue;
    }
    const prevClose = bars[i - 1].close;
    tr.push(
      Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - prevClose),
        Math.abs(bars[i].low - prevClose)
      )
    );
  }
  const out: (number | null)[] = bars.map(() => null);
  if (bars.length < period) return out;
  // Seed with simple average of the first `period` true ranges.
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = atr;
  for (let i = period; i < bars.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
  }
  return out;
}

/** Check whether the market at `bars[i]` is in a "ranging" state per
 *  the configured ATR-percentile rule. When `skip` is true, callers
 *  should suppress the entry — the regime is one historically
 *  associated with whipsaws, not breakouts.
 *
 *  Conservatively returns `skip: false` when there isn't enough history
 *  to make a confident call (e.g. early in the backtest window). The
 *  alternative — gating entries on a half-formed sample — would lock
 *  out the algo for the first few months and skew metrics. */
export function isRangingByAtr(
  bars: PriceBar[],
  i: number,
  config: RegimeFilterConfig
): { skip: boolean; reason?: string } {
  if (!config.enabled) return { skip: false };
  const atrPeriod = config.atr_period ?? DEFAULT_REGIME_FILTER.atr_period;
  const lookback = config.lookback_days ?? DEFAULT_REGIME_FILTER.lookback_days;
  const floor = config.percentile_floor ?? DEFAULT_REGIME_FILTER.percentile_floor;

  if (i < atrPeriod + lookback) return { skip: false };

  // Only compute ATR up to the current bar so the filter is causal —
  // backtests never get to see future data, and live always sits at
  // the latest bar by definition.
  const atrSeries = computeAtr(bars.slice(0, i + 1), atrPeriod);
  const current = atrSeries[i];
  if (current == null) return { skip: false };

  // Build the lookback distribution. We slice from `i - lookback` to
  // `i` (inclusive of the current value to keep the percentile stable
  // across the boundary — excluding `current` would let it dip just
  // below the threshold from a value that wasn't in the sample).
  const window = atrSeries.slice(Math.max(0, i - lookback), i + 1).filter(
    (v): v is number => v !== null
  );
  if (window.length < Math.floor(lookback / 2)) return { skip: false };

  const sorted = [...window].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * floor);
  const threshold = sorted[Math.min(idx, sorted.length - 1)];

  if (current < threshold) {
    return {
      skip: true,
      reason: `ATR ${current.toFixed(5)} below ${(floor * 100).toFixed(0)}th percentile (${threshold.toFixed(5)}) over last ${lookback} bars`,
    };
  }
  return { skip: false };
}
