/**
 * Feature library registry (H.2). Single import for ML training (H.3),
 * feature-importance reporting (H.3), Layer B axis composition (H.4),
 * and the future /reports features panel.
 *
 * Total: 34 features across 7 categories (≥30 satisfies the H.2 gate).
 *   volatility:  8
 *   momentum:    6
 *   trend:       6
 *   structure:   5
 *   time:        4
 *   volume:      2
 *   context:     3
 *
 * To add a feature:
 *   1. Add the Feature object to its category module
 *   2. Add it to that module's exported readonly array
 *   3. Verify FEATURES below picks it up (it spreads the category arrays)
 *   4. Add a unit test in the matching .test.ts
 */
import { CONTEXT_FEATURES } from "./context";
import { MOMENTUM_FEATURES } from "./momentum";
import { PATTERN_FEATURES } from "./patterns";
import { STRUCTURE_FEATURES } from "./structure";
import { TIME_FEATURES } from "./time";
import { TREND_FEATURES } from "./trend";
import { VOLATILITY_FEATURES } from "./volatility";
import { VOLUME_FEATURES } from "./volume";
import type { Feature, FeatureCategory } from "./types";

export { computeAllFeatures } from "./types";
export type { Feature, FeatureCategory, FeatureContext } from "./types";

/** Single source of truth — every feature registered, ordered for
 *  reproducible iteration. H.3 training batch + feature importance
 *  rely on this ordering being stable across runs. */
export const FEATURES: readonly Feature[] = [
  ...VOLATILITY_FEATURES,
  ...MOMENTUM_FEATURES,
  ...TREND_FEATURES,
  ...STRUCTURE_FEATURES,
  ...TIME_FEATURES,
  ...VOLUME_FEATURES,
  ...CONTEXT_FEATURES,
  ...PATTERN_FEATURES,
];

/** Convenience grouping for the FE/reports surface. */
export const FEATURES_BY_CATEGORY: Record<FeatureCategory, readonly Feature[]> = {
  volatility: VOLATILITY_FEATURES,
  momentum: MOMENTUM_FEATURES,
  trend: TREND_FEATURES,
  structure: STRUCTURE_FEATURES,
  time: TIME_FEATURES,
  volume: VOLUME_FEATURES,
  context: CONTEXT_FEATURES,
  pattern: PATTERN_FEATURES,
};

/** Total count. Asserted by tests at ≥30 (the H.2 gate). */
export const FEATURE_COUNT = FEATURES.length;
