/**
 * Market-state primitive types — extracted into `src/types/` as part of
 * CB.M4 (2026-06-19 EVE) so the type system stays leaf-shaped: types
 * never depend on lib code at the type layer. Runtime computation lives
 * in `src/lib/market-data/market-state.ts` (which re-imports these).
 *
 * Background: the 2026-06-11 market-state study (PR #188) defined these
 * to capture leading regime indicators that DON'T look ahead. They feed
 * the `market_state_gate` and live shadow logger. See
 * `lib/market-data/market-state.ts` for the math + DOWNSHIFT_CANDIDATE_STATES.
 */

export type StructRegime = "HH" | "LH" | "RANGING";

export type MtfState =
  | "aligned_HH"
  | "aligned_LH"
  | "ranging_all"
  | "fast_div_bull"
  | "fast_div_bear"
  | "mixed"
  | "n/a";

export type VolState = "low" | "mid" | "high" | "n/a";

export type RangeState = "compressed" | "normal" | "expanded" | "n/a";

export type DxyState = "usd_up" | "usd_down" | "usd_flip" | "n/a";

export interface MarketState {
  /** 1h/4h/D1 structure alignment. */
  mtf: MtfState;
  /** ATR(14) percentile vs trailing ~1y of 4h bars. */
  vol: VolState;
  /** 20-bar range width percentile vs trailing 500 bars. */
  range: RangeState;
  /** USD trend via EUR/USD 4h 20-bar slope (EUR up = USD down). */
  dxy: DxyState;
}
