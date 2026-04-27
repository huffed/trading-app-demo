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
