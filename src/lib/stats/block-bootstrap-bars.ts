/**
 * Block bootstrap of OHLC price bars — preserves intra-block serial
 * correlation while resampling across blocks. Used by F2.3 search-
 * robustness audit to test whether a candidate algo's signal survives
 * resampling of the underlying price history.
 *
 * Standard i.i.d. bootstrap is wrong for price series: returns within
 * a trading day are correlated. Moving-block bootstrap (Künsch 1989,
 * Liu & Singh 1992) preserves correlations within fixed-length blocks
 * while breaking dependencies across blocks, giving valid CIs without
 * destroying structure.
 *
 * The bar timestamps are RE-INDEXED across the synthetic series so
 * downstream code (validate-algo, runPortfolioBacktest, alpha-decay,
 * etc.) sees a strictly-monotonic time axis. Without re-indexing,
 * two blocks could share a timestamp and break "trades sorted by
 * entry_date" assumptions.
 *
 * Determinism: same seed → identical output. mulberry32 PRNG (same as
 * bootstrap.ts) so cross-module reproducibility is preserved.
 */
import type { PriceBar } from "@/lib/market-data/types";

export interface BlockBootstrapOptions {
  /** Block size in bars. 24 = 1 day at 4h granularity (current default for
   *  F2.3). Larger blocks preserve more structure; smaller blocks give more
   *  effective i.i.d. resampling. Must be ≥ 1 and ≤ bars.length. */
  blockSize: number;
  /** PRNG seed. Same seed → same output. Required (no default) to force
   *  callers to think about reproducibility. */
  seed: number;
  /** Output length in bars. Default = input length (most common: 1:1
   *  resample). Can be smaller (truncated) or larger (oversampled). */
  outputLength?: number;
}

/** Deterministic mulberry32 PRNG. Identical implementation to
 *  bootstrap.ts mulberry32 — kept inlined here to avoid a cross-import
 *  for a 10-line helper. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Block-bootstrap a series of price bars. Picks ceil(outputLength/blockSize)
 *  random block-start indices in [0, bars.length - blockSize], concatenates
 *  blocks, truncates to outputLength, and re-indexes timestamps as evenly-
 *  spaced intervals derived from the input series' median bar spacing.
 *
 *  Re-indexing rationale: the synthetic series MUST have strictly-monotonic
 *  timestamps for downstream sort + binary-search consumers. Mixing original
 *  timestamps from non-contiguous blocks would produce a non-monotonic
 *  series. The output is the same WALL-CLOCK SPAN as `outputLength × median
 *  spacing`, ending at the same `lastBar.date` so downstream OOS_CUTOFF
 *  comparisons against the original cutoff date still partition meaningfully.
 *
 *  Caller contract:
 *    - bars MUST be sorted by timestamp ascending (no internal sort to
 *      preserve the input's existing order; behaviour undefined otherwise).
 *    - blockSize ≥ 1 AND ≤ bars.length (throws otherwise).
 *    - outputLength ≥ 1 (default = bars.length).
 *
 *  Output: synthetic bars with original price values from the resampled
 *  blocks but synthetic timestamps. OHLCV preserved bar-for-bar within
 *  each block (a block is contiguous slice of the original).
 */
export function blockBootstrapBars(
  bars: readonly PriceBar[],
  opts: BlockBootstrapOptions,
): PriceBar[] {
  const { blockSize, seed } = opts;
  const outputLength = opts.outputLength ?? bars.length;

  if (bars.length === 0) return [];
  if (blockSize < 1) {
    throw new Error(`blockSize must be ≥ 1; got ${blockSize}.`);
  }
  if (blockSize > bars.length) {
    throw new Error(
      `blockSize (${blockSize}) cannot exceed bars.length (${bars.length}).`,
    );
  }
  if (outputLength < 1) {
    throw new Error(`outputLength must be ≥ 1; got ${outputLength}.`);
  }

  const rng = mulberry32(seed);
  const maxStart = bars.length - blockSize;

  // Median bar spacing for synthetic timestamp grid. Median (not mean)
  // is robust against weekend gaps + DST transitions.
  const spacingMs = medianBarSpacingMs(bars);
  const finalTimestampMs = new Date(bars[bars.length - 1].date).getTime();
  // Anchor synthetic series so the LAST bar lands on the original's last
  // timestamp — preserves OOS_CUTOFF semantics across bootstrap and real.
  const firstSyntheticMs = finalTimestampMs - (outputLength - 1) * spacingMs;

  const out: PriceBar[] = [];
  while (out.length < outputLength) {
    // Inclusive max: maxStart is the LAST valid start index (yields a full block).
    const startIdx = Math.floor(rng() * (maxStart + 1));
    const remainingNeeded = outputLength - out.length;
    const take = Math.min(blockSize, remainingNeeded);
    for (let i = 0; i < take; i++) {
      const src = bars[startIdx + i];
      const syntheticMs = firstSyntheticMs + out.length * spacingMs;
      out.push({
        date: new Date(syntheticMs).toISOString(),
        open: src.open,
        high: src.high,
        low: src.low,
        close: src.close,
        volume: src.volume,
      });
    }
  }
  return out;
}

/** Median bar spacing in milliseconds. For a series with N bars there
 *  are N-1 spacings. Returns 0 for series with < 2 bars (degenerate;
 *  caller's responsibility to handle). */
export function medianBarSpacingMs(bars: readonly PriceBar[]): number {
  if (bars.length < 2) return 0;
  const spacings: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const a = new Date(bars[i - 1].date).getTime();
    const b = new Date(bars[i].date).getTime();
    spacings.push(b - a);
  }
  spacings.sort((a, b) => a - b);
  const mid = Math.floor(spacings.length / 2);
  return spacings.length % 2 === 1
    ? spacings[mid]
    : Math.round((spacings[mid - 1] + spacings[mid]) / 2);
}

/** Generate N independent block-bootstrap resamples from the same input.
 *  Each uses a derived seed (baseSeed + i) for full reproducibility.
 *  Wall-clock dominates; the loop body is per-resample O(outputLength). */
export function blockBootstrapBarsMany(
  bars: readonly PriceBar[],
  nResamples: number,
  opts: Omit<BlockBootstrapOptions, "seed"> & { baseSeed: number },
): PriceBar[][] {
  if (nResamples < 1) {
    throw new Error(`nResamples must be ≥ 1; got ${nResamples}.`);
  }
  const out: PriceBar[][] = [];
  for (let i = 0; i < nResamples; i++) {
    out.push(blockBootstrapBars(bars, { ...opts, seed: opts.baseSeed + i }));
  }
  return out;
}
