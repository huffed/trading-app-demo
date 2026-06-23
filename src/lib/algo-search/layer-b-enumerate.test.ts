/**
 * Layer B enumerator tests. Locks the cardinality (96) + name format +
 * geometry application semantics so any future axis change surfaces as a
 * failing test.
 */
import { describe, expect, it } from "vitest";
import type { AlgorithmRules } from "@/types/algorithm";
import {
  ADX_FILTER_VARIANTS,
  enumerateLayerBVariants,
  geometryTag,
  LAYER_B_NAME_PREFIX,
  layerBCardinality,
  REGIME_FILTER_VARIANTS,
  RISK_PCTS,
  RR_MULTIPLES,
  SL_LOOKBACKS,
} from "./layer-b-enumerate";

const FAKE_BASE_RULES: AlgorithmRules = {
  entry_conditions: [
    { type: "pattern", pattern: "bos", direction: "bullish", timeframe: "4h" },
  ],
  entry_logic: "all",
  exit_conditions: [],
  stop_loss: { type: "swing_anchor", value: 0.1, lookback: 4 },
  take_profit: { type: "rr_multiple", value: 3 },
  position_sizing: { type: "risk_per_trade", value: 1.0 },
  max_positions: 1,
  max_per_ticker: 1,
  leverage: 50,
  timeframe: "4h",
  asset_class: "commodity",
  side: "long",
  prop_firm: {
    daily_loss_limit: 5, max_drawdown: 10, profit_target: 10,
    max_consecutive_losses: 0, consecutive_loss_daily_halt: 2, consistency_rule: 0,
    slippage_bps: 0.5, commission_pct: 0, spread_bps: 0.4, commission_per_lot: 0,
    combined_risk_cap_pct: 4,
  },
  stagnant_exit: { enabled: true },
};

const FAKE_BASE = {
  name: "Search: XAU/USD BOS-Long 4h",
  ticker: "XAU/USD",
  capital: 10000,
  rules: FAKE_BASE_RULES,
};

describe("Layer B enumerator", () => {
  it("layerBCardinality = 96 (4 RR × 3 lb × 2 risk × 2 regime × 2 adx)", () => {
    expect(layerBCardinality()).toBe(96);
    expect(RR_MULTIPLES.length).toBe(4);
    expect(SL_LOOKBACKS.length).toBe(3);
    expect(RISK_PCTS.length).toBe(2);
    expect(REGIME_FILTER_VARIANTS.length).toBe(2);
    expect(ADX_FILTER_VARIANTS.length).toBe(2);
  });

  it("enumerates exactly 96 variants per base", () => {
    const variants = enumerateLayerBVariants(FAKE_BASE);
    expect(variants).toHaveLength(96);
  });

  it("each variant name starts with LAYER_B_NAME_PREFIX (clean namespace)", () => {
    const variants = enumerateLayerBVariants(FAKE_BASE);
    expect(variants.every((v) => v.name.startsWith(`${LAYER_B_NAME_PREFIX} `))).toBe(true);
  });

  it("variant names DO NOT start with Search: (Layer A namespace)", () => {
    const variants = enumerateLayerBVariants(FAKE_BASE);
    expect(variants.every((v) => !v.name.startsWith("Search:"))).toBe(true);
  });

  it("each variant carries the base_name back-pointer + variant_tag", () => {
    const variants = enumerateLayerBVariants(FAKE_BASE);
    expect(variants.every((v) => v.base_name === FAKE_BASE.name)).toBe(true);
    expect(variants.every((v) => v.variant_tag.length > 0)).toBe(true);
  });

  it("all variant names + tags are unique within a base", () => {
    const variants = enumerateLayerBVariants(FAKE_BASE);
    const names = new Set(variants.map((v) => v.name));
    const tags = new Set(variants.map((v) => v.variant_tag));
    expect(names.size).toBe(variants.length);
    expect(tags.size).toBe(variants.length);
  });

  it("geometry axes appear in expected cardinality (each axis covers full range)", () => {
    const variants = enumerateLayerBVariants(FAKE_BASE);
    const rrSet = new Set(variants.map((v) => v.geometry.rr_multiple));
    const lbSet = new Set(variants.map((v) => v.geometry.sl_lookback));
    const riskSet = new Set(variants.map((v) => v.geometry.risk_per_trade_pct));
    expect(rrSet.size).toBe(4);
    expect(lbSet.size).toBe(3);
    expect(riskSet.size).toBe(2);
  });

  it("applies stop_loss.lookback from variant (preserves type + value)", () => {
    const variants = enumerateLayerBVariants(FAKE_BASE);
    const lb3 = variants.find((v) => v.geometry.sl_lookback === 3);
    expect(lb3?.rules.stop_loss.type).toBe("swing_anchor");
    expect(lb3?.rules.stop_loss.lookback).toBe(3);
    expect(lb3?.rules.stop_loss.value).toBe(0.1); // base value preserved
  });

  it("applies take_profit.value from variant rr_multiple (preserves type)", () => {
    const variants = enumerateLayerBVariants(FAKE_BASE);
    const rr5 = variants.find((v) => v.geometry.rr_multiple === 5);
    expect(rr5?.rules.take_profit.type).toBe("rr_multiple");
    expect(rr5?.rules.take_profit.value).toBe(5);
  });

  it("applies position_sizing.value from variant risk_per_trade_pct", () => {
    const variants = enumerateLayerBVariants(FAKE_BASE);
    const risk06 = variants.find((v) => v.geometry.risk_per_trade_pct === 0.6);
    expect(risk06?.rules.position_sizing.type).toBe("risk_per_trade");
    expect(risk06?.rules.position_sizing.value).toBe(0.6);
  });

  it("regime_filter:true → enabled object; false → undefined (off, not silent-default)", () => {
    const variants = enumerateLayerBVariants(FAKE_BASE);
    const on = variants.find((v) => v.geometry.regime_filter === true);
    const off = variants.find((v) => v.geometry.regime_filter === false);
    expect(on?.rules.regime_filter?.enabled).toBe(true);
    expect(off?.rules.regime_filter).toBeUndefined();
  });

  it("adx_filter:true → enabled object; false → undefined", () => {
    const variants = enumerateLayerBVariants(FAKE_BASE);
    const on = variants.find((v) => v.geometry.adx_filter === true);
    const off = variants.find((v) => v.geometry.adx_filter === false);
    expect(on?.rules.adx_filter?.enabled).toBe(true);
    expect(off?.rules.adx_filter).toBeUndefined();
  });

  it("preserves non-geometry fields from base (entry, asset_class, leverage, prop_firm)", () => {
    const v = enumerateLayerBVariants(FAKE_BASE)[0];
    expect(v.rules.entry_conditions).toEqual(FAKE_BASE_RULES.entry_conditions);
    expect(v.rules.asset_class).toBe("commodity");
    expect(v.rules.leverage).toBe(50);
    expect(v.rules.timeframe).toBe("4h");
    expect(v.rules.side).toBe("long");
    expect(v.rules.prop_firm).toEqual(FAKE_BASE_RULES.prop_firm);
    expect(v.rules.stagnant_exit).toEqual(FAKE_BASE_RULES.stagnant_exit);
  });

  it("geometryTag is filesystem-safe (no dots, no spaces)", () => {
    const tag = geometryTag({
      rr_multiple: 2.5, sl_lookback: 4, risk_per_trade_pct: 0.6,
      regime_filter: true, adx_filter: false,
    });
    expect(tag).toBe("rr25_lb4_r06_rf1_af0");
    expect(tag).not.toMatch(/[.\s]/);
  });

  it("variant name format: 'LayerB: <body> | <tag>'", () => {
    const v = enumerateLayerBVariants(FAKE_BASE)[0];
    expect(v.name).toMatch(/^LayerB: XAU\/USD BOS-Long 4h \| rr/);
  });

  it("strips redundant Search: prefix from base body in variant name", () => {
    const v = enumerateLayerBVariants(FAKE_BASE)[0];
    expect(v.name).not.toContain("Search:");
  });

  it("base ticker + capital propagate to every variant", () => {
    const variants = enumerateLayerBVariants(FAKE_BASE);
    expect(variants.every((v) => v.ticker === "XAU/USD")).toBe(true);
    expect(variants.every((v) => v.capital === 10000)).toBe(true);
  });
});
