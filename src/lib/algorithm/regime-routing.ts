/**
 * H.6-live-routing — Per-regime parameter merger + scan-time resolver.
 *
 * Given an algo's rules + the current bar's regime (from
 * `classifyRegime`), merges the matching `regime_routing.overrides`
 * entry into a NEW rules object. The base rules object is NEVER
 * mutated.
 *
 * Override semantics (matches the 5 Layer B axes):
 *   - `rr_multiple` → take_profit.value (only when take_profit.type === "rr_multiple")
 *   - `sl_lookback` → stop_loss.lookback (only when stop_loss.type === "swing_anchor")
 *   - `risk_per_trade_pct` → position_sizing.value (only when sizing.type === "risk_per_trade")
 *   - `regime_filter` true/false → regime_filter object set/cleared
 *   - `adx_filter` true/false → adx_filter object set/cleared
 *
 * Type mismatches are silent no-ops for that field — operator can attach
 * regime_routing to a non-Layer-B-shaped algo without crashes; the merger
 * just leaves base values intact for fields it can't safely override.
 *
 * Called by the scan engine (entry-open.ts) before condition evaluation
 * so the resolved rules govern entry geometry + sizing AS IF the algo
 * had been deployed with those parameters from the start. The audit
 * trail (regime_route_switched event) captures both the detected regime
 * and the override fields that were applied.
 */
import type {
  AlgorithmRules,
  RegimeOverride,
  RegimeRouting,
} from "@/types/algorithm";
import type { PriceBar } from "@/lib/market-data/types";
import { classifyRegime, type Regime } from "./regime-classifier";

export interface ResolvedRegimeRules {
  /** Final rules to use for this entry decision. Identical to base when
   *  routing not enabled / no regime detected / no override for regime. */
  rules: AlgorithmRules;
  /** Detected regime, or null if classification couldn't run (pre-lookback). */
  regime: Regime | null;
  /** Whether ANY override field was applied. False when routing disabled,
   *  regime null, regime had no override, or the override's fields were
   *  all type-mismatched with base rules. */
  applied: boolean;
  /** Which override fields ended up being applied (for the audit event
   *  details). Empty when applied=false. */
  applied_fields: (keyof RegimeOverride)[];
}

/** Pure merge — given base rules + a RegimeOverride, returns a new rules
 *  object with the override fields applied where types align. Never
 *  mutates `base`. Returns the list of fields actually applied so the
 *  caller can audit. */
export function applyRegimeOverride(
  base: AlgorithmRules,
  override: RegimeOverride,
): { rules: AlgorithmRules; applied_fields: (keyof RegimeOverride)[] } {
  let next = base;
  const applied: (keyof RegimeOverride)[] = [];

  if (override.rr_multiple != null && base.take_profit.type === "rr_multiple") {
    next = { ...next, take_profit: { ...base.take_profit, value: override.rr_multiple } };
    applied.push("rr_multiple");
  }
  if (
    override.sl_lookback != null &&
    (base.stop_loss as { type?: string }).type === "swing_anchor"
  ) {
    const mergedSL: AlgorithmRules["stop_loss"] = { ...base.stop_loss, lookback: override.sl_lookback };
    next = { ...next, stop_loss: mergedSL };
    applied.push("sl_lookback");
  }
  if (
    override.risk_per_trade_pct != null &&
    base.position_sizing.type === "risk_per_trade"
  ) {
    next = {
      ...next,
      position_sizing: { ...base.position_sizing, value: override.risk_per_trade_pct },
    };
    applied.push("risk_per_trade_pct");
  }
  if (override.regime_filter !== undefined) {
    next = {
      ...next,
      regime_filter: override.regime_filter
        ? { enabled: true, atr_period: 20, lookback_days: 90, percentile_floor: 0.3 }
        : undefined,
    };
    applied.push("regime_filter");
  }
  if (override.adx_filter !== undefined) {
    next = {
      ...next,
      adx_filter: override.adx_filter
        ? { enabled: true, adx_period: 14, min_adx: 20 }
        : undefined,
    };
    applied.push("adx_filter");
  }

  return { rules: next, applied_fields: applied };
}

/** Resolve the effective rules for the current bar. The scan engine
 *  calls this once at entry-decision time + uses the returned `rules`
 *  for all downstream operations (condition evaluation, SL/TP, sizing).
 *  When applied=true, the caller should also emit a
 *  `regime_route_switched` activity_log event with `applied_fields`
 *  + before/after geometry for operator audit. */
export function resolveRulesForCurrentRegime(
  base: AlgorithmRules,
  bars: PriceBar[],
): ResolvedRegimeRules {
  const routing = base.regime_routing;
  if (!routing?.enabled) {
    return { rules: base, regime: null, applied: false, applied_fields: [] };
  }
  if (bars.length === 0) {
    return { rules: base, regime: null, applied: false, applied_fields: [] };
  }
  const regime = classifyRegime(bars, bars.length - 1);
  if (regime == null) {
    return { rules: base, regime: null, applied: false, applied_fields: [] };
  }
  const override = routing.overrides?.[regime];
  if (!override) {
    return { rules: base, regime, applied: false, applied_fields: [] };
  }
  const { rules, applied_fields } = applyRegimeOverride(base, override);
  return {
    rules,
    regime,
    applied: applied_fields.length > 0,
    applied_fields,
  };
}

/** Type guard for the schema in case caller has a raw JSONB blob. */
export function isRegimeRouting(value: unknown): value is RegimeRouting {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { enabled?: unknown }).enabled === "boolean"
  );
}
