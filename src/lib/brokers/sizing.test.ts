/**
 * Unit tests for notionalToLots — the notional-dollars → broker-lots
 * conversion that sizes REAL orders (`live-execution.ts:117`). Previously
 * executed by ZERO tests: `live-execution.test.ts` mocks this module, so
 * the real implementation had no coverage. This is the exact bug class
 * behind the forex-catalog 80× oversizing incident (a wrong contractSize
 * or a missing volumeStep silently mis-sizes a live order).
 */
import { describe, expect, it } from "vitest";
import { notionalToLots } from "./sizing";
import type { BrokerSymbolSpec } from "./types";

type Spec = Pick<BrokerSymbolSpec, "contractSize" | "volumeStep" | "minVolume" | "maxVolume">;
const forex: Spec = { contractSize: 100_000, volumeStep: 0.01, minVolume: 0.01, maxVolume: 100 };
const gold: Spec = { contractSize: 100, volumeStep: 0.01, minVolume: 0.01, maxVolume: 50 };

describe("notionalToLots", () => {
  it("forex: $1100 @ 1.27 → 0.01 lots (the documented reference case)", () => {
    // 1100 / (100000 × 1.27) = 0.008661 → rounds to 0.01 step.
    expect(notionalToLots(1100, 1.27, forex)).toBe(0.01);
  });

  it("gold: $6800 @ 3400 → 0.02 lots (100 oz/lot)", () => {
    // 6800 / (100 × 3400) = 0.02 exactly.
    expect(notionalToLots(6800, 3400, gold)).toBe(0.02);
  });

  it("rounds to the nearest volumeStep, not truncation", () => {
    // raw = 0.0349 → round(3.49)·0.01 = 0.03
    const n = 0.0349 * (100 * 3400);
    expect(notionalToLots(n, 3400, gold)).toBe(0.03);
    // raw = 0.0351 → round(3.51)·0.01 = 0.04
    expect(notionalToLots(0.0351 * (100 * 3400), 3400, gold)).toBe(0.04);
  });

  it("clamps up to minVolume when the raw size is below it", () => {
    // $10 @ 3400 gold = 0.0000294 lots → below 0.01 min → clamp to 0.01.
    expect(notionalToLots(10, 3400, gold)).toBe(0.01);
  });

  it("clamps down to maxVolume when the raw size exceeds it", () => {
    // Enormous notional → maxVolume 50 (gold) / 100 (forex).
    expect(notionalToLots(1e9, 3400, gold)).toBe(50);
    expect(notionalToLots(1e12, 1.27, forex)).toBe(100);
  });

  it("returns 0 on a non-positive price (never divides by zero)", () => {
    expect(notionalToLots(6800, 0, gold)).toBe(0);
    expect(notionalToLots(6800, -1, gold)).toBe(0);
  });

  it("returns 0 on a non-positive contractSize (bad catalog entry)", () => {
    expect(notionalToLots(6800, 3400, { ...gold, contractSize: 0 })).toBe(0);
  });

  it("strips floating-point dust to 4 dp", () => {
    // A value engineered to leave 0.01 + epsilon after the step math.
    const lots = notionalToLots(0.03 * (100 * 3400), 3400, gold);
    expect(lots).toBe(0.03);
    expect(Number.isInteger(lots * 10000)).toBe(true); // no 0.0300000001 dust
  });

  it("respects a coarser volumeStep (0.1) for whole-lot instruments", () => {
    const coarse: Spec = { contractSize: 100, volumeStep: 0.1, minVolume: 0.1, maxVolume: 50 };
    // raw = 0.24 → round(2.4)·0.1 = 0.2
    expect(notionalToLots(0.24 * (100 * 3400), 3400, coarse)).toBe(0.2);
  });
});
