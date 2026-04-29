/**
 * Momentum continuation detector — fires when recent N bars have moved
 * IN the named trade direction by at least `min_size_atr` (cumulative,
 * in ATR units).
 *
 * Why this matters: feature dump split by trade direction
 * (scripts/feature-dump-friend-trades.ts) flipped the original "pullback
 * trader" hypothesis. His wins enter ON momentum, not against it:
 *   long wins  : 3-bar impulse median +0.18 ATR (mean +0.25)
 *   short wins : 3-bar impulse median -0.72 ATR (mean -0.82)
 * Both directions favour continuation. Earlier combined-direction
 * median of -0.25 was an artefact of more shorts than longs in the
 * dataset — it didn't represent a coherent strategy.
 *
 * Bullish momentum (long-entry setup): cumulative close-open over last
 *   N bars sums to ≥ +min_size_atr × ATR. Price has driven up; we'd
 *   buy expecting the move to continue.
 *
 * Bearish momentum (short-entry setup): cumulative close-open over last
 *   N bars sums to ≤ -min_size_atr × ATR. Price has driven down; we'd
 *   sell expecting follow-through.
 *
 * Defaults: lookback=3, min_size_atr=0.2 ATR. Asymmetric in the data
 * (shorts show 3x stronger impulse than longs) but a single threshold
 * is sensible — the d1_bias filter handles directional asymmetry, and
 * 0.2 lands above long-loss median (0.03) and below long-win mean (0.25).
 */
import { computeAtr } from "@/lib/market-data/regime-filter";
import type { PriceBar } from "@/lib/market-data/types";
import type { PatternResult } from "./types";

export interface MomentumDetails {
  direction: "bullish" | "bearish";
  /** Cumulative in-direction move over the lookback in ATR units.
   *  Always positive — sign is encoded in `direction`. */
  momentum_size_atr: number;
  /** ATR(period) at the entry bar. Surfaced so callers can size SL
   *  off the impulse magnitude when relevant. */
  atr: number;
  /** How many of the lookback bars individually moved in-direction
   *  (close > open for bullish, close < open for bearish). 3-of-3 is
   *  a stronger signal than 2-of-3 with one big counter-bar. */
  consecutive_bars: number;
}

export interface MomentumOptions {
  /** Bars to evaluate. Default 3 — matches the feature analysis. */
  lookback?: number;
  /** Minimum cumulative in-direction move (in ATR units). Default 0.2
   *  — calibrated against friend's long-win mean (+0.25) so most long
   *  wins clear; shorts have far stronger impulse so they all fire. */
  min_size_atr?: number;
  /** ATR period. Default 14 — same as the rest of the gating stack. */
  atr_period?: number;
}

const DEFAULTS = {
  lookback: 3,
  min_size_atr: 0.2,
  atr_period: 14,
} as const;

export function detectMomentum(
  bars: PriceBar[],
  idx: number,
  options: MomentumOptions = {}
): PatternResult<MomentumDetails> {
  const lookback = options.lookback ?? DEFAULTS.lookback;
  const minSizeAtr = options.min_size_atr ?? DEFAULTS.min_size_atr;
  const atrPeriod = options.atr_period ?? DEFAULTS.atr_period;

  if (idx < lookback - 1 || idx >= bars.length) return { detected: false };
  if (idx < atrPeriod) return { detected: false };

  const atrSeries = computeAtr(bars.slice(0, idx + 1), atrPeriod);
  const atr = atrSeries[idx];
  if (!atr || atr <= 0) return { detected: false };

  const window = bars.slice(idx - lookback + 1, idx + 1);
  const netMove = window.reduce((sum, b) => sum + (b.close - b.open), 0);
  const sizeAtr = netMove / atr;

  if (sizeAtr >= minSizeAtr) {
    const consec = window.filter((b) => b.close > b.open).length;
    return {
      detected: true,
      details: {
        direction: "bullish",
        momentum_size_atr: Number(sizeAtr.toFixed(4)),
        atr: Number(atr.toFixed(8)),
        consecutive_bars: consec,
      },
    };
  }
  if (sizeAtr <= -minSizeAtr) {
    const consec = window.filter((b) => b.close < b.open).length;
    return {
      detected: true,
      details: {
        direction: "bearish",
        momentum_size_atr: Number((-sizeAtr).toFixed(4)),
        atr: Number(atr.toFixed(8)),
        consecutive_bars: consec,
      },
    };
  }
  return { detected: false };
}
