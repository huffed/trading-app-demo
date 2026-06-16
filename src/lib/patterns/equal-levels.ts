/**
 * Equal highs / equal lows — ICT "buy-side / sell-side liquidity."
 *
 * Two or more recent swing highs (or lows) clustered at approximately
 * the same price level. ICT names these "liquidity pools": equal highs
 * sit above resting buy-stops (buy-side liquidity); equal lows sit
 * above resting sell-stops (sell-side liquidity). They are targets
 * for liquidity-sweep moves and magnets for price action.
 *
 * Convention (matches other directional detectors here):
 *   - direction="bullish" → equal LOWS detected. The cluster is below
 *     current price; trade thesis is "price sweeps these lows and
 *     reverses bullishly" (classic ICT long setup after sell-side raid).
 *   - direction="bearish" → equal HIGHS detected. The cluster is above
 *     current price; trade thesis is "price sweeps these highs and
 *     reverses bearishly" (short setup after buy-side raid).
 *
 * Causal — only uses bars up to and including `idx`, and only counts
 * swings that have ±swingLookback confirming bars on both sides. Same
 * input at the same `idx` in backtest vs live returns the same answer.
 */
import type { PriceBar } from "@/lib/market-data/types";
import { detectSwingPoints } from "./swing-points";
import type { PatternResult, SwingPoint } from "./types";

export interface EqualLevelsDetails {
  direction: "bullish" | "bearish";
  /** "high" when direction=bearish (equal highs above), "low" when bullish. */
  level_type: "high" | "low";
  /** Cluster center — mean price of the qualifying swings. */
  level: number;
  /** How many swings make up the cluster (≥ minCount). */
  count: number;
  /** Bar indices of the swings in the cluster (sorted ascending). */
  swing_indices: number[];
  /** Tolerance used (% of price) — recorded so backtest replay is auditable. */
  tolerance_pct: number;
}

export interface EqualLevelsOptions {
  /** ±N-bar window confirming a swing point. Default 5 (ICT default). */
  swingLookback?: number;
  /** How many bars back from `idx` to scan for clusterable swings. Default 50. */
  scanWindow?: number;
  /** Cluster tolerance as percentage of price. Default 0.1 (= 0.1% of price,
   *  e.g. $4 at $4000 gold; ~11 pips at EUR/USD 1.10). */
  tolerancePct?: number;
  /** Minimum swings at the same level for a valid cluster. Default 2. */
  minCount?: number;
}

/**
 * Detect an equal-levels cluster AT BAR `idx`. Returns detected=true only
 * when at least `minCount` confirmed swings of the matching type (low for
 * bullish, high for bearish) sit within `tolerancePct` of each other,
 * inside the last `scanWindow` bars.
 *
 * Picks the LARGEST qualifying cluster (most swings at the same level)
 * when multiple candidates exist. Ties broken by most-recent — recency
 * matters more than depth for tradeable liquidity.
 */
export function detectEqualLevels(
  bars: PriceBar[],
  idx: number,
  direction: "bullish" | "bearish",
  options: EqualLevelsOptions = {}
): PatternResult<EqualLevelsDetails> {
  const swingLookback = options.swingLookback ?? 5;
  const scanWindow = options.scanWindow ?? 50;
  const tolerancePct = options.tolerancePct ?? 0.1;
  const minCount = options.minCount ?? 2;

  if (idx < swingLookback * 2 || idx >= bars.length) return { detected: false };
  if (minCount < 2) return { detected: false };

  // Only confirmed swings — detectSwingPoints already requires ±lookback
  // bars on each side, so any swing it returns from bars[0..=idx-lookback]
  // is causal. Swings inside the last `swingLookback` bars are unconfirmed
  // and excluded.
  const swings = detectSwingPoints(bars.slice(0, idx + 1), swingLookback);
  const swingType: "high" | "low" = direction === "bullish" ? "low" : "high";
  const minIdx = Math.max(0, idx - scanWindow);
  const recent = swings.filter((s) => s.idx >= minIdx && s.type === swingType);

  if (recent.length < minCount) return { detected: false };

  // Greedy cluster search. For each swing taken as a candidate "anchor,"
  // find all swings within `tolerance` of its price. The largest such set
  // is the answer.
  //
  // Tolerance is computed from the candidate anchor's price (not a global
  // constant) because the relative-% interpretation differs at different
  // price levels — at $4000 gold, 0.1% = $4, at $2000 it's $2.
  let bestCluster: SwingPoint[] = [];
  let bestRecency = -1;
  for (const anchor of recent) {
    const tolerance = (anchor.price * tolerancePct) / 100;
    const cluster = recent.filter((s) => Math.abs(s.price - anchor.price) <= tolerance);
    if (cluster.length < minCount) continue;
    // Tie-break by most-recent member's idx (higher = more recent).
    const recency = Math.max(...cluster.map((s) => s.idx));
    if (
      cluster.length > bestCluster.length ||
      (cluster.length === bestCluster.length && recency > bestRecency)
    ) {
      bestCluster = cluster;
      bestRecency = recency;
    }
  }

  if (bestCluster.length < minCount) return { detected: false };

  const sortedCluster = [...bestCluster].sort((a, b) => a.idx - b.idx);
  const avgLevel = sortedCluster.reduce((s, p) => s + p.price, 0) / sortedCluster.length;

  return {
    detected: true,
    details: {
      direction,
      level_type: swingType,
      level: avgLevel,
      count: sortedCluster.length,
      swing_indices: sortedCluster.map((s) => s.idx),
      tolerance_pct: tolerancePct,
    },
  };
}
