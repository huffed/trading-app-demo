/**
 * Layer B geometry-sweep enumerator.
 *
 * Given a base candidate (a Layer A per-candidate-passing row), produces 96
 * variant rows covering the full cartesian product of geometry axes from
 * spec §2:
 *   rr_multiple × sl_lookback × risk_per_trade × regime_filter × adx_filter
 *   = 4 × 3 × 2 × 2 × 2 = 96 variants
 *
 * Used by:
 *   - scripts/canonical/algo-search.ts (Layer B driver)
 *   - src/lib/algo-search/state.ts (frontend Layer B section, future)
 *
 * Naming: variants use a DIFFERENT prefix (`LayerB:`) than Layer A (`Search:`)
 * so the two namespaces don't collide in `LIKE 'Search:%'` queries. The
 * variant name embeds a back-pointer to the base + a compact 5-axis tag:
 *   "LayerB: <base body> | <rr_X_lb_Y_r_Z_rf_0/1_af_0/1>"
 *   e.g. "LayerB: XAU/USD BOS-Long 4h | rr3_lb4_r1_rf1_af0"
 *
 * Geometry application preserves the base's non-geometry fields (asset_class,
 * leverage, entry_conditions, exit_conditions, max_positions, etc.) — only
 * the 5 geometry axes mutate. This isolates the experimental variable.
 */
import type { AlgorithmRules } from "@/types/algorithm";

export const LAYER_B_NAME_PREFIX = "LayerB:";

/** Layer B axis 1 — RR multiple for take_profit. Spec §2 Layer B. */
export const RR_MULTIPLES = [2, 2.5, 3, 5] as const;
/** Layer B axis 2 — swing lookback for swing_anchor stop_loss. */
export const SL_LOOKBACKS = [3, 4, 6] as const;
/** Layer B axis 3 — risk_per_trade_pct for position sizing. */
export const RISK_PCTS = [0.6, 1.0] as const;
/** Layer B axis 4 — regime_filter on/off (ATR-percentile gate). */
export const REGIME_FILTER_VARIANTS = [false, true] as const;
/** Layer B axis 5 — adx_filter on/off (trend-strength gate). */
export const ADX_FILTER_VARIANTS = [false, true] as const;

export type RrMultiple = (typeof RR_MULTIPLES)[number];
export type SlLookback = (typeof SL_LOOKBACKS)[number];
export type RiskPct = (typeof RISK_PCTS)[number];

export interface LayerBGeometry {
  rr_multiple: RrMultiple;
  sl_lookback: SlLookback;
  risk_per_trade_pct: RiskPct;
  regime_filter: boolean;
  adx_filter: boolean;
}

/** A Layer B variant carries the same shape as a Layer A SearchCandidate
 *  for insert/watchlist re-use, plus the back-pointer + geometry record
 *  for downstream analysis. Insertable types implement {name, ticker,
 *  capital, rules}; the rest is metadata. */
export interface LayerBVariant {
  name: string;
  base_name: string;
  variant_tag: string;
  geometry: LayerBGeometry;
  capital: number;
  rules: AlgorithmRules;
  ticker: string;
}

/** Compact tag for a geometry — fits in algo names + DB cell_key. Numeric
 *  values use `.replace('.', '')` for filename-safety (e.g. rr2.5 → rr25).
 *  No spaces — names render in `pg LIKE` queries + log lines cleanly. */
export function geometryTag(g: LayerBGeometry): string {
  const rr = String(g.rr_multiple).replace(".", "");
  const r = String(g.risk_per_trade_pct).replace(".", "");
  return `rr${rr}_lb${g.sl_lookback}_r${r}_rf${g.regime_filter ? 1 : 0}_af${g.adx_filter ? 1 : 0}`;
}

/** Apply geometry overrides to base rules. Preserves all non-geometry fields
 *  (entry_conditions, asset_class, leverage, prop_firm, stagnant_exit, etc.)
 *  to isolate the geometry variable. Filters off when the variant axis is
 *  `false`; on when `true` (with conservative default params matching the
 *  Layer A enumerator's gate-config conventions). */
function applyGeometry(baseRules: AlgorithmRules, g: LayerBGeometry): AlgorithmRules {
  return {
    ...baseRules,
    stop_loss: { ...baseRules.stop_loss, lookback: g.sl_lookback },
    take_profit: { ...baseRules.take_profit, value: g.rr_multiple },
    position_sizing: { ...baseRules.position_sizing, value: g.risk_per_trade_pct },
    regime_filter: g.regime_filter
      ? { enabled: true, atr_period: 20, lookback_days: 90, percentile_floor: 0.3 }
      : undefined,
    adx_filter: g.adx_filter
      ? { enabled: true, adx_period: 14, min_adx: 20 }
      : undefined,
  };
}

export interface BaseInput {
  /** Layer A name, e.g. "Search: XAU/USD BOS-Long 4h". */
  name: string;
  ticker: string;
  capital: number;
  rules: AlgorithmRules;
}

/** Strip the canonical Layer A "Search:" prefix (with optional space) from
 *  the base name so the LayerB-prefixed name reads cleanly. Returns the
 *  body without re-introducing the prefix. */
function baseBody(name: string): string {
  return name.replace(/^Search:\s*/, "");
}

/** Enumerate every Layer B variant for a single base candidate. Returns
 *  exactly `layerBCardinality()` rows (96). */
export function enumerateLayerBVariants(base: BaseInput): LayerBVariant[] {
  const out: LayerBVariant[] = [];
  const body = baseBody(base.name);
  for (const rr of RR_MULTIPLES) {
    for (const lb of SL_LOOKBACKS) {
      for (const risk of RISK_PCTS) {
        for (const rf of REGIME_FILTER_VARIANTS) {
          for (const af of ADX_FILTER_VARIANTS) {
            const geometry: LayerBGeometry = {
              rr_multiple: rr,
              sl_lookback: lb,
              risk_per_trade_pct: risk,
              regime_filter: rf,
              adx_filter: af,
            };
            const tag = geometryTag(geometry);
            out.push({
              name: `${LAYER_B_NAME_PREFIX} ${body} | ${tag}`,
              base_name: base.name,
              variant_tag: tag,
              geometry,
              capital: base.capital,
              ticker: base.ticker,
              rules: applyGeometry(base.rules, geometry),
            });
          }
        }
      }
    }
  }
  return out;
}

/** Fixed 96 per spec §2. Verified by layer-b-enumerate.test.ts. */
export function layerBCardinality(): number {
  return (
    RR_MULTIPLES.length *
    SL_LOOKBACKS.length *
    RISK_PCTS.length *
    REGIME_FILTER_VARIANTS.length *
    ADX_FILTER_VARIANTS.length
  );
}
