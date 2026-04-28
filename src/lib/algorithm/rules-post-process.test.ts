import { describe, expect, it } from "vitest";
import type { AlgorithmRules } from "@/types/algorithm";
import { clampRules } from "./rules-post-process";

function baseRules(overrides: Partial<AlgorithmRules> = {}): AlgorithmRules {
  return {
    entry_conditions: [
      {
        type: "technical",
        indicator: "RSI",
        operator: "less_than",
        value: 30,
        timeframe: "1d",
      },
    ],
    exit_conditions: [
      {
        type: "technical",
        indicator: "RSI",
        operator: "greater_than",
        value: 70,
        timeframe: "1d",
      },
    ],
    stop_loss: { type: "percentage", value: 5 },
    take_profit: { type: "percentage", value: 10 },
    position_sizing: { type: "percentage_of_capital", value: 10 },
    max_positions: 1,
    timeframe: "1d",
    asset_class: "equity",
    ...overrides,
  };
}

describe("clampRules — exit_logic default (Phase 1 regression)", () => {
  it("defaults exit_logic to 'any' when undefined and there are exit conditions", () => {
    const out = clampRules(baseRules(), "swing");
    expect(out.exit_logic).toBe("any");
  });

  it("preserves a caller-supplied exit_logic", () => {
    const out = clampRules(baseRules({ exit_logic: "all" }), "swing");
    expect(out.exit_logic).toBe("all");
  });

  it("does not set exit_logic when there are zero exit conditions", () => {
    const out = clampRules(baseRules({ exit_conditions: [] }), "swing");
    expect(out.exit_logic).toBeUndefined();
  });
});

describe("clampRules — RSI relaxation for long-term", () => {
  it("relaxes RSI < 30 to RSI < 45 for long-term horizons", () => {
    const out = clampRules(baseRules(), "long term");
    const rsi = out.entry_conditions[0];
    expect(rsi.type).toBe("technical");
    if (rsi.type === "technical") {
      expect(rsi.value).toBe(45);
    }
  });
});

describe("clampRules — position-sizing decimal rescue", () => {
  it("rescues percentage_of_capital expressed as decimal (0.05 → 5)", () => {
    const out = clampRules(
      baseRules({ position_sizing: { type: "percentage_of_capital", value: 0.05 } }),
      "swing"
    );
    expect(out.position_sizing.value).toBe(5);
  });

  it("preserves sub-1 risk_per_trade values (0.7% is the FTMO sweet spot, not 70%)", () => {
    const out = clampRules(
      baseRules({
        asset_class: "forex",
        position_sizing: { type: "risk_per_trade", value: 0.7 },
      }),
      "intraday"
    );
    expect(out.position_sizing.value).toBe(0.7);
  });

  it("preserves sub-1 lots values (micro-lots are legit)", () => {
    const out = clampRules(
      baseRules({
        asset_class: "forex",
        position_sizing: { type: "lots", value: 0.01 },
      }),
      "intraday"
    );
    expect(out.position_sizing.value).toBe(0.01);
  });
});

describe("clampRules — forex/commodity defaults", () => {
  it("auto-sets entry_logic to 2-of-3 when forex has 3+ entry conditions", () => {
    const conditions = Array.from({ length: 3 }, () => ({
      type: "technical" as const,
      indicator: "RSI",
      operator: "less_than" as const,
      value: 50,
      timeframe: "1h",
    }));
    const out = clampRules(
      baseRules({ asset_class: "forex", entry_conditions: conditions }),
      "intraday"
    );
    expect(out.entry_logic).toEqual({ type: "n_of_m", n: 2 });
  });

  it("seeds news_veto with sensible defaults for forex", () => {
    const out = clampRules(baseRules({ asset_class: "forex" }), "intraday");
    expect(out.news_veto?.enabled).toBe(true);
    expect(out.news_veto?.min_impact).toBe("high");
  });
});
