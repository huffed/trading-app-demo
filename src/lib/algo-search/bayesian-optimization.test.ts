import { describe, expect, it } from "vitest";
import type { AlgorithmRules } from "@/types/algorithm";
import {
  applyBoParams,
  bestEntry,
  boVariantTag,
  computeSharpe,
  decodeParams,
  LAYER_B_BO_DIMENSIONS,
  sortedByObjective,
} from "./bayesian-optimization";

const baseRules: AlgorithmRules = {
  entry_conditions: [{ type: "pattern", pattern: "engulfing", direction: "bullish", timeframe: "4h" }],
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
    daily_loss_limit: 5,
    max_drawdown: 10,
    profit_target: 10,
    max_consecutive_losses: 0,
    consecutive_loss_daily_halt: 2,
    consistency_rule: 0,
    slippage_bps: 0.5,
    commission_pct: 0,
    spread_bps: 0.4,
    commission_per_lot: 0,
    combined_risk_cap_pct: 4,
  },
  stagnant_exit: { enabled: true },
};

describe("LAYER_B_BO_DIMENSIONS", () => {
  it("has 5 axes matching layer-b-enumerate.ts axes", () => {
    expect(LAYER_B_BO_DIMENSIONS).toHaveLength(5);
    expect(LAYER_B_BO_DIMENSIONS.map((d) => d.name)).toEqual([
      "rr_multiple",
      "sl_lookback",
      "risk_per_trade_pct",
      "regime_filter",
      "adx_filter",
    ]);
  });

  it("rr_multiple bounds cover grid extremes (2 → 5)", () => {
    const rr = LAYER_B_BO_DIMENSIONS.find((d) => d.name === "rr_multiple")!;
    expect(rr.low).toBeLessThanOrEqual(2);
    expect(rr.high).toBeGreaterThanOrEqual(5);
  });

  it("sl_lookback is Integer bounds cover grid extremes (3 → 6 minimum)", () => {
    const lb = LAYER_B_BO_DIMENSIONS.find((d) => d.name === "sl_lookback")!;
    expect(lb.type).toBe("Integer");
    expect(lb.low).toBeLessThanOrEqual(3);
    expect(lb.high).toBeGreaterThanOrEqual(6);
  });

  it("regime_filter + adx_filter are Integer{0,1} (binary)", () => {
    for (const name of ["regime_filter", "adx_filter"]) {
      const d = LAYER_B_BO_DIMENSIONS.find((d) => d.name === name)!;
      expect(d.type).toBe("Integer");
      expect(d.low).toBe(0);
      expect(d.high).toBe(1);
    }
  });
});

describe("decodeParams", () => {
  it("maps params to dimension names", () => {
    const decoded = decodeParams([3.5, 5, 0.8, 1, 0], LAYER_B_BO_DIMENSIONS);
    expect(decoded.rr_multiple).toBe(3.5);
    expect(decoded.sl_lookback).toBe(5);
    expect(decoded.risk_per_trade_pct).toBe(0.8);
    expect(decoded.regime_filter).toBe(1);
    expect(decoded.adx_filter).toBe(0);
  });

  it("throws on length mismatch", () => {
    expect(() => decodeParams([1, 2, 3], LAYER_B_BO_DIMENSIONS)).toThrow();
  });
});

describe("boVariantTag", () => {
  it("encodes continuous params as filename-safe tag", () => {
    expect(boVariantTag([3.7, 5, 0.85, 1, 0])).toBe("bo_rr37_lb5_r85_rf1_af0");
  });

  it("rounds correctly for boundary values", () => {
    expect(boVariantTag([2.0, 3, 0.3, 0, 0])).toBe("bo_rr20_lb3_r30_rf0_af0");
    expect(boVariantTag([5.0, 12, 1.2, 1, 1])).toBe("bo_rr50_lb12_r120_rf1_af1");
  });
});

describe("applyBoParams", () => {
  it("overrides geometry while preserving entry_conditions + other fields", () => {
    const augmented = applyBoParams(baseRules, [4.2, 8, 0.5, 1, 0]);
    expect(augmented.take_profit.value).toBe(4.2);
    expect(augmented.stop_loss.lookback).toBe(8);
    expect(augmented.position_sizing.value).toBe(0.5);
    expect(augmented.regime_filter).toBeDefined();
    expect(augmented.adx_filter).toBeUndefined();
    // Preserved
    expect(augmented.entry_conditions).toEqual(baseRules.entry_conditions);
    expect(augmented.timeframe).toBe(baseRules.timeframe);
    expect(augmented.leverage).toBe(baseRules.leverage);
  });

  it("base rules object is NOT mutated (pure transform)", () => {
    const originalRr = baseRules.take_profit.value;
    applyBoParams(baseRules, [4.2, 8, 0.5, 1, 0]);
    expect(baseRules.take_profit.value).toBe(originalRr);
  });

  it("threshold for binary axes uses > 0.5", () => {
    // 0.4 → 0, 0.6 → 1 (BO might return non-integer values for Integer dims in some configs)
    const cold = applyBoParams(baseRules, [3, 5, 0.6, 0.4, 0.6]);
    expect(cold.regime_filter).toBeUndefined();
    expect(cold.adx_filter).toBeDefined();
  });
});

describe("computeSharpe", () => {
  it("returns 0 for n < 2", () => {
    expect(computeSharpe([])).toBe(0);
    expect(computeSharpe([1.0])).toBe(0);
  });

  it("returns 0 when std = 0 (constant returns)", () => {
    expect(computeSharpe([1, 1, 1, 1])).toBe(0);
  });

  it("computes mean/std correctly for known distribution", () => {
    // R = [1, -1, 1, -1] → mean=0, std=1 → sharpe=0
    expect(computeSharpe([1, -1, 1, -1])).toBe(0);
    // R = [1, 2, 1, 2] → mean=1.5, std=0.5 → sharpe=3.0
    expect(computeSharpe([1, 2, 1, 2])).toBeCloseTo(3.0, 4);
  });
});

describe("bestEntry + sortedByObjective", () => {
  const history = [
    { params: [1, 2, 3, 0, 0], objective: -0.5, sharpe: 0.5 },
    { params: [2, 3, 4, 0, 0], objective: -1.2, sharpe: 1.2 },
    { params: [3, 4, 5, 0, 0], objective: -0.3, sharpe: 0.3 },
  ];

  it("bestEntry returns lowest-objective entry", () => {
    expect(bestEntry(history)?.sharpe).toBe(1.2);
  });

  it("bestEntry returns null for empty history", () => {
    expect(bestEntry([])).toBe(null);
  });

  it("sortedByObjective sorts ascending (best first)", () => {
    const sorted = sortedByObjective(history);
    expect(sorted[0].sharpe).toBe(1.2);
    expect(sorted[1].sharpe).toBe(0.5);
    expect(sorted[2].sharpe).toBe(0.3);
  });
});
