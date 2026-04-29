/**
 * Map an algorithm's `time_horizon` (free-form, set by the LLM or the user)
 * to a concrete API bar interval used by the price provider and price cache.
 *
 * Rule timeframes seen in the wild: "1d", "4h", "1h", "swing", "long term",
 * "weekly", "monthly", "scalp" etc. We normalise here so the rest of the
 * pipeline only handles a small fixed set of intervals.
 */

export type BarInterval = "15min" | "1h" | "4h" | "1day";

const KEYWORD_TO_INTERVAL: Array<[RegExp, BarInterval]> = [
  // 15-minute intraday — order matters: must run before "1h" matchers so
  // "15m" / "15min" doesn't accidentally fall through to a broader pattern.
  [/^15m$|^15min$|^15minutes?$|quarter.?hour/i, "15min"],
  [/^1h$|^1hr$|^60m$|hourly|scalp/i, "1h"],
  [/^4h$|^4hr$|^240m$/i, "4h"],
  [/^1d$|^daily$|swing|long.?term|weekly|monthly|position/i, "1day"],
];

export function timeframeToInterval(timeframe: string | undefined): BarInterval {
  if (!timeframe) return "1day";
  for (const [pattern, interval] of KEYWORD_TO_INTERVAL) {
    if (pattern.test(timeframe.trim())) return interval;
  }
  return "1day";
}

/** Bars per calendar day for sizing default-window math. Forex/CFD markets
 *  trade ~24h on weekdays, so the count is a true 24h × bars-per-hour for
 *  intraday intervals; daily bars are 1 per day. */
export function barsPerDay(interval: BarInterval): number {
  switch (interval) {
    case "15min":
      return 96;
    case "1h":
      return 24;
    case "4h":
      return 6;
    case "1day":
      return 1;
  }
}

/**
 * Pick the right output_size for a backtest given the bar interval.
 * - 1day: "compact" (100 bars = 100 trading days, plenty)
 * - 4h / 1h / 15min: "full" — Twelve Data returns up to 5000 bars (~2 years
 *   of 4h, ~7 months of 1h, ~52 days of 15min). Without this, intraday
 *   backtests run on ~16 days of data, which is too small a sample for any
 *   conclusion. Note: 15min walk-forward windows must be SHORTER than 180
 *   days because 180d × 96 bars/day = 17,280 bars > 5000-bar API limit;
 *   the readiness check sets shorter windows automatically when interval
 *   resolves to 15min.
 */
export function recommendedOutputSize(interval: BarInterval): "compact" | "full" {
  return interval === "1day" ? "compact" : "full";
}

/**
 * Minimum bars required for a meaningful backtest. Daily strategies need
 * ~30 days for indicator warmup + a few signals; intraday strategies need
 * proportionally more bars because each bar is a smaller slice of time.
 */
export function minBarsFor(interval: BarInterval): number {
  switch (interval) {
    case "1day":
      return 30;
    case "4h":
      return 200; // ~33 trading days
    case "1h":
      return 500; // ~21 trading days
    case "15min":
      return 1000; // ~10 trading days; ATR(14) + lookback windows + signal warmup
  }
}
