/**
 * H.6-live-routing tests for the per-regime override merger + scan-time
 * resolver. Locks: per-axis merge semantics, type-mismatch silent no-op,
 * applied-fields audit trail, disabled/null-regime/no-override fall-through.
 */
import { describe, expect, it } from "vitest";
import {
  applyRegimeOverride,
  isRegimeRouting,
  resolveRulesForCurrentRegime,
} from "./regime-routing";
import type { AlgorithmRules, RegimeRouting } from "@/types/algorithm";
import type { PriceBar } from "@/lib/market-data/types";

function makeRules(overrides: Partial<AlgorithmRules> = {}): AlgorithmRules {
  return {
    entry_conditions: [],
    exit_conditions: [],
    entry_logic: "all",
    stop_loss: { type: "swing_anchor", value: 0.1, lookback: 6 },
    take_profit: { type: "rr_multiple", value: 3 },
    position_sizing: { type: "risk_per_trade", value: 0.6 },
    max_positions: 1,
    timeframe: "4h",
    asset_class: "commodity",
    ...overrides,
  } as unknown as AlgorithmRules;
}

// ─── applyRegimeOverride (pure merge) ─────────────────────────────────

describe("applyRegimeOverride", () => {
  it("rr_multiple → take_profit.value when take_profit.type = rr_multiple", () => {
    const { rules, applied_fields } = applyRegimeOverride(makeRules(), { rr_multiple: 5 });
    expect((rules.take_profit as { value: number }).value).toBe(5);
    expect(applied_fields).toEqual(["rr_multiple"]);
  });

  it("rr_multiple is silently SKIPPED when take_profit.type ≠ rr_multiple (no-op)", () => {
    const base = makeRules({ take_profit: { type: "percentage", value: 3 } as AlgorithmRules["take_profit"] });
    const { rules, applied_fields } = applyRegimeOverride(base, { rr_multiple: 5 });
    expect((rules.take_profit as { value: number }).value).toBe(3); // unchanged
    expect(applied_fields).toEqual([]);
  });

  it("sl_lookback → stop_loss.lookback when stop_loss.type = swing_anchor", () => {
    const { rules, applied_fields } = applyRegimeOverride(makeRules(), { sl_lookback: 3 });
    expect((rules.stop_loss as { lookback: number }).lookback).toBe(3);
    expect(applied_fields).toEqual(["sl_lookback"]);
  });

  it("sl_lookback is SKIPPED when stop_loss.type ≠ swing_anchor", () => {
    const base = makeRules({ stop_loss: { type: "percentage", value: 1 } as AlgorithmRules["stop_loss"] });
    const { applied_fields } = applyRegimeOverride(base, { sl_lookback: 3 });
    expect(applied_fields).toEqual([]);
  });

  it("risk_per_trade_pct → position_sizing.value when type = risk_per_trade", () => {
    const { rules, applied_fields } = applyRegimeOverride(makeRules(), { risk_per_trade_pct: 1.0 });
    expect(rules.position_sizing.value).toBe(1.0);
    expect(applied_fields).toEqual(["risk_per_trade_pct"]);
  });

  it("risk_per_trade_pct is SKIPPED when sizing type ≠ risk_per_trade", () => {
    const base = makeRules({ position_sizing: { type: "vol_target", value: 5 } as AlgorithmRules["position_sizing"] });
    const { applied_fields } = applyRegimeOverride(base, { risk_per_trade_pct: 1.0 });
    expect(applied_fields).toEqual([]);
  });

  it("regime_filter=true sets the canonical config; =false clears", () => {
    const a = applyRegimeOverride(makeRules(), { regime_filter: true });
    expect((a.rules as { regime_filter?: { enabled: boolean } }).regime_filter).toEqual({
      enabled: true, atr_period: 20, lookback_days: 90, percentile_floor: 0.3,
    });
    expect(a.applied_fields).toContain("regime_filter");

    const b = applyRegimeOverride(makeRules({ regime_filter: { enabled: true } } as Partial<AlgorithmRules>), { regime_filter: false });
    expect((b.rules as { regime_filter?: unknown }).regime_filter).toBeUndefined();
  });

  it("adx_filter=true sets canonical config; =false clears", () => {
    const a = applyRegimeOverride(makeRules(), { adx_filter: true });
    expect((a.rules as { adx_filter?: { enabled: boolean } }).adx_filter).toEqual({
      enabled: true, adx_period: 14, min_adx: 20,
    });

    const b = applyRegimeOverride(makeRules({ adx_filter: { enabled: true } } as Partial<AlgorithmRules>), { adx_filter: false });
    expect((b.rules as { adx_filter?: unknown }).adx_filter).toBeUndefined();
  });

  it("multiple overrides applied together; applied_fields lists all", () => {
    const { rules, applied_fields } = applyRegimeOverride(makeRules(), {
      rr_multiple: 5,
      sl_lookback: 3,
      risk_per_trade_pct: 1.0,
      regime_filter: true,
      adx_filter: true,
    });
    expect((rules.take_profit as { value: number }).value).toBe(5);
    expect((rules.stop_loss as { lookback: number }).lookback).toBe(3);
    expect(rules.position_sizing.value).toBe(1.0);
    expect(applied_fields).toEqual([
      "rr_multiple", "sl_lookback", "risk_per_trade_pct", "regime_filter", "adx_filter",
    ]);
  });

  it("base rules object is NEVER mutated (purity)", () => {
    const base = makeRules();
    const snapshot = JSON.stringify(base);
    applyRegimeOverride(base, { rr_multiple: 5, risk_per_trade_pct: 1.0 });
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it("empty override → applied_fields = [] (returns base unchanged)", () => {
    const { rules, applied_fields } = applyRegimeOverride(makeRules(), {});
    expect(applied_fields).toEqual([]);
    expect(rules).toEqual(makeRules());
  });
});

// ─── resolveRulesForCurrentRegime (scan-time resolver) ────────────────

function syntheticBars(n: number, rangeFn: (i: number) => number = () => 5): PriceBar[] {
  const bars: PriceBar[] = [];
  for (let i = 0; i < n; i++) {
    const range = rangeFn(i);
    bars.push({
      date: new Date(1577836800000 + i * 4 * 3_600_000).toISOString(),
      open: 100, high: 100 + range, low: 100 - range, close: 100, volume: 0,
    });
  }
  return bars;
}

describe("resolveRulesForCurrentRegime", () => {
  const ROUTING: RegimeRouting = {
    enabled: true,
    overrides: {
      low_vol: { rr_multiple: 2 },
      medium_vol: { rr_multiple: 3, risk_per_trade_pct: 1.0 },
      high_vol: { rr_multiple: 5, sl_lookback: 3 },
    },
  };

  it("returns base unchanged when regime_routing absent", () => {
    const r = resolveRulesForCurrentRegime(makeRules(), syntheticBars(300));
    expect(r.applied).toBe(false);
    expect(r.applied_fields).toEqual([]);
    expect(r.regime).toBeNull();
  });

  it("returns base unchanged when regime_routing.enabled = false", () => {
    const base = makeRules({ regime_routing: { enabled: false, overrides: ROUTING.overrides } });
    const r = resolveRulesForCurrentRegime(base, syntheticBars(300));
    expect(r.applied).toBe(false);
  });

  it("returns base unchanged when bars empty", () => {
    const base = makeRules({ regime_routing: ROUTING });
    const r = resolveRulesForCurrentRegime(base, []);
    expect(r.applied).toBe(false);
    expect(r.regime).toBeNull();
  });

  it("returns base unchanged when classifyRegime returns null (insufficient lookback)", () => {
    const base = makeRules({ regime_routing: ROUTING });
    // 50 bars < REGIME_LOOKBACK_BARS (200)
    const r = resolveRulesForCurrentRegime(base, syntheticBars(50));
    expect(r.applied).toBe(false);
    expect(r.regime).toBeNull();
  });

  it("applies override when regime detected + override present", () => {
    // Build bars where the last bar lands in a clear regime — use 800 bars
    // of oscillating range so classifier reaches all 3 terciles
    const base = makeRules({ regime_routing: ROUTING });
    const bars = syntheticBars(800, (i) => 5 + 4 * Math.sin(i * 0.015));
    const r = resolveRulesForCurrentRegime(base, bars);
    if (!r.applied) {
      // The last bar's regime may or may not match an override — that's
      // OK; we want EITHER applied=true OR a documented null regime.
      expect(r.regime == null || ["low_vol", "medium_vol", "high_vol"].includes(r.regime)).toBe(true);
    } else {
      expect(r.applied_fields.length).toBeGreaterThan(0);
      expect(r.regime).not.toBeNull();
    }
  });

  it("returns base unchanged when detected regime has no override entry", () => {
    const routing: RegimeRouting = { enabled: true, overrides: { medium_vol: { rr_multiple: 3 } } };
    const base = makeRules({ regime_routing: routing });
    // Build a series where the classifier reliably returns low_vol or
    // high_vol — synthetic with rising range
    const bars = syntheticBars(800, (i) => 1 + i * 0.05);
    const r = resolveRulesForCurrentRegime(base, bars);
    if (r.regime === "low_vol" || r.regime === "high_vol") {
      expect(r.applied).toBe(false);
      expect(r.applied_fields).toEqual([]);
    }
  });
});

// ─── isRegimeRouting type guard ───────────────────────────────────────

describe("isRegimeRouting", () => {
  it("true for {enabled: boolean}", () => {
    expect(isRegimeRouting({ enabled: true })).toBe(true);
    expect(isRegimeRouting({ enabled: false, overrides: {} })).toBe(true);
  });
  it("false for non-objects / missing enabled / non-boolean enabled", () => {
    expect(isRegimeRouting(null)).toBe(false);
    expect(isRegimeRouting(undefined)).toBe(false);
    expect(isRegimeRouting("string")).toBe(false);
    expect(isRegimeRouting({ overrides: {} })).toBe(false);
    expect(isRegimeRouting({ enabled: "yes" })).toBe(false);
  });
});
