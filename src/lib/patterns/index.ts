/**
 * ICT/SMC pattern detection module — barrel export.
 *
 * Detectors are pure functions over PriceBar arrays. None of them touch
 * the database, the broker, or the scan engine yet. Sprint 2 will add a
 * `PatternCondition` type to AlgorithmRules' discriminated union and wire
 * these detectors through the same evaluation pipeline as TechnicalCondition.
 */
export * from "./types";
export { detectSwingPoints, lastSwingBefore } from "./swing-points";
export { detectDailyBias } from "./daily-bias";
export { detectLiquiditySweep } from "./liquidity-sweep";
export {
  detectLiquiditySweepReclaim,
  type LiquiditySweepReclaimDetails,
} from "./liquidity-sweep-reclaim";
export { detectFvg, fvgFillIndex, scanFvgs } from "./fvg";
export { detectBos } from "./bos";
export { detectChoch, type ChochDetails } from "./choch";
export { detectEqualLevels, type EqualLevelsDetails, type EqualLevelsOptions } from "./equal-levels";
export { detectOte, type OteDetails } from "./ote";
export { detectOrderBlock } from "./order-block";
export { detectEngulfing } from "./engulfing";
export { detectPinBar } from "./pin-bar";
export { detectMomentum } from "./momentum";
export { detectInsideBar, type InsideBarDetails } from "./inside-bar";
export { detectOutsideBar, type OutsideBarDetails } from "./outside-bar";
export { detectDoji, type DojiDetails, type DojiOptions } from "./doji";
export {
  detectSessionWindow,
  SESSION_WINDOWS,
  SESSION_WINDOW_NAMES,
} from "./gold-session-window";
export type {
  SessionWindowName,
  SessionWindowDetails,
  SessionWindowOptions,
} from "./gold-session-window";
export { detectAsianRangeBreak } from "./asian-range-break";
export type { AsianRangeBreakDetails } from "./asian-range-break";
export { detectPostNewsWindow } from "./post-news-window";
export type {
  PostNewsWindowDetails,
  PostNewsWindowOptions,
} from "./post-news-window";
export { evaluatePatternCondition, type PatternEvaluationContext } from "./evaluate";
