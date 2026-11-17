/**
 * Characterisation — position sizing with and without the 0.01-lot floor.
 *
 * Pins the sizing behaviours that exist today so a change to any of them
 * fails loudly. The live paper path and the backtest size the same signal
 * differently (docs/DEBT.md D-02, D-08; audit A2): paper = fractional lots
 * from fixed capital with the rules' leverage; backtest = lots floored to the
 * 0.01 step, skipped below it, leverage capped at 30 under prop_firm.
 *
 * `it.fails` marks behaviour that is known to be wrong today; when the fix
 * lands vitest reports "expected to fail but passed" and the marker comes off.
 */
import { describe, expect, it } from "vitest";
import {
  clampLotsToConstraints,
  getBacktestVolumeConstraints,
  getContractSize,
  riskToLots,
} from "@/lib/constants/markets";
import { sizeForBacktest, type SimConfig } from "@/lib/market-data/prop-firm-backtest";
import { calculatePositionSize } from "@/lib/scan/helpers";
import { asFixture } from "@/test-utils/fixture";
import type { AlgorithmRules } from "@/types/algorithm";

const TICKER = "XAU/USD";
const ENTRY_PRICE = 4000;
const STOP_DISTANCE = 50; // $/oz → slPct = 1.25 %
const RISK_PCT = 0.42; // the deployed portfolio's per-trade risk

const rules = asFixture<AlgorithmRules>({
  asset_class: "commodity",
  leverage: 50,
  prop_firm: { daily_loss_limit: 5, max_drawdown: 10 },
  position_sizing: { type: "risk_per_trade", value: RISK_PCT },
  stop_loss: { type: "swing_anchor", value: 0.1, lookback: 3 },
  take_profit: { type: "rr_multiple", value: 3 },
  max_positions: 1,
});

const simConfig: SimConfig = {
  slippageBps: 0.5,
  spreadBps: 0.4,
  commissionPct: 0,
  commissionPerLot: 0,
  maxPos: 1,
  posSize: RISK_PCT / 100,
  stopLoss: rules.stop_loss,
  takeProfit: rules.take_profit,
};

describe("gold contract and raw risk-to-lots", () => {
  it("XAU/USD is a 100 oz contract", () => {
    expect(getContractSize(TICKER, "commodity")).toBe(100);
  });

  it("0.42 % of $100K at a $50 stop is 0.084 lots (8.4 oz)", () => {
    // riskUsd 420 / stop 50 = 8.4 oz / 100 oz per lot
    expect(riskToLots(TICKER, 100_000, RISK_PCT, ENTRY_PRICE, 1.25)).toBeCloseTo(0.084, 12);
  });

  it("0.42 % of $10K at the same stop is 0.0084 lots — below the 0.01 floor", () => {
    expect(riskToLots(TICKER, 10_000, RISK_PCT, ENTRY_PRICE, 1.25)).toBeCloseTo(0.0084, 12);
  });
});

describe("the backtest lot floor (clampLotsToConstraints)", () => {
  const constraints = getBacktestVolumeConstraints(TICKER, "commodity");

  it("commodity constraints are step 0.01, min 0.01, max 100", () => {
    expect(constraints).toEqual({ step: 0.01, min: 0.01, max: 100 });
  });

  it("floors to the step: 0.084 → 0.08", () => {
    expect(clampLotsToConstraints(0.084, constraints)).toBeCloseTo(0.08, 12);
  });

  it("returns 0 (skip the entry) below the minimum: 0.0084 → 0", () => {
    expect(clampLotsToConstraints(0.0084, constraints)).toBe(0);
  });

  it("floors 0.29 to 0.28 because 0.29 / 0.01 is 28.999… in IEEE-754 (DEBT D-08)", () => {
    expect(clampLotsToConstraints(0.29, constraints)).toBeCloseTo(0.28, 12);
  });

  it.fails(
    "intended: a lot size already on the step grid is unchanged (0.29 → 0.29) — DEBT D-08",
    () => {
      expect(clampLotsToConstraints(0.29, constraints)).toBeCloseTo(0.29, 12);
    }
  );
});

describe("backtest sizing (sizeForBacktest)", () => {
  it("$10K pool: the $50-stop signal sizes to 0 notional and is skipped", () => {
    const sized = sizeForBacktest(rules, 10_000, ENTRY_PRICE, TICKER, simConfig, 1, STOP_DISTANCE);
    expect(sized).toEqual({ notional: 0, margin: 0 });
  });

  it("$100K equity: 0.08 lots → $32,000 notional, margin at the 30× prop-firm cap", () => {
    const sized = sizeForBacktest(rules, 100_000, ENTRY_PRICE, TICKER, simConfig, 1, STOP_DISTANCE);
    expect(sized.notional).toBeCloseTo(32_000, 6);
    expect(sized.margin).toBeCloseTo(32_000 / 30, 6);
  });
});

describe("live paper sizing (calculatePositionSize) — no floor, rules' leverage", () => {
  it("$100K capital: 8.4 oz, $33,600 notional, margin at the rules' 50× (not capped)", () => {
    const sized = calculatePositionSize(rules, 100_000, 0, ENTRY_PRICE, TICKER, 1, STOP_DISTANCE);
    expect(sized).not.toBeNull();
    expect(sized?.quantity).toBeCloseTo(8.4, 10);
    expect(sized?.notionalValue).toBeCloseTo(33_600, 6);
    expect(sized?.marginRequired).toBeCloseTo(33_600 / 50, 6);
  });

  it("$10K capital: paper still takes the signal the backtest skips (0.84 oz)", () => {
    const sized = calculatePositionSize(rules, 10_000, 0, ENTRY_PRICE, TICKER, 1, STOP_DISTANCE);
    expect(sized?.quantity).toBeCloseTo(0.84, 10);
  });

  it("the same $100K signal is 8.4 oz on paper and 8.0 oz in the backtest", () => {
    const paper = calculatePositionSize(rules, 100_000, 0, ENTRY_PRICE, TICKER, 1, STOP_DISTANCE);
    const backtest = sizeForBacktest(
      rules,
      100_000,
      ENTRY_PRICE,
      TICKER,
      simConfig,
      1,
      STOP_DISTANCE
    );
    const backtestOz = backtest.notional / ENTRY_PRICE;
    expect(paper?.quantity).toBeCloseTo(8.4, 10);
    expect(backtestOz).toBeCloseTo(8.0, 10);
  });
});
