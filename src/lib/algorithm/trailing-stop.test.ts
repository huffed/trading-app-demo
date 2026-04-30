import { describe, expect, it } from "vitest";
import { initTrailingState, updateTrailingState } from "./trailing-stop";

const longInitialSlPrice = 95;
const longInitialSlDistance = 5; // 1R = 5
const longInitialState = initTrailingState({ entryPrice: 100, initialSlPrice: longInitialSlPrice });

describe("updateTrailingState — long: MFE tracking + baseline behaviour", () => {
  const initialSlDistance = longInitialSlDistance;
  const initialState = longInitialState;

  it("does nothing when both features disabled", () => {
    const out = updateTrailingState({
      side: "long",
      entryPrice: 100,
      initialSlDistance,
      currentBar: { high: 110, low: 99 },
      state: initialState,
    });
    expect(out.currentSlPrice).toBe(95);
    expect(out.mfePriceFavorable).toBe(110);
  });

  it("updates MFE to bar high", () => {
    const out = updateTrailingState({
      side: "long",
      entryPrice: 100,
      initialSlDistance,
      currentBar: { high: 105, low: 98 },
      state: initialState,
      trailingStop: { enabled: true },
    });
    expect(out.mfePriceFavorable).toBe(105);
  });
});

describe("updateTrailingState — long: breakeven + trailing semantics", () => {
  const initialSlDistance = longInitialSlDistance;
  const initialState = longInitialState;

  it("breakeven moves SL to entry once MFE >= trigger_at_r", () => {
    // MFE = 105 = +1R from entry 100. Default trigger_at_r = 1.
    const out = updateTrailingState({
      side: "long",
      entryPrice: 100,
      initialSlDistance,
      currentBar: { high: 105, low: 98 },
      state: initialState,
      breakevenMove: { enabled: true },
    });
    expect(out.currentSlPrice).toBe(100);
  });

  it("breakeven does NOT fire below trigger_at_r", () => {
    // MFE = 102 = +0.4R. Default trigger_at_r = 1.
    const out = updateTrailingState({
      side: "long",
      entryPrice: 100,
      initialSlDistance,
      currentBar: { high: 102, low: 98 },
      state: initialState,
      breakevenMove: { enabled: true },
    });
    expect(out.currentSlPrice).toBe(95);
  });

  it("trailing stop activates and trails at trail_distance_r behind MFE", () => {
    // MFE = 110 = +2R. activate_at_r=0.5 default → trigger.
    // trail_distance_r=1 → SL = MFE - 1*R = 110 - 5 = 105.
    const out = updateTrailingState({
      side: "long",
      entryPrice: 100,
      initialSlDistance,
      currentBar: { high: 110, low: 98 },
      state: initialState,
      trailingStop: { enabled: true },
    });
    expect(out.currentSlPrice).toBe(105);
  });

  it("trailing + breakeven combine — picks the most favourable SL", () => {
    // MFE=108=+1.6R. Breakeven (trigger=1) → SL = 100. Trailing (activate=0.5) → SL = 108 - 5 = 103.
    // Most favourable for long = MAX = 103.
    const out = updateTrailingState({
      side: "long",
      entryPrice: 100,
      initialSlDistance,
      currentBar: { high: 108, low: 99 },
      state: initialState,
      trailingStop: { enabled: true },
      breakevenMove: { enabled: true },
    });
    expect(out.currentSlPrice).toBe(103);
  });

  it("never backsteps — pullback after MFE keeps SL at the ratcheted level", () => {
    // First bar: high=110 → SL ratchets to 105.
    const after1 = updateTrailingState({
      side: "long",
      entryPrice: 100,
      initialSlDistance,
      currentBar: { high: 110, low: 99 },
      state: initialState,
      trailingStop: { enabled: true },
    });
    // Second bar: high=104 (pullback, lower than prior MFE).
    const after2 = updateTrailingState({
      side: "long",
      entryPrice: 100,
      initialSlDistance,
      currentBar: { high: 104, low: 98 },
      state: after1,
      trailingStop: { enabled: true },
    });
    expect(after2.mfePriceFavorable).toBe(110); // MFE preserved
    expect(after2.currentSlPrice).toBe(105); // SL preserved (no backstep)
  });
});

describe("updateTrailingState — short position", () => {
  const initialSlPrice = 105;
  const initialSlDistance = 5;
  const initialState = initTrailingState({ entryPrice: 100, initialSlPrice });

  it("MFE updates to bar low for shorts", () => {
    const out = updateTrailingState({
      side: "short",
      entryPrice: 100,
      initialSlDistance,
      currentBar: { high: 102, low: 95 },
      state: initialState,
      trailingStop: { enabled: true },
    });
    expect(out.mfePriceFavorable).toBe(95);
  });

  it("breakeven moves SL down to entry", () => {
    const out = updateTrailingState({
      side: "short",
      entryPrice: 100,
      initialSlDistance,
      currentBar: { high: 102, low: 95 },
      state: initialState,
      breakevenMove: { enabled: true },
    });
    expect(out.currentSlPrice).toBe(100);
  });

  it("trailing stop trails above MFE for short", () => {
    // MFE=90=+2R favourable. trail_distance=1 → SL = 90 + 5 = 95.
    const out = updateTrailingState({
      side: "short",
      entryPrice: 100,
      initialSlDistance,
      currentBar: { high: 102, low: 90 },
      state: initialState,
      trailingStop: { enabled: true },
    });
    expect(out.currentSlPrice).toBe(95);
  });

  it("ratchet semantics — SL only moves down for shorts", () => {
    const after1 = updateTrailingState({
      side: "short",
      entryPrice: 100,
      initialSlDistance,
      currentBar: { high: 102, low: 90 },
      state: initialState,
      trailingStop: { enabled: true },
    });
    expect(after1.currentSlPrice).toBe(95);
    // Bar pulls back up — MFE preserved at 90, SL preserved at 95.
    const after2 = updateTrailingState({
      side: "short",
      entryPrice: 100,
      initialSlDistance,
      currentBar: { high: 99, low: 96 },
      state: after1,
      trailingStop: { enabled: true },
    });
    expect(after2.mfePriceFavorable).toBe(90);
    expect(after2.currentSlPrice).toBe(95);
  });
});
