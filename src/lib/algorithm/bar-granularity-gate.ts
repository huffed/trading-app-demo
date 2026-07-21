/**
 * Bar-granularity gate — refuses entry evaluation when the served bar
 * series doesn't match the algorithm's primary-timeframe bar grid.
 *
 * Why this exists (E2.25.a.ii, observed live 2026-07-19 → 07-20): the
 * price fallback chain serves the provider payload to the caller
 * IN-MEMORY even when the DQ.3/DQ.4 write guards refuse to persist it
 * (`getFreshPricesForScan` returns `fresh` directly; the cache write is
 * fire-and-forget). During an OANDA outage a fallback provider served
 * what was almost certainly a 1h-granularity series as the 4h series
 * for ~24h — every ATR reading halved (range scales ~√t, √4 = 2×) and
 * the intraday-ATR gate happened to block in both scales. Had a pattern
 * fired instead, it would have been a wrong-granularity entry inside
 * the M1/G.8 evidence stream.
 *
 * Relationship to the other data gates:
 *  - DQ.3/DQ.4 (price-cache write guards) protect what PERSISTS.
 *  - Bar-staleness gate protects against an OLD series.
 *  - This gate protects against a WRONG-SHAPED series that is perfectly
 *    fresh — finer bars actually look FRESHER to the staleness gate, so
 *    staleness cannot catch this failure mode.
 *
 * Predicate: median consecutive-bar spacing over the full served series
 * (medianSpacingMinutes — same helper the DQ.3 write guard uses; median
 * is robust to weekend/session gaps) compared against the expected
 * primary-TF minutes. The lower bound (0.75×) mirrors the DQ.3 write
 * guard exactly; the upper bound (1.5×) additionally catches a COARSER
 * payload (e.g. daily bars served as 4h — the 2026-05-04 timeframe
 * fall-through incident class).
 */
import { intervalMinutes, timeframeToInterval } from "@/lib/market-data/interval";
import { medianSpacingMinutes } from "@/lib/market-data/price-cache";
import type { PriceBar } from "@/lib/market-data/types";

/** Median spacing below this fraction of expected = finer-granularity
 *  payload. Mirrors the DQ.3 write guard's `< 0.75 × expected` check. */
export const GRANULARITY_LOWER_BOUND = 0.75;
/** Median spacing above this multiple of expected = coarser-granularity
 *  payload. Chosen so legitimate gap-bearing series stay clear: a clean
 *  4h series' median is 240 (weekend gaps are outliers the median
 *  ignores), and a clean daily series' median is 1440 < 1.5 × 1440. */
export const GRANULARITY_UPPER_BOUND = 1.5;

export interface BarGranularityGateResult {
  block: boolean;
  status: "ok" | "granularity_mismatch" | "insufficient_bars";
  /** Median consecutive-bar spacing of the served series, in minutes.
   *  Null when the series is too short to measure (< 3 bars). */
  median_spacing_minutes: number | null;
  /** Expected bar spacing for the algorithm's primary TF, in minutes. */
  expected_minutes: number;
  reason?: string;
}

/**
 * Returns block:true when the served series' median bar spacing falls
 * outside [0.75×, 1.5×] of the primary-TF bar duration. Too-short
 * series pass through (block:false) — positive evidence of a mismatch
 * is required to refuse; the scan's min-length guard owns the
 * short-series case.
 */
export function checkBarGranularity(args: {
  /** The algorithm's primary timeframe (e.g. "15m", "1h", "4h"). */
  timeframe: string;
  /** The full served primary-TF series, as handed to evaluation. */
  bars: PriceBar[];
}): BarGranularityGateResult {
  const expectedMinutes = intervalMinutes(timeframeToInterval(args.timeframe));
  const median = medianSpacingMinutes(args.bars);

  if (median === null) {
    return {
      block: false,
      status: "insufficient_bars",
      median_spacing_minutes: null,
      expected_minutes: expectedMinutes,
    };
  }

  const lower = expectedMinutes * GRANULARITY_LOWER_BOUND;
  const upper = expectedMinutes * GRANULARITY_UPPER_BOUND;
  if (median < lower || median > upper) {
    const shape = median < lower ? "finer" : "coarser";
    return {
      block: true,
      status: "granularity_mismatch",
      median_spacing_minutes: median,
      expected_minutes: expectedMinutes,
      reason: `Bar-grid mismatch: served series has median spacing ${median.toFixed(1)} min vs expected ${expectedMinutes} min for the ${args.timeframe} primary TF (allowed ${lower.toFixed(0)}–${upper.toFixed(0)} min). A fallback provider likely served a ${shape}-granularity payload in-memory (DQ.4 blocks persistence, not serving). Evaluating it would compute ATR/patterns on the wrong bar shape.`,
    };
  }

  return {
    block: false,
    status: "ok",
    median_spacing_minutes: median,
    expected_minutes: expectedMinutes,
  };
}
