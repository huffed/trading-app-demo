import type { BacktestTrade } from "@/lib/market-data/types";

export interface BootstrapResult {
  point: number;
  lower: number;
  upper: number;
  n_iterations: number;
  ci_level: number;
}

export interface BootstrapResultWithSamples extends BootstrapResult {
  samples: number[];
}

export interface BootstrapOptions {
  n_iterations?: number;
  ci_level?: number;
  seed?: number;
}

/** Deterministic mulberry32 PRNG. Seed required so reruns of the same
 *  trade set produce identical CIs — otherwise downstream comparisons
 *  (live-vs-backtest, before-vs-after) drift across runs. */
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

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

/** Bootstrap a statistic across N resamples-with-replacement of the input
 *  items. Returns the original point estimate + lower/upper percentiles
 *  of the resampled distribution at ci_level (default 95%).
 *
 *  Use bootstrapStatWithSamples when the caller needs the raw sample
 *  distribution (e.g. for p-values, MCC). */
export function bootstrapStat<T>(
  items: T[],
  statFn: (sample: T[]) => number,
  opts: BootstrapOptions = {}
): BootstrapResult {
  const full = bootstrapStatWithSamples(items, statFn, opts);
  return {
    point: full.point,
    lower: full.lower,
    upper: full.upper,
    n_iterations: full.n_iterations,
    ci_level: full.ci_level,
  };
}

export function bootstrapStatWithSamples<T>(
  items: T[],
  statFn: (sample: T[]) => number,
  opts: BootstrapOptions = {}
): BootstrapResultWithSamples {
  const n_iterations = opts.n_iterations ?? 1000;
  const ci_level = opts.ci_level ?? 0.95;
  const seed = opts.seed ?? 42;
  const point = statFn(items);
  if (items.length === 0) {
    return { point, lower: NaN, upper: NaN, n_iterations, ci_level, samples: [] };
  }
  const rng = mulberry32(seed);
  const samples: number[] = new Array(n_iterations);
  const buf: T[] = new Array(items.length);
  for (let it = 0; it < n_iterations; it++) {
    for (let j = 0; j < items.length; j++) {
      buf[j] = items[Math.floor(rng() * items.length)];
    }
    samples[it] = statFn(buf);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const lo_q = (1 - ci_level) / 2;
  const hi_q = 1 - lo_q;
  return {
    point,
    lower: quantile(sorted, lo_q),
    upper: quantile(sorted, hi_q),
    n_iterations,
    ci_level,
    samples,
  };
}

export interface BlockBootstrapOptions extends BootstrapOptions {
  /** Block size for moving-block bootstrap. Default = ceil(sqrt(n)) which
   *  is the standard rule-of-thumb for stationary time series with unknown
   *  autocorrelation length. Larger blocks = more conservative CIs (wider). */
  block_size?: number;
}

/** Moving-block bootstrap. Resamples CONTIGUOUS blocks of items rather
 *  than individual items, preserving short-range serial correlation that
 *  individual-trade bootstrap silently discards.
 *
 *  Use this for trade series where consecutive trades are NOT
 *  independent — e.g. trades within a bull-trend year cluster together
 *  as wins; trades within a chop year cluster as small losses. Trade-
 *  level bootstrap UNDERSTATES the variance of stats like mean R or
 *  total return because it implicitly assumes IID trades.
 *
 *  Wraps around the sample: a block starting near the tail can include
 *  items from the head. This is the "circular block bootstrap" variant
 *  (Politis & Romano 1992) — slightly tighter than non-circular but
 *  doesn't underweight the boundary items. */
export function bootstrapStatBlock<T>(
  items: T[],
  statFn: (sample: T[]) => number,
  opts: BlockBootstrapOptions = {}
): BootstrapResult {
  const full = bootstrapStatBlockWithSamples(items, statFn, opts);
  return {
    point: full.point,
    lower: full.lower,
    upper: full.upper,
    n_iterations: full.n_iterations,
    ci_level: full.ci_level,
  };
}

export function bootstrapStatBlockWithSamples<T>(
  items: T[],
  statFn: (sample: T[]) => number,
  opts: BlockBootstrapOptions = {}
): BootstrapResultWithSamples {
  const n_iterations = opts.n_iterations ?? 1000;
  const ci_level = opts.ci_level ?? 0.95;
  const seed = opts.seed ?? 42;
  const blockSize = Math.max(1, opts.block_size ?? Math.ceil(Math.sqrt(items.length)));
  const point = statFn(items);
  if (items.length === 0) {
    return { point, lower: NaN, upper: NaN, n_iterations, ci_level, samples: [] };
  }
  const rng = mulberry32(seed);
  const samples: number[] = new Array(n_iterations);
  const buf: T[] = new Array(items.length);
  const nBlocksNeeded = Math.ceil(items.length / blockSize);
  for (let it = 0; it < n_iterations; it++) {
    let written = 0;
    for (let b = 0; b < nBlocksNeeded && written < items.length; b++) {
      const start = Math.floor(rng() * items.length);
      for (let j = 0; j < blockSize && written < items.length; j++) {
        // Circular: wrap around the array boundary.
        buf[written++] = items[(start + j) % items.length];
      }
    }
    samples[it] = statFn(buf);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const lo_q = (1 - ci_level) / 2;
  const hi_q = 1 - lo_q;
  return {
    point,
    lower: quantile(sorted, lo_q),
    upper: quantile(sorted, hi_q),
    n_iterations,
    ci_level,
    samples,
  };
}

/** Wilson score interval for a binomial proportion. Better than normal
 *  approximation for small N or extreme proportions (where normal
 *  approximation gives bounds outside [0,1] or misses skew).
 *
 *  Used for step3 walk-forward "fraction of windows green" — discrete
 *  binomial outcomes, often small N (e.g. 20 windows). */
export function wilsonIntervalProportion(
  successes: number,
  trials: number,
  ci_level: number = 0.95
): { point: number; lower: number; upper: number } {
  if (trials <= 0) return { point: NaN, lower: NaN, upper: NaN };
  // 95% → z=1.96; 99% → z=2.576. Two-sided.
  const z = inverseStandardNormalCdf(1 - (1 - ci_level) / 2);
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const centre = p + (z * z) / (2 * trials);
  const halfWidth = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * trials)) / trials);
  return {
    point: p,
    lower: Math.max(0, (centre - halfWidth) / denominator),
    upper: Math.min(1, (centre + halfWidth) / denominator),
  };
}

/** Acklam's approximation of the inverse standard normal CDF. Accurate
 *  to ~1e-9 across the entire range. Used only for Wilson interval; if
 *  more accuracy is ever needed, swap to a proper erf-based implementation. */
function inverseStandardNormalCdf(p: number): number {
  if (p <= 0 || p >= 1) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number, r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
}

export function winRate(trades: BacktestTrade[]): number {
  if (trades.length === 0) return 0;
  let wins = 0;
  for (const t of trades) if (t.pnl > 0) wins++;
  return (wins / trades.length) * 100;
}

export function meanR(trades: BacktestTrade[], riskPerTrade: number): number {
  if (trades.length === 0 || riskPerTrade <= 0) return 0;
  let s = 0;
  for (const t of trades) s += t.pnl;
  return s / trades.length / riskPerTrade;
}

export function totalReturn(trades: BacktestTrade[]): number {
  let s = 0;
  for (const t of trades) s += t.pnl;
  return s;
}

/** Per-trade Sharpe (mean / std of R-multiples). Not annualized — that
 *  requires trade frequency context we don't carry at this layer. The
 *  validator can scale by sqrt(trades_per_year) if it wants annualized. */
export function sharpeRatio(trades: BacktestTrade[], riskPerTrade: number): number {
  if (trades.length < 2 || riskPerTrade <= 0) return 0;
  const rs: number[] = trades.map((t) => t.pnl / riskPerTrade);
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  let sq = 0;
  for (const r of rs) sq += (r - mean) * (r - mean);
  const std = Math.sqrt(sq / (rs.length - 1));
  if (std === 0) return 0;
  return mean / std;
}
