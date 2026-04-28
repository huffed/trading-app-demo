import { describe, expect, it } from "vitest";
import { algorithmRulesSchema } from "./algorithm";

function baseRules(overrides: Record<string, unknown> = {}) {
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
    exit_conditions: [],
    stop_loss: { type: "percentage", value: 5 },
    take_profit: { type: "percentage", value: 10 },
    position_sizing: { type: "percentage_of_capital", value: 10 },
    max_positions: 1,
    timeframe: "1d",
    asset_class: "equity",
    ...overrides,
  };
}

describe("algorithmRulesSchema — position_sizing per-type bounds", () => {
  it("accepts a normal risk_per_trade of 0.7%", () => {
    const r = algorithmRulesSchema.safeParse(
      baseRules({ position_sizing: { type: "risk_per_trade", value: 0.7 } })
    );
    expect(r.success).toBe(true);
  });

  it("rejects risk_per_trade above 5% (catches the stale-form 70 bug)", () => {
    const r = algorithmRulesSchema.safeParse(
      baseRules({ position_sizing: { type: "risk_per_trade", value: 70 } })
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toContain("unit error");
    }
  });

  it("rejects risk_per_trade exactly equal to 5% boundary inclusive of >5", () => {
    const ok = algorithmRulesSchema.safeParse(
      baseRules({ position_sizing: { type: "risk_per_trade", value: 5 } })
    );
    expect(ok.success).toBe(true);
    const bad = algorithmRulesSchema.safeParse(
      baseRules({ position_sizing: { type: "risk_per_trade", value: 5.1 } })
    );
    expect(bad.success).toBe(false);
  });

  it("rejects negative or zero values for any sizing type", () => {
    expect(
      algorithmRulesSchema.safeParse(
        baseRules({ position_sizing: { type: "risk_per_trade", value: 0 } })
      ).success
    ).toBe(false);
    expect(
      algorithmRulesSchema.safeParse(
        baseRules({ position_sizing: { type: "lots", value: -1 } })
      ).success
    ).toBe(false);
  });

  it("accepts lots up to 50 but rejects above", () => {
    expect(
      algorithmRulesSchema.safeParse(
        baseRules({ position_sizing: { type: "lots", value: 50 } })
      ).success
    ).toBe(true);
    expect(
      algorithmRulesSchema.safeParse(
        baseRules({ position_sizing: { type: "lots", value: 51 } })
      ).success
    ).toBe(false);
  });

  it("accepts percentage_of_capital up to 100 but rejects above", () => {
    expect(
      algorithmRulesSchema.safeParse(
        baseRules({ position_sizing: { type: "percentage_of_capital", value: 100 } })
      ).success
    ).toBe(true);
    expect(
      algorithmRulesSchema.safeParse(
        baseRules({ position_sizing: { type: "percentage_of_capital", value: 150 } })
      ).success
    ).toBe(false);
  });

  it("leaves fixed_amount and fixed_quantity unbounded above (context-dependent)", () => {
    expect(
      algorithmRulesSchema.safeParse(
        baseRules({ position_sizing: { type: "fixed_amount", value: 1_000_000 } })
      ).success
    ).toBe(true);
    expect(
      algorithmRulesSchema.safeParse(
        baseRules({ position_sizing: { type: "fixed_quantity", value: 10_000 } })
      ).success
    ).toBe(true);
  });
});
