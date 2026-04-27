/**
 * Daily bias — the higher-timeframe trend filter that ICT traders use as
 * the first sanity check before any intraday entry. Default rule:
 *
 *   D1 close > N-period MA  →  bullish bias  (only consider longs)
 *   D1 close < N-period MA  →  bearish bias  (only consider shorts)
 *
 * The expectation is that this gets called with daily bars even when the
 * primary algorithm runs on an intraday timeframe — caller pulls the D1
 * series via `fetchDailyPrices(symbol, "compact", "1day")`.
 */
import type { PriceBar } from "@/lib/market-data/types";
import type { DailyBiasDetails, PatternResult } from "./types";

/**
 * Compute the daily bias from a series of higher-timeframe bars.
 * `period` defaults to 20 (a common ICT default). When fewer than `period`
 * bars are available, returns neutral with detected=false so callers can
 * gate trading until enough history accumulates.
 */
export function detectDailyBias(
  bars: PriceBar[],
  period: number = 20
): PatternResult<DailyBiasDetails> {
  if (bars.length < period || period < 1) {
    return { detected: false };
  }

  const slice = bars.slice(-period);
  const sum = slice.reduce((s, b) => s + b.close, 0);
  const ma = sum / period;
  const close = bars[bars.length - 1].close;

  let bias: DailyBiasDetails["bias"];
  if (close > ma) bias = "bullish";
  else if (close < ma) bias = "bearish";
  else bias = "neutral";

  return {
    detected: bias !== "neutral",
    details: {
      bias,
      close: Number(close.toFixed(5)),
      ma_value: Number(ma.toFixed(5)),
      ma_period: period,
    },
  };
}
