/**
 * ADX (Average Directional Index) trend-strength filter — skip entries
 * when there's no real trend.
 *
 * The ATR-percentile filter didn't work because LOW volatility doesn't
 * mean RANGING — strong trends can develop in calm markets. ADX is the
 * better signal: it directly measures whether bulls or bears are in
 * control regardless of ATR. Reading:
 *   ADX < 20: weak / no trend (whipsaws likely)
 *   ADX 20-25: trend forming
 *   ADX 25-40: strong trend
 *   ADX > 40: extreme trend (often near reversal)
 *
 * Default threshold = 20 — skip entries when current ADX is below this.
 * Computed on the higher-TF series (D1) for the same reason as the
 * regime filter: stable across primary-TF choices.
 */
import type { PriceBar } from "./types";

export interface AdxFilterConfig {
  enabled: boolean;
  adx_period?: number;
  min_adx?: number;
}

export const DEFAULT_ADX_FILTER = {
  adx_period: 14,
  min_adx: 20,
} as const;

/** Compute ADX over an OHLC series. Wilder-smoothed +DI / -DI / DX
 *  averaged into ADX. Returns one value per bar; entries where there
 *  isn't enough history are null (the first 2 × period - 1 bars). */
export function computeAdx(bars: PriceBar[], period: number): (number | null)[] {
  const out: (number | null)[] = bars.map(() => null);
  if (bars.length < period * 2) return out;

  // True range, +DM, -DM
  const tr: number[] = [0];
  const plusDm: number[] = [0];
  const minusDm: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].high;
    const low = bars[i].low;
    const prevHigh = bars[i - 1].high;
    const prevLow = bars[i - 1].low;
    const prevClose = bars[i - 1].close;
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    const upMove = high - prevHigh;
    const downMove = prevLow - low;
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Wilder smoothing for tr / +DM / -DM, then DI = 100 × smooth(DM) / smooth(TR)
  let trSum = 0;
  let plusDmSum = 0;
  let minusDmSum = 0;
  for (let i = 1; i <= period; i++) {
    trSum += tr[i];
    plusDmSum += plusDm[i];
    minusDmSum += minusDm[i];
  }
  // Compute DX over the period to seed ADX
  const dxSeries: number[] = [];
  if (trSum > 0) {
    const plusDi = (100 * plusDmSum) / trSum;
    const minusDi = (100 * minusDmSum) / trSum;
    const sum = plusDi + minusDi;
    dxSeries.push(sum > 0 ? (100 * Math.abs(plusDi - minusDi)) / sum : 0);
  } else {
    dxSeries.push(0);
  }
  for (let i = period + 1; i < bars.length; i++) {
    trSum = trSum - trSum / period + tr[i];
    plusDmSum = plusDmSum - plusDmSum / period + plusDm[i];
    minusDmSum = minusDmSum - minusDmSum / period + minusDm[i];
    if (trSum <= 0) {
      dxSeries.push(0);
      continue;
    }
    const plusDi = (100 * plusDmSum) / trSum;
    const minusDi = (100 * minusDmSum) / trSum;
    const sum = plusDi + minusDi;
    dxSeries.push(sum > 0 ? (100 * Math.abs(plusDi - minusDi)) / sum : 0);
  }

  // ADX = Wilder MA of DX over `period`. Seed with simple average of
  // the first `period` DX values, then smooth.
  if (dxSeries.length < period) return out;
  let adx = dxSeries.slice(0, period).reduce((a, b) => a + b, 0) / period;
  // The first ADX value lands at index `2*period - 1` (period bars to
  // build the DI seeds + period bars of DX values to average).
  const firstAdxIdx = 2 * period - 1;
  if (firstAdxIdx < bars.length) out[firstAdxIdx] = adx;
  for (let k = period; k < dxSeries.length; k++) {
    adx = (adx * (period - 1) + dxSeries[k]) / period;
    const barIdx = k + period; // dxSeries[k] corresponds to bars[k + period]
    if (barIdx < bars.length) out[barIdx] = adx;
  }
  return out;
}

/** Check whether the trend is "too weak" to trade per the configured
 *  ADX rule. When `skip` is true, callers should suppress the entry. */
export function isWeakTrendByAdx(
  bars: PriceBar[],
  i: number,
  config: AdxFilterConfig
): { skip: boolean; reason?: string; adx?: number } {
  if (!config.enabled) return { skip: false };
  const period = config.adx_period ?? DEFAULT_ADX_FILTER.adx_period;
  const minAdx = config.min_adx ?? DEFAULT_ADX_FILTER.min_adx;
  if (i < period * 2) return { skip: false };
  const series = computeAdx(bars.slice(0, i + 1), period);
  const cur = series[i];
  if (cur == null) return { skip: false };
  if (cur < minAdx) {
    return {
      skip: true,
      reason: `ADX ${cur.toFixed(1)} below min ${minAdx} — trend too weak`,
      adx: cur,
    };
  }
  return { skip: false, adx: cur };
}
