/**
 * Map an algorithm's `time_horizon` (free-form, set by the LLM or the user)
 * to a concrete API bar interval used by the price provider and price cache.
 *
 * Rule timeframes seen in the wild: "1d", "4h", "1h", "swing", "long term",
 * "weekly", "monthly", "scalp" etc. We normalise here so the rest of the
 * pipeline only handles a small fixed set of intervals.
 */

export type BarInterval = "15min" | "30min" | "1h" | "4h" | "1day";

const KEYWORD_TO_INTERVAL: Array<[RegExp, BarInterval]> = [
  // 15-minute intraday — order matters: must run before "1h" matchers so
  // "15m" / "15min" doesn't accidentally fall through to a broader pattern.
  [/^15m$|^15min$|^15minutes?$|quarter.?hour/i, "15min"],
  // 30-minute intraday — must run before 1h matchers ("30m" should NOT
  // match "60m" pattern). Added 2026-05-04 after Intraday algo was
  // discovered to be silently falling through to "1day" fallback,
  // operating on daily bars instead of 30m. See feedback memory.
  [/^30m$|^30min$|^30minutes?$|half.?hour/i, "30min"],
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

/** Minutes per bar for a given interval. Used by anything that needs to
 *  reason about bar duration in real time — staleness checks, cooldown
 *  windows, force-refresh cadence. */
export function intervalMinutes(interval: BarInterval): number {
  switch (interval) {
    case "15min":
      return 15;
    case "30min":
      return 30;
    case "1h":
      return 60;
    case "4h":
      return 240;
    case "1day":
      return 1440;
  }
}

/** Bars per calendar day for sizing default-window math. Forex/CFD markets
 *  trade ~24h on weekdays, so the count is a true 24h × bars-per-hour for
 *  intraday intervals; daily bars are 1 per day. */
export function barsPerDay(interval: BarInterval): number {
  switch (interval) {
    case "15min":
      return 96;
    case "30min":
      return 48;
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
    case "30min":
      return 720; // ~15 trading days × 48 bars/day
    case "15min":
      return 1000; // ~10 trading days; ATR(14) + lookback windows + signal warmup
  }
}

/**
 * Default walk-forward window + step sizes tuned to each timeframe.
 *
 * The fixed-180-day default that was hard-coded everywhere is wrong for
 * intraday strategies: a 15min algo evaluated on a 180-day window
 * needs 17,280 bars (180 × 96), which exceeds Twelve Data's 5,000-bar
 * cap and silently kills the candidate (zero windows ⇒ no result).
 * Conversely, on a 1d trend-follower, 180 days is too short for
 * regime sampling — only ~180 bars and zero meaningful drawdowns.
 *
 * Numbers chosen so each window has at least ~720 bars (decent for
 * indicator warmup + a few entries) and at most ~3000 bars (avoids
 * blowing through the 5k API cap). Step is roughly window/4 so
 * adjacent windows share ~75% of bars, which gives stability sampling
 * without sacrificing too many degrees of freedom.
 */
export function defaultWalkForwardWindowDays(timeframe: string | undefined): number {
  switch (timeframeToInterval(timeframe)) {
    case "15min":
      return 30; // 30 × 96 = 2880 bars; fits 5k cap × multiple windows
    case "30min":
      return 60; // 60 × 48 = 2880 bars; same target density as 15min
    case "1h":
      return 90; // 90 × 24 = 2160 bars
    case "4h":
      return 180; // 180 × 6 = 1080 bars (matches the legacy hard-coded default)
    case "1day":
      return 365; // 365 bars; captures one full annual cycle
  }
}

export function defaultWalkForwardStepDays(timeframe: string | undefined): number {
  switch (timeframeToInterval(timeframe)) {
    case "15min":
      return 7;
    case "30min":
      return 14;
    case "1h":
      return 21;
    case "4h":
      return 30;
    case "1day":
      return 60;
  }
}
