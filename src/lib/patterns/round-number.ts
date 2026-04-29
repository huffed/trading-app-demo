/**
 * Round-number rejection — detect when the current bar's range tested a
 * round price level (50/100-pip on majors, $5/$50 on gold, etc.) and the
 * close rejected back inside.
 *
 * Why this matters: discretionary traders react heavily to round levels.
 * The friend's actual FTMO trades show ~58% gold concentration; gold
 * trades around $50 / $100 levels almost mechanically. Pure ICT
 * pattern detectors (BOS / OB / FVG) caught only 5% of his entries —
 * round-number rejections are the most likely thing he's reading that
 * we weren't detecting.
 *
 * Bullish rejection: bar.low ≤ level AND bar.close > level.
 *   → buyers stepped in at the round level, price closed back above.
 *
 * Bearish rejection: bar.high ≥ level AND bar.close < level.
 *   → sellers stepped in at the round level, price closed back below.
 *
 * Step granularity: caller-overridable, otherwise derived from current
 * price magnitude (~0.5% of price, snapped to a "nice" power-of-10
 * multiple — 1×10ⁿ, 2×10ⁿ, or 5×10ⁿ). For EUR/USD ~1.07 → 0.005 (50
 * pips). For gold ~5000 → 20.0 ($20). For silver ~30 → 0.10 ($0.10).
 */
import type { PriceBar } from "@/lib/market-data/types";
import type { PatternResult } from "./types";

export interface RoundNumberDetails {
  direction: "bullish" | "bearish";
  /** The round level the bar tested. */
  level: number;
  /** Step size used to detect levels (e.g. 0.005 for EUR/USD = 50 pips). */
  step: number;
  /** How far the wick pushed past the level, in price units. */
  excursion: number;
}

export interface RoundNumberOptions {
  /** Override the auto-derived step. When omitted, the detector picks a
   *  step ≈ 0.5% of the current price snapped to a 1/2/5 × 10ⁿ multiple. */
  step?: number;
  /** Minimum wick excursion past the level (in price units) for the
   *  test to count. Defaults to 0 — any touch qualifies. Set higher
   *  to require a "real" wick rejection rather than a graze. */
  min_excursion?: number;
}

export function detectRoundNumberRejection(
  bars: PriceBar[],
  idx: number,
  options: RoundNumberOptions = {}
): PatternResult<RoundNumberDetails> {
  if (idx < 0 || idx >= bars.length) return { detected: false };
  const bar = bars[idx];
  const step = options.step ?? deriveStepFromPrice(bar.close);
  if (step <= 0) return { detected: false };

  const minExcursion = options.min_excursion ?? 0;

  // Build the small set of round levels that could intersect the bar's
  // range. We snap floor(low) and ceil(high) to the nearest step; an
  // integer-arithmetic walk between them covers everything.
  const startLevel = Math.floor(bar.low / step) * step;
  const endLevel = Math.ceil(bar.high / step) * step;
  const levels: number[] = [];
  for (let lv = startLevel; lv <= endLevel + step / 2; lv += step) {
    levels.push(lv);
    if (levels.length > 16) break; // pathological tape, bail
  }

  for (const level of levels) {
    // Bullish rejection: low pushed at-or-past the level, close back above.
    if (bar.low <= level - minExcursion && bar.close > level) {
      return {
        detected: true,
        details: {
          direction: "bullish",
          level: Number(level.toFixed(8)),
          step,
          excursion: Number((level - bar.low).toFixed(8)),
        },
      };
    }
    // Bearish rejection: high pushed at-or-past, close back below.
    if (bar.high >= level + minExcursion && bar.close < level) {
      return {
        detected: true,
        details: {
          direction: "bearish",
          level: Number(level.toFixed(8)),
          step,
          excursion: Number((bar.high - level).toFixed(8)),
        },
      };
    }
  }
  return { detected: false };
}

/**
 * Heuristic step picker: ~0.5% of price snapped to a "nice" multiple.
 *
 * Examples:
 *   EUR/USD 1.0750 → target 0.0054 → step 0.005   (50 pips)
 *   USD/JPY 151.50 → target 0.7575 → step 0.5     (50 pips)
 *   Gold    5162.0 → target 25.81  → step 20.0    ($20 rungs)
 *   Silver  30.50  → target 0.153  → step 0.1     ($0.10 rungs)
 */
function deriveStepFromPrice(price: number): number {
  if (price <= 0) return 0;
  const target = price / 200;
  const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
  const normalized = target / magnitude;
  // Snap to a 1, 2, or 5 multiple — these match how traders actually
  // think about "round" intervals.
  let nice: number;
  if (normalized < 2) nice = 1;
  else if (normalized < 5) nice = 2;
  else nice = 5;
  return nice * magnitude;
}
