/**
 * Trailing stop + breakeven SL move logic.
 *
 * Used by both the backtest engine and the live scan engine to compute
 * the current effective SL price for an open position based on its
 * MFE (max favourable excursion) since entry.
 *
 * Two layers, both optional and additive:
 *
 *   - Breakeven move: once MFE crosses `trigger_at_r`, the SL ratchets
 *     up (long) / down (short) to the entry price. Removes the original
 *     loss potential entirely.
 *
 *   - Trailing stop: once MFE crosses `activate_at_r`, the SL trails at
 *     `trail_distance_r` behind the favourable extreme (not the current
 *     price — the EXTREME, so the trail never backsteps even on a
 *     pullback before the trail fires).
 *
 * Layered: breakeven moves the SL to entry; trailing then moves it
 * further toward the favourable extreme as MFE grows. Final SL is the
 * MAX (long) / MIN (short) of the candidates so the SL never moves
 * adversely.
 *
 * Why this exists: 1h gold momentum templates (Candidates C/D/E) have
 * 0% TP-hit rate over hundreds of backtested trades — TP at 3.6% is
 * structurally unreachable in normal volatility. Trailing stops let
 * positions ride sustained moves and lock in profit when the trend
 * exhausts, replacing the never-firing TP as the actual profit-taking
 * mechanism.
 */
import type { AlgorithmRules } from "@/types/algorithm";

export interface TrailingState {
  /** Initial SL price computed from rules.stop_loss at entry. Stays
   *  constant; new candidates are compared against it for ratchet
   *  semantics (we never move SL adversely from this baseline). */
  initialSlPrice: number;
  /** Current effective SL price after all ratchets. Updated on each
   *  bar by `computeTrailedSlPrice`. */
  currentSlPrice: number;
  /** Max favourable excursion in price terms, tracked as the highest
   *  high (long) or lowest low (short) the position has touched since
   *  entry. Updated on each bar BEFORE the SL recompute. */
  mfePriceFavorable: number;
  /** ATR(14) at entry bar — captured once, used by the ATR-variant of
   *  trailing_stop. undefined when not computed; ATR-variant rules
   *  silently skip in that case. */
  initialAtr?: number;
}

export interface UpdateTrailingInput {
  side: "long" | "short";
  entryPrice: number;
  initialSlDistance: number; // 1R, in price units
  currentBar: { high: number; low: number };
  state: TrailingState;
  trailingStop?: AlgorithmRules["trailing_stop"];
  breakevenMove?: AlgorithmRules["breakeven_move"];
}

/**
 * Update MFE based on the current bar, then compute the new effective
 * SL given trailing/breakeven config. Returns the updated state. Pure
 * — caller stores the result on the position struct.
 */
export function updateTrailingState(input: UpdateTrailingInput): TrailingState {
  const {
    side,
    entryPrice,
    initialSlDistance,
    currentBar,
    state,
    trailingStop,
    breakevenMove,
  } = input;

  // Step 1: update MFE based on bar's favourable extreme.
  const newMfe =
    side === "long"
      ? Math.max(state.mfePriceFavorable, currentBar.high)
      : Math.min(state.mfePriceFavorable, currentBar.low);

  // Step 2: compute MFE in R units.
  const mfeR =
    side === "long"
      ? (newMfe - entryPrice) / initialSlDistance
      : (entryPrice - newMfe) / initialSlDistance;

  // Step 3: candidate SL prices from breakeven + trailing layers.
  const candidates: number[] = [state.currentSlPrice];

  if (breakevenMove?.enabled) {
    const triggerR = breakevenMove.trigger_at_r ?? 1;
    if (mfeR >= triggerR) {
      candidates.push(entryPrice);
    }
  }

  if (trailingStop?.enabled) {
    // ATR-variant takes precedence when either ATR-field is set AND
    // initialAtr is available on the state. Falls back to R-variant
    // (or skips silently if neither path can compute).
    const useAtr =
      (trailingStop.activate_at_atr !== undefined ||
        trailingStop.trail_distance_atr !== undefined) &&
      state.initialAtr !== undefined &&
      state.initialAtr > 0;
    if (useAtr) {
      const initialAtr = state.initialAtr as number;
      const activateAtr = trailingStop.activate_at_atr ?? 0.5;
      const mfeAtr =
        side === "long"
          ? (newMfe - entryPrice) / initialAtr
          : (entryPrice - newMfe) / initialAtr;
      if (mfeAtr >= activateAtr) {
        const trailDistance = (trailingStop.trail_distance_atr ?? 1) * initialAtr;
        const trailedSl = side === "long" ? newMfe - trailDistance : newMfe + trailDistance;
        candidates.push(trailedSl);
      }
    } else {
      const activateR = trailingStop.activate_at_r ?? 0.5;
      if (mfeR >= activateR) {
        const trailDistance = (trailingStop.trail_distance_r ?? 1) * initialSlDistance;
        const trailedSl = side === "long" ? newMfe - trailDistance : newMfe + trailDistance;
        candidates.push(trailedSl);
      }
    }
  }

  // Step 4: pick the most favourable candidate (highest for long, lowest
  // for short) but never adverse to the position. The MAX/MIN selection
  // gives us the ratchet — SL only moves toward the favourable side.
  const newSl = side === "long" ? Math.max(...candidates) : Math.min(...candidates);

  return {
    initialSlPrice: state.initialSlPrice,
    currentSlPrice: newSl,
    mfePriceFavorable: newMfe,
    initialAtr: state.initialAtr,
  };
}

/**
 * Initialise a TrailingState for a newly-opened position. MFE starts
 * at the entry price (no favourable excursion yet); current SL is the
 * computed initial SL.
 */
export function initTrailingState(input: {
  entryPrice: number;
  initialSlPrice: number;
  /** ATR(14) at entry bar — captured once, persisted on the trailing
   *  state for the ATR-variant of trailing_stop. Optional; ATR-variant
   *  rules silently skip when undefined. */
  initialAtr?: number;
}): TrailingState {
  return {
    initialSlPrice: input.initialSlPrice,
    currentSlPrice: input.initialSlPrice,
    mfePriceFavorable: input.entryPrice,
    initialAtr: input.initialAtr,
  };
}

/** Convenience — true if any trailing/breakeven feature is enabled. */
export function trailingFeaturesEnabled(rules: AlgorithmRules): boolean {
  return Boolean(rules.trailing_stop?.enabled || rules.breakeven_move?.enabled);
}
