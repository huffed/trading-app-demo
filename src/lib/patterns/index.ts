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
export { detectFvg, fvgFillIndex, scanFvgs } from "./fvg";
export { detectBos } from "./bos";
export { detectOrderBlock } from "./order-block";
export { detectEngulfing } from "./engulfing";
export { detectPinBar } from "./pin-bar";
export { detectMomentum } from "./momentum";
export {
  detectSessionWindow,
  SESSION_WINDOWS,
  SESSION_WINDOW_NAMES,
} from "./session-window";
export type {
  SessionWindowName,
  SessionWindowDetails,
  SessionWindowOptions,
} from "./session-window";
export { detectAsianRangeBreak } from "./asian-range-break";
export type { AsianRangeBreakDetails } from "./asian-range-break";
export { detectPostNewsWindow } from "./post-news-window";
export type {
  PostNewsWindowDetails,
  PostNewsWindowOptions,
} from "./post-news-window";
export { evaluatePatternCondition, type PatternEvaluationContext } from "./evaluate";
