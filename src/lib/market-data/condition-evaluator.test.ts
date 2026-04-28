import { describe, expect, it } from "vitest";
import type { TechnicalCondition } from "@/types/algorithm";
import { checkConditions, type ConditionContext } from "./condition-evaluator";

const ctx: ConditionContext = {
  cache: new Map(),
  closes: [1, 2, 3],
  bars: [],
  i: 2,
};

const ALWAYS_TRUE: TechnicalCondition = {
  type: "technical",
  indicator: "RSI",
  operator: "less_than",
  value: 100,
  timeframe: "1d",
};

const ALWAYS_FALSE: TechnicalCondition = {
  type: "technical",
  indicator: "RSI",
  operator: "greater_than",
  value: 100,
  timeframe: "1d",
};

const evalTrue = () => true;
const evalFalse = () => false;

describe("checkConditions logic combinator", () => {
  it("returns false when conditions list is empty regardless of logic", () => {
    expect(checkConditions([], ctx, evalTrue, "all")).toBe(false);
    expect(checkConditions([], ctx, evalTrue, "any")).toBe(false);
  });

  it("'all' requires every condition met", () => {
    expect(
      checkConditions(
        [ALWAYS_TRUE, ALWAYS_TRUE],
        ctx,
        (c) => c === ALWAYS_TRUE,
        "all"
      )
    ).toBe(true);
    expect(
      checkConditions(
        [ALWAYS_TRUE, ALWAYS_FALSE],
        ctx,
        (c) => c === ALWAYS_TRUE,
        "all"
      )
    ).toBe(false);
  });

  it("'any' fires on the first met condition", () => {
    expect(
      checkConditions(
        [ALWAYS_TRUE, ALWAYS_FALSE],
        ctx,
        (c) => c === ALWAYS_TRUE,
        "any"
      )
    ).toBe(true);
    expect(
      checkConditions([ALWAYS_FALSE, ALWAYS_FALSE], ctx, evalFalse, "any")
    ).toBe(false);
  });

  it("'n_of_m' fires when at least n conditions are met", () => {
    const conds = [ALWAYS_TRUE, ALWAYS_TRUE, ALWAYS_FALSE];
    expect(
      checkConditions(conds, ctx, (c) => c === ALWAYS_TRUE, { type: "n_of_m", n: 2 })
    ).toBe(true);
    expect(
      checkConditions(conds, ctx, (c) => c === ALWAYS_TRUE, { type: "n_of_m", n: 3 })
    ).toBe(false);
  });

  it("defaults to 'all' when logic is omitted", () => {
    // Regression for the audit: caller passes logic=undefined → engine
    // must NOT treat that as "any". exit_logic falls back to entry_logic
    // upstream; the evaluator's own fallback when neither is set is "all".
    expect(
      checkConditions([ALWAYS_TRUE, ALWAYS_FALSE], ctx, (c) => c === ALWAYS_TRUE)
    ).toBe(false);
  });
});
