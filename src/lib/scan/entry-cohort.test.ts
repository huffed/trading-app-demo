/**
 * CB.T1 Tier 2 pass 1 — entry-cohort.ts (2026-06-22 NIGHT LATE).
 *
 * Pure cohort-attribution helpers extracted from `entry-open.ts` (CB.H1
 * pass 12). Tests verify:
 *
 *  - buildEntryCohort: entry_hour_utc always set; 20-bar locator math +
 *    premium/discount/equilibrium classification using the 60/40 cohort
 *    thresholds (intentionally distinct from V1 cluster thresholds 67/33);
 *    short-circuit on <20 bars; clamp on currentPrice outside the range.
 *
 *  - buildEntryReason: composes conditions snapshots + sentiment +
 *    cohort through the Zod schema; omits cohort when empty.
 *
 * `snapshotCondition` (lib/scan/entry-conviction) is mocked so condition
 * snapshots are deterministic without driving Indicators through their
 * full impl.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PriceBar } from "@/lib/market-data/types";
import type { SignalResult } from "@/lib/signals/evaluate-live";
import { entryReasonSchema, type EntryCohort } from "@/lib/validators/position";
import type { PatternCondition, TechnicalCondition } from "@/types/algorithm";
import { buildEntryCohort, buildEntryReason } from "./entry-cohort";
import { snapshotCondition } from "./entry-conviction";

vi.mock("./entry-conviction", () => ({
  snapshotCondition: vi.fn(),
}));

const mockedSnapshot = vi.mocked(snapshotCondition);

function makeBars(opens: Array<{ high: number; low: number; close: number }>): PriceBar[] {
  return opens.map((b, i) => ({
    date: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    open: b.close,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: 0,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default snapshot — identity-like for testing composition
  mockedSnapshot.mockImplementation((c: TechnicalCondition | PatternCondition) =>
    ({ ...c, __snapshot: true }) as unknown as ReturnType<typeof snapshotCondition>
  );
});

// ======================================================================
// buildEntryCohort — entry_hour_utc + 20-bar range locator
// ======================================================================

describe("buildEntryCohort — base attribution", () => {
  it("entry_hour_utc always set to current UTC hour", () => {
    const cohort = buildEntryCohort(undefined, 100, undefined);
    expect(cohort.entry_hour_utc).toBe(new Date().getUTCHours());
  });

  it("caller-provided cohort fields merge in + are NOT overwritten by computation", () => {
    // Caller may pre-populate regime / market_state — those should pass through.
    const cohort = buildEntryCohort(undefined, 100, {
      regime: "trend",
      market_state: { vol: "expansion", range: "discount", mtf: "trend", dxy: "n/a" },
    } as Partial<EntryCohort>);
    expect(cohort.regime).toBe("trend");
    expect(cohort.market_state).toMatchObject({ vol: "expansion" });
  });
});

// ======================================================================
// buildEntryCohort — 20-bar range + position_in_range_pct + entry_zone
// ======================================================================

describe("buildEntryCohort — 20-bar locator + entry_zone", () => {
  it("bars.length < 20 → no position_in_range_pct, no entry_zone (insufficient n)", () => {
    const cohort = buildEntryCohort(makeBars([{ high: 110, low: 90, close: 100 }]), 100, undefined);
    expect(cohort.position_in_range_pct).toBeUndefined();
    expect(cohort.entry_zone).toBeUndefined();
  });

  it("bars >= 20 + price at midpoint (50% of range) → equilibrium", () => {
    const bars = makeBars(
      Array.from({ length: 20 }, () => ({ high: 110, low: 90, close: 100 }))
    );
    const cohort = buildEntryCohort(bars, 100, undefined);
    expect(cohort.position_in_range_pct).toBe(50);
    expect(cohort.entry_zone).toBe("equilibrium");
  });

  it("price >= 60% of range → premium (boundary inclusive)", () => {
    const bars = makeBars(
      Array.from({ length: 20 }, () => ({ high: 100, low: 0, close: 50 }))
    );
    const cohort = buildEntryCohort(bars, 60, undefined);
    expect(cohort.position_in_range_pct).toBe(60);
    expect(cohort.entry_zone).toBe("premium");
  });

  it("price <= 40% of range → discount (boundary inclusive)", () => {
    const bars = makeBars(
      Array.from({ length: 20 }, () => ({ high: 100, low: 0, close: 50 }))
    );
    const cohort = buildEntryCohort(bars, 40, undefined);
    expect(cohort.position_in_range_pct).toBe(40);
    expect(cohort.entry_zone).toBe("discount");
  });

  it("price strictly between 40% and 60% → equilibrium", () => {
    const bars = makeBars(
      Array.from({ length: 20 }, () => ({ high: 100, low: 0, close: 50 }))
    );
    const cohort = buildEntryCohort(bars, 55, undefined);
    expect(cohort.position_in_range_pct).toBeCloseTo(55, 5);
    expect(cohort.entry_zone).toBe("equilibrium");
  });

  it("currentPrice ABOVE swing high → clamped to 100% + premium classification", () => {
    const bars = makeBars(
      Array.from({ length: 20 }, () => ({ high: 100, low: 0, close: 50 }))
    );
    const cohort = buildEntryCohort(bars, 110, undefined); // 10% above swing high
    expect(cohort.position_in_range_pct).toBe(100);
    expect(cohort.entry_zone).toBe("premium");
  });

  it("currentPrice BELOW swing low → clamped to 0% + discount classification", () => {
    const bars = makeBars(
      Array.from({ length: 20 }, () => ({ high: 100, low: 0, close: 50 }))
    );
    const cohort = buildEntryCohort(bars, -10, undefined); // below swing low
    expect(cohort.position_in_range_pct).toBe(0);
    expect(cohort.entry_zone).toBe("discount");
  });

  it("swing high == swing low (degenerate flat market) → no position_in_range_pct (div-by-zero guard)", () => {
    const bars = makeBars(Array.from({ length: 20 }, () => ({ high: 100, low: 100, close: 100 })));
    const cohort = buildEntryCohort(bars, 100, undefined);
    expect(cohort.position_in_range_pct).toBeUndefined();
    expect(cohort.entry_zone).toBeUndefined();
  });

  it("uses ONLY the last 20 bars even when more provided (sliding window)", () => {
    // 30 bars: first 10 huge range (0-1000), last 20 narrow (90-110)
    const wideEarly = Array.from({ length: 10 }, () => ({ high: 1000, low: 0, close: 500 }));
    const narrowLate = Array.from({ length: 20 }, () => ({ high: 110, low: 90, close: 100 }));
    const bars = makeBars([...wideEarly, ...narrowLate]);
    const cohort = buildEntryCohort(bars, 100, undefined);
    // Range comes from LAST 20 bars (90-110), price at midpoint 100 → 50%
    expect(cohort.position_in_range_pct).toBe(50);
  });
});

// ======================================================================
// buildEntryReason — composition through Zod schema
// ======================================================================

describe("buildEntryReason — Zod-validated entry_reason composition", () => {
  const conditions: Array<TechnicalCondition | PatternCondition> = [
    { type: "technical", indicator: "rsi", operator: "less_than", value: 50, timeframe: "4h" } as TechnicalCondition,
    { type: "pattern", pattern: "fvg", lookback: 5, direction: "bullish" } as PatternCondition,
  ];

  it("conditions snapshotted via mock + spread into conditions_met array", () => {
    const cohort: Partial<EntryCohort> = { entry_hour_utc: 12, entry_zone: "discount" };
    const reason = buildEntryReason(conditions, undefined, cohort);
    expect(mockedSnapshot).toHaveBeenCalledTimes(2);
    expect(reason.conditions_met).toHaveLength(2);
  });

  it("sentiment present → signal_result populated with signal/confidence/reasoning", () => {
    const sentiment: SignalResult = { signal: "buy", confidence: 80, reasoning: "bullish news" };
    const cohort: Partial<EntryCohort> = { entry_hour_utc: 12 };
    const reason = buildEntryReason([], sentiment, cohort);
    expect(reason.signal_result).toEqual({ signal: "buy", confidence: 80, reasoning: "bullish news" });
  });

  it("sentiment undefined → signal_result undefined (NOT explicit null)", () => {
    const cohort: Partial<EntryCohort> = { entry_hour_utc: 12 };
    const reason = buildEntryReason([], undefined, cohort);
    expect(reason.signal_result).toBeUndefined();
  });

  it("cohort non-empty → cohort field populated", () => {
    const cohort: Partial<EntryCohort> = { entry_hour_utc: 12, entry_zone: "premium" };
    const reason = buildEntryReason([], undefined, cohort);
    expect(reason.cohort).toMatchObject({ entry_hour_utc: 12, entry_zone: "premium" });
  });

  it("cohort empty object → cohort field undefined (don't persist empty obj)", () => {
    const reason = buildEntryReason([], undefined, {});
    expect(reason.cohort).toBeUndefined();
  });

  it("output passes through Zod schema validation (would throw on shape drift)", () => {
    const cohort: Partial<EntryCohort> = { entry_hour_utc: 12 };
    const reason = buildEntryReason(conditions, undefined, cohort);
    // Re-parsing the output should be a no-op
    expect(() => entryReasonSchema.parse(reason)).not.toThrow();
  });
});
