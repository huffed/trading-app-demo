/**
 * Unit tests for the entry-conviction module (CB.T1 pass 6,
 * 2026-06-22). Sixth test in `src/lib/scan/`. Covers all 3 exports
 * from `entry-conviction.ts`:
 *  - snapshotCondition (pure type-discriminated serializer)
 *  - pickConvictionMultiplier (pure dispatch over rules + gate counts)
 *  - checkEntryConditions (async; logs signal_no_action on fail)
 *
 * The first two are pure functions; the third uses the same vi.mock
 * pattern as prior CB.T1 passes (mock evaluateConditionsDetailed +
 * countTimeframesAgreeing + collectOtherTimeframes + logActivity +
 * resampleTo + resampleToDaily so the test exercises the gate logic
 * without needing real condition evaluators).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  convictionMultiplier,
  convictionMultiplierByTfAgreement,
} from "@/lib/algorithm/conviction-sizing";
import {
  collectOtherTimeframes,
  countTimeframesAgreeing,
  evaluateConditionsDetailed,
} from "@/lib/conditions/evaluate";
import { resampleTo, resampleToDaily } from "@/lib/market-data/resample";
import type {
  AlgorithmRules,
  PatternCondition,
  TechnicalCondition,
} from "@/types/algorithm";
import {
  checkEntryConditions,
  pickConvictionMultiplier,
  snapshotCondition,
} from "./entry-conviction";
import { logActivity } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---- Mocks (for checkEntryConditions). --------------------------------
vi.mock("@/lib/algorithm/conviction-sizing", () => ({
  convictionMultiplier: vi.fn(),
  convictionMultiplierByTfAgreement: vi.fn(),
}));
vi.mock("@/lib/conditions/evaluate", () => ({
  collectOtherTimeframes: vi.fn(),
  countTimeframesAgreeing: vi.fn(),
  evaluateConditionsDetailed: vi.fn(),
  // `normalize` is re-exported but not used inside the test surface
  normalize: vi.fn(),
}));
vi.mock("@/lib/market-data/resample", () => ({
  resampleTo: vi.fn(),
  resampleToDaily: vi.fn(),
}));
vi.mock("./helpers", () => ({
  logActivity: vi.fn(),
}));

const mockedConvictionMultiplier = vi.mocked(convictionMultiplier);
const mockedConvictionMultiplierByTfAgreement = vi.mocked(convictionMultiplierByTfAgreement);
const mockedEvaluateConditionsDetailed = vi.mocked(evaluateConditionsDetailed);
const mockedCountTimeframesAgreeing = vi.mocked(countTimeframesAgreeing);
const mockedCollectOtherTimeframes = vi.mocked(collectOtherTimeframes);
const mockedResampleTo = vi.mocked(resampleTo);
const mockedResampleToDaily = vi.mocked(resampleToDaily);
const mockedLogActivity = vi.mocked(logActivity);

const SUPABASE_STUB = Object.create(null) as SupabaseClient;

beforeEach(() => {
  vi.clearAllMocks();
  mockedConvictionMultiplier.mockReturnValue(1);
  mockedConvictionMultiplierByTfAgreement.mockReturnValue(1);
  mockedEvaluateConditionsDetailed.mockReturnValue({ met: 0, total: 0, fired: [] });
  mockedCountTimeframesAgreeing.mockReturnValue({ firedTfs: 0, totalTfs: 0 });
  mockedCollectOtherTimeframes.mockReturnValue([]);
  mockedResampleTo.mockReturnValue([]);
  mockedResampleToDaily.mockReturnValue([]);
  mockedLogActivity.mockResolvedValue(undefined);
});

// ======================================================================
// snapshotCondition (pure)
// ======================================================================

describe("snapshotCondition — type-discriminated serializer", () => {
  it("technical condition → returns {type, indicator, operator, value}", () => {
    const c: TechnicalCondition = {
      type: "technical",
      indicator: "RSI",
      operator: "less_than",
      value: 30,
      timeframe: "4h",
    };
    expect(snapshotCondition(c)).toEqual({
      type: "technical",
      indicator: "RSI",
      operator: "less_than",
      value: 30,
    });
    // timeframe is intentionally NOT in the snapshot (caller adds it
    // separately via `snapshotCondition(c) + {timeframe: c.timeframe}` —
    // see entry-conviction.ts:170-173).
  });

  it("pattern condition → returns {type, pattern, direction, lookback, ma_period}", () => {
    const c: PatternCondition = {
      type: "pattern",
      pattern: "fvg",
      direction: "bullish",
      lookback: 20,
      ma_period: 50,
      timeframe: "4h",
    };
    expect(snapshotCondition(c)).toEqual({
      type: "pattern",
      pattern: "fvg",
      direction: "bullish",
      lookback: 20,
      ma_period: 50,
    });
  });

  it("pattern condition with optional ma_period unset → ma_period undefined", () => {
    const c: PatternCondition = {
      type: "pattern",
      pattern: "sweep_reclaim",
      direction: "bearish",
      lookback: 10,
      timeframe: "1h",
    };
    expect(snapshotCondition(c)).toEqual({
      type: "pattern",
      pattern: "sweep_reclaim",
      direction: "bearish",
      lookback: 10,
      ma_period: undefined,
    });
  });
});

// ======================================================================
// pickConvictionMultiplier (pure dispatch)
// ======================================================================

describe("pickConvictionMultiplier — dispatch over rules.position_sizing", () => {
  // Object.create(null) + Object.assign bypasses consistent-type-assertions
  // rule (same pattern as the other CB.T1 test files).
  function makeSizing(fields: Record<string, unknown>): AlgorithmRules["position_sizing"] {
    const stub = Object.create(null) as Record<string, unknown>;
    Object.assign(stub, fields);
    return stub as unknown as AlgorithmRules["position_sizing"];
  }
  function rules(sizing: AlgorithmRules["position_sizing"]): AlgorithmRules {
    return {
      timeframe: "4h",
      position_sizing: sizing,
      entry_logic: "all",
    } as unknown as AlgorithmRules;
  }

  const sampleGate = { met: 3, total: 5, firedTfs: 2, totalTfs: 3 };

  it("returns 1 for non-conviction_scaled sizing types", () => {
    for (const type of ["percentage_of_capital", "fixed_amount", "lots", "risk_per_trade"] as const) {
      const result = pickConvictionMultiplier(rules(makeSizing({ type, value: 1 })), sampleGate);
      expect(result).toBe(1);
      // None of the multiplier helpers should be called for non-conviction sizing
      expect(mockedConvictionMultiplier).not.toHaveBeenCalled();
      expect(mockedConvictionMultiplierByTfAgreement).not.toHaveBeenCalled();
    }
  });

  it("conviction_scaled + tf_agreement → uses convictionMultiplierByTfAgreement(firedTfs, totalTfs, max)", () => {
    mockedConvictionMultiplierByTfAgreement.mockReturnValue(2.5);
    const result = pickConvictionMultiplier(
      rules(
        makeSizing({
          type: "conviction_scaled",
          value: 1,
          conviction_metric: "tf_agreement",
          max_multiplier: 3,
        })
      ),
      sampleGate
    );
    expect(result).toBe(2.5);
    expect(mockedConvictionMultiplierByTfAgreement).toHaveBeenCalledWith(2, 3, 3);
    expect(mockedConvictionMultiplier).not.toHaveBeenCalled();
  });

  it("conviction_scaled + non-tf_agreement (default condition_count) → uses convictionMultiplier(logic, met, total, max)", () => {
    mockedConvictionMultiplier.mockReturnValue(1.8);
    const r = rules(
      makeSizing({
        type: "conviction_scaled",
        value: 1,
        conviction_metric: "condition_count",
        max_multiplier: 2,
      })
    );
    const result = pickConvictionMultiplier(r, sampleGate);
    expect(result).toBe(1.8);
    expect(mockedConvictionMultiplier).toHaveBeenCalledWith("all", 3, 5, 2);
    expect(mockedConvictionMultiplierByTfAgreement).not.toHaveBeenCalled();
  });
});

// ======================================================================
// checkEntryConditions
// ======================================================================

const TECH_RSI: TechnicalCondition = {
  type: "technical",
  indicator: "RSI",
  operator: "less_than",
  value: 30,
  timeframe: "4h",
};
const TECH_SMA: TechnicalCondition = {
  type: "technical",
  indicator: "SMA",
  operator: "greater_than",
  value: 50,
  timeframe: "4h",
};

const BARS = [{ date: "2026-06-22T10:00:00Z", open: 3000, high: 3010, low: 2990, close: 3005, volume: 100 }];
const CLOSES = [3005];

describe("checkEntryConditions — empty + gate-pass paths", () => {
  it("empty conditions list → pass:true with all-zero counts + NO log", async () => {
    const result = await checkEntryConditions(
      SUPABASE_STUB,
      "user-1",
      "algo-1",
      "XAU/USD",
      [],
      BARS,
      CLOSES,
      "4h",
      "all"
    );
    expect(result).toEqual({
      pass: true,
      met: 0,
      total: 0,
      fired: [],
      firedTfs: 0,
      totalTfs: 0,
    });
    expect(mockedLogActivity).not.toHaveBeenCalled();
    // Skip-fast: evaluators shouldn't be invoked on empty conditions
    expect(mockedEvaluateConditionsDetailed).not.toHaveBeenCalled();
  });

  it("'all' logic + met==total → pass:true + NO log", async () => {
    mockedEvaluateConditionsDetailed.mockReturnValue({
      met: 2,
      total: 2,
      fired: [true, true],
    });
    mockedCountTimeframesAgreeing.mockReturnValue({ firedTfs: 1, totalTfs: 1 });
    const result = await checkEntryConditions(
      SUPABASE_STUB,
      "user-1",
      "algo-1",
      "XAU/USD",
      [TECH_RSI, TECH_SMA],
      BARS,
      CLOSES,
      "4h",
      "all"
    );
    expect(result).toMatchObject({
      pass: true,
      met: 2,
      total: 2,
      fired: [true, true],
      firedTfs: 1,
      totalTfs: 1,
    });
    expect(mockedLogActivity).not.toHaveBeenCalled();
  });

  it("'any' logic + met>0 → pass:true", async () => {
    mockedEvaluateConditionsDetailed.mockReturnValue({
      met: 1,
      total: 2,
      fired: [true, false],
    });
    const result = await checkEntryConditions(
      SUPABASE_STUB,
      "user-1",
      "algo-1",
      "XAU/USD",
      [TECH_RSI, TECH_SMA],
      BARS,
      CLOSES,
      "4h",
      "any"
    );
    expect(result.pass).toBe(true);
    expect(mockedLogActivity).not.toHaveBeenCalled();
  });

  it("n_of_m logic + met>=n → pass:true", async () => {
    mockedEvaluateConditionsDetailed.mockReturnValue({
      met: 2,
      total: 3,
      fired: [true, true, false],
    });
    const result = await checkEntryConditions(
      SUPABASE_STUB,
      "user-1",
      "algo-1",
      "XAU/USD",
      [TECH_RSI, TECH_SMA, TECH_RSI],
      BARS,
      CLOSES,
      "4h",
      { type: "n_of_m", n: 2 }
    );
    expect(result.pass).toBe(true);
    expect(mockedLogActivity).not.toHaveBeenCalled();
  });
});

describe("checkEntryConditions — gate-fail paths log signal_no_action", () => {
  it("'all' logic + met<total → pass:false + log fires", async () => {
    mockedEvaluateConditionsDetailed.mockReturnValue({
      met: 1,
      total: 2,
      fired: [true, false],
    });
    const result = await checkEntryConditions(
      SUPABASE_STUB,
      "user-1",
      "algo-1",
      "XAU/USD",
      [TECH_RSI, TECH_SMA],
      BARS,
      CLOSES,
      "4h",
      "all"
    );
    expect(result.pass).toBe(false);
    expect(mockedLogActivity).toHaveBeenCalledOnce();
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details).toMatchObject({
      reason: "Entry conditions not met",
      conditions_met: 1,
      conditions_total: 2,
      entry_logic: "all",
      bar_date: "2026-06-22T10:00:00Z", // last bar's date
      bar_close: 3005, // last close
    });
  });

  it("'any' logic + met==0 → pass:false + log fires", async () => {
    mockedEvaluateConditionsDetailed.mockReturnValue({
      met: 0,
      total: 2,
      fired: [false, false],
    });
    const result = await checkEntryConditions(
      SUPABASE_STUB,
      "user-1",
      "algo-1",
      "XAU/USD",
      [TECH_RSI, TECH_SMA],
      BARS,
      CLOSES,
      "4h",
      "any"
    );
    expect(result.pass).toBe(false);
    expect(mockedLogActivity).toHaveBeenCalledOnce();
    expect(mockedLogActivity.mock.calls[0][2].details.entry_logic).toBe("any");
  });

  it("n_of_m logic + met<n → pass:false + log fires with 'n_of_m(N)' label", async () => {
    mockedEvaluateConditionsDetailed.mockReturnValue({
      met: 1,
      total: 3,
      fired: [true, false, false],
    });
    const result = await checkEntryConditions(
      SUPABASE_STUB,
      "user-1",
      "algo-1",
      "XAU/USD",
      [TECH_RSI, TECH_SMA, TECH_RSI],
      BARS,
      CLOSES,
      "4h",
      { type: "n_of_m", n: 2 }
    );
    expect(result.pass).toBe(false);
    const logCall = mockedLogActivity.mock.calls[0];
    expect(logCall[2].details.entry_logic).toBe("n_of_m(2)");
  });

  it("log breakdown includes snapshotCondition fields + timeframe + met per condition", async () => {
    mockedEvaluateConditionsDetailed.mockReturnValue({
      met: 1,
      total: 2,
      fired: [true, false],
    });
    await checkEntryConditions(
      SUPABASE_STUB,
      "user-1",
      "algo-1",
      "XAU/USD",
      [TECH_RSI, TECH_SMA],
      BARS,
      CLOSES,
      "4h",
      "all"
    );
    const logCall = mockedLogActivity.mock.calls[0];
    const breakdown = logCall[2].details.conditions_breakdown;
    expect(breakdown).toEqual([
      {
        type: "technical",
        indicator: "RSI",
        operator: "less_than",
        value: 30,
        timeframe: "4h",
        met: true,
      },
      {
        type: "technical",
        indicator: "SMA",
        operator: "greater_than",
        value: 50,
        timeframe: "4h",
        met: false,
      },
    ]);
  });
});

describe("checkEntryConditions — multi-TF + daily-bar routing", () => {
  it("prefers provided dailyBars over resampleToDaily(bars) fallback", async () => {
    const providedDaily = [
      { date: "2026-06-22", open: 3000, high: 3100, low: 2900, close: 3050, volume: 1000 },
    ];
    mockedEvaluateConditionsDetailed.mockReturnValue({
      met: 0,
      total: 1,
      fired: [false],
    });
    await checkEntryConditions(
      SUPABASE_STUB,
      "user-1",
      "algo-1",
      "XAU/USD",
      [TECH_RSI],
      BARS,
      CLOSES,
      "4h",
      "all",
      undefined,
      providedDaily // dailyBars provided
    );
    // resampleToDaily should NOT be called when dailyBars provided
    expect(mockedResampleToDaily).not.toHaveBeenCalled();
  });

  it("falls back to resampleToDaily(bars) when dailyBars is null/undefined", async () => {
    mockedEvaluateConditionsDetailed.mockReturnValue({
      met: 0,
      total: 1,
      fired: [false],
    });
    await checkEntryConditions(
      SUPABASE_STUB,
      "user-1",
      "algo-1",
      "XAU/USD",
      [TECH_RSI],
      BARS,
      CLOSES,
      "4h",
      "all"
    );
    expect(mockedResampleToDaily).toHaveBeenCalledWith(BARS);
  });

  it("multi-TF: builds byTimeframe bundle when collectOtherTimeframes returns non-empty", async () => {
    mockedCollectOtherTimeframes.mockReturnValue(["1h"]);
    mockedResampleTo.mockReturnValue([
      { date: "2026-06-22T11:00:00Z", open: 3001, high: 3009, low: 2991, close: 3003, volume: 50 },
    ]);
    mockedEvaluateConditionsDetailed.mockReturnValue({
      met: 1,
      total: 1,
      fired: [true],
    });
    await checkEntryConditions(
      SUPABASE_STUB,
      "user-1",
      "algo-1",
      "XAU/USD",
      [TECH_RSI],
      BARS,
      CLOSES,
      "4h",
      "all"
    );
    expect(mockedResampleTo).toHaveBeenCalledWith(BARS, "1h");
    // primaryTimeframe is lowercased before being passed to collectOtherTimeframes
    expect(mockedCollectOtherTimeframes).toHaveBeenCalledWith([TECH_RSI], [], "4h");
  });

  it("multi-TF: skips TF when resampleTo returns empty (don't build empty bundle)", async () => {
    mockedCollectOtherTimeframes.mockReturnValue(["1h"]);
    mockedResampleTo.mockReturnValue([]); // empty resample result
    mockedEvaluateConditionsDetailed.mockReturnValue({
      met: 1,
      total: 1,
      fired: [true],
    });
    // Should not throw; just doesn't add the empty TF to the bundle map.
    const result = await checkEntryConditions(
      SUPABASE_STUB,
      "user-1",
      "algo-1",
      "XAU/USD",
      [TECH_RSI],
      BARS,
      CLOSES,
      "4h",
      "all"
    );
    expect(result.pass).toBe(true);
  });
});
