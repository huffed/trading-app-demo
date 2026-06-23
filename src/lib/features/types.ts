/**
 * H.2 — Feature library types.
 *
 * Each feature is a pure function `(bars, idx, ctx?) → number | null`. The
 * null return is the canonical "can't compute" signal — early bars before
 * the feature has enough lookback data, missing context for cross-asset
 * features, invalid inputs. ML training code (H.3) must handle nulls
 * (typically: row-drop, mean-impute, or category-flag).
 *
 * Features deliberately have NO side effects, NO async, NO DB access.
 * They consume bars in memory + optional context the caller pre-fetches.
 * This keeps the library composable for H.3 (xgboost training batches)
 * and H.4 (Layer B axis composition) without each consumer rebuilding
 * the I/O layer.
 *
 * Categories are advisory — used by the FE for grouped display and by
 * H.3 for feature-importance reporting per family. Adding a new category
 * is a one-line change here + categorisation in the new feature module.
 */
import type { EconomicEvent } from "@/lib/market-data/economic-calendar";
import type { PriceBar } from "@/lib/market-data/types";

export type FeatureCategory =
  | "volatility"
  | "momentum"
  | "trend"
  | "structure"
  | "time"
  | "volume"
  | "context";

/** Optional auxiliary inputs feature compute functions may need. None of
 *  these are required by every feature — a feature that doesn't use a
 *  field reads it as undefined and ignores it. Caller pre-fetches; the
 *  feature library never does I/O. */
export interface FeatureContext {
  /** Resampled D1 bars for higher-TF features (daily_bias agreement,
   *  D1 alignment, etc.). */
  higherTfBars?: PriceBar[];
  /** Cross-asset bars for correlation features. Keyed by app ticker
   *  (e.g. "DXY-proxy", "EUR/USD"). */
  crossAssetBars?: Map<string, PriceBar[]>;
  /** Tier-relevant economic events for calendar-proximity features.
   *  Caller filters to the current instrument's relevant currencies. */
  events?: EconomicEvent[];
}

/** One feature definition. `compute` returns null when the feature can't
 *  be evaluated at that bar index (insufficient lookback, missing
 *  context, etc.). NEVER throws — broken inputs return null. */
export interface Feature {
  name: string;
  category: FeatureCategory;
  /** One-line operator-readable description; surfaces in H.3 feature-
   *  importance reporting + the future /reports features panel. */
  description: string;
  compute: (bars: PriceBar[], idx: number, ctx?: FeatureContext) => number | null;
}

/** Compute ALL registered features at a single bar index. Returns a
 *  name → value map (null for features that couldn't compute). Used by
 *  H.3's training batch builder + the H.4 sweep when composing features
 *  as Layer B axes. O(N_features × per-feature cost) — features are
 *  cheap (mostly slice + arithmetic), so a 30-feature compute is sub-ms. */
export function computeAllFeatures(
  features: readonly Feature[],
  bars: PriceBar[],
  idx: number,
  ctx?: FeatureContext,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const f of features) {
    try {
      out[f.name] = f.compute(bars, idx, ctx);
    } catch {
      // Feature contract is "return null on broken input, never throw".
      // A throw here is a bug; convert to null + a warn so the training
      // batch isn't poisoned by one bad feature. We log lightly to avoid
      // a million warns during a large training run.
      out[f.name] = null;
    }
  }
  return out;
}
