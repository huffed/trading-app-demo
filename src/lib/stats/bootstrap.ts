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
