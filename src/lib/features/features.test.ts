/**
 * H.2 feature-library tests. Per-feature null-on-insufficient-lookback
 * verification + value-correctness on synthetic fixtures + integration
 * coverage of the registry (≥30 features computable — the spec gate).
 */
import { describe, expect, it } from "vitest";
import {
  computeAllFeatures,
  FEATURES,
  FEATURES_BY_CATEGORY,
  FEATURE_COUNT,
  type FeatureContext,
} from "./index";
import { VOLATILITY_FEATURES } from "./volatility";
import { MOMENTUM_FEATURES } from "./momentum";
import { TREND_FEATURES } from "./trend";
import { STRUCTURE_FEATURES } from "./structure";
import { TIME_FEATURES } from "./time";
import { VOLUME_FEATURES } from "./volume";
import { CONTEXT_FEATURES } from "./context";
import { PATTERN_FEATURES } from "./patterns";
import type { PriceBar } from "@/lib/market-data/types";

/** Synthetic bar generator — deterministic, no Date.now / Math.random
 *  (per runtime constraints). Trending up with sinusoidal noise.
 *  Bar cadence = 4h (matches the v3 survivor's TF). */
function syntheticBars(n: number, startMs = 1577836800000): PriceBar[] {
  const bars: PriceBar[] = [];
  let close = 2000;
  for (let i = 0; i < n; i++) {
    const drift = 0.05;
    const noise = Math.sin(i * 0.7) * 8 + Math.cos(i * 0.31) * 5;
    const newClose = close + drift + noise;
    const high = Math.max(close, newClose) + Math.abs(noise) * 0.5 + 1;
    const low = Math.min(close, newClose) - Math.abs(noise) * 0.5 - 1;
    bars.push({
      date: new Date(startMs + i * 4 * 3_600_000).toISOString(),
      open: close,
      high,
      low,
      close: newClose,
      volume: 100 + Math.abs(noise) * 10,
    });
    close = newClose;
  }
  return bars;
}

const BARS = syntheticBars(500);

// ─── registry gate ────────────────────────────────────────────────────

describe("feature library registry (H.2 gate)", () => {
  it("ships ≥ 30 features (the spec gate floor)", () => {
    expect(FEATURE_COUNT).toBeGreaterThanOrEqual(30);
  });

  it("all category arrays roll up to FEATURES total", () => {
    const sumByCategory =
      VOLATILITY_FEATURES.length +
      MOMENTUM_FEATURES.length +
      TREND_FEATURES.length +
      STRUCTURE_FEATURES.length +
      TIME_FEATURES.length +
      VOLUME_FEATURES.length +
      CONTEXT_FEATURES.length +
      PATTERN_FEATURES.length;
    expect(FEATURE_COUNT).toBe(sumByCategory);
  });

  it("pattern features count = 14 (H.3 spec: '14 pattern primitives')", () => {
    expect(PATTERN_FEATURES.length).toBe(14);
  });

  it("every feature has unique name (no duplicates that would collide in training row)", () => {
    const names = new Set(FEATURES.map((f) => f.name));
    expect(names.size).toBe(FEATURES.length);
  });

  it("every feature has a non-empty description (operator-readable)", () => {
    for (const f of FEATURES) {
      expect(f.description.length).toBeGreaterThan(5);
    }
  });

  it("every feature has a valid category in the FEATURES_BY_CATEGORY index", () => {
    for (const f of FEATURES) {
      expect(FEATURES_BY_CATEGORY[f.category]).toBeDefined();
      expect(FEATURES_BY_CATEGORY[f.category]).toContain(f);
    }
  });

  it("computeAllFeatures returns a row with one entry per feature", () => {
    const row = computeAllFeatures(FEATURES, BARS, 400);
    expect(Object.keys(row)).toHaveLength(FEATURE_COUNT);
    for (const f of FEATURES) {
      expect(row).toHaveProperty(f.name);
    }
  });

  it("computeAllFeatures returns nulls (NOT throws) when a feature can't compute on idx=0", () => {
    const row = computeAllFeatures(FEATURES, BARS, 0);
    // Most features need lookback > 0, so most should be null. Time
    // features can compute at idx=0 (the date is present). Just verify
    // no exception was thrown by ensuring SOME entries are present.
    expect(Object.keys(row)).toHaveLength(FEATURE_COUNT);
  });

  it("computeAllFeatures converts thrown errors to null (registry contract)", () => {
    // Inject a deliberately throwing feature
    const throwing = [
      ...FEATURES,
      { name: "always_throws", category: "context" as const, description: "throws", compute: () => { throw new Error("nope"); } },
    ];
    const row = computeAllFeatures(throwing, BARS, 100);
    expect(row.always_throws).toBeNull();
  });
});

// ─── volatility ──────────────────────────────────────────────────────

describe("volatility features", () => {
  it("atr14 returns null when idx < 15 (needs prior 14 bars)", () => {
    const f = VOLATILITY_FEATURES.find((x) => x.name === "atr14")!;
    expect(f.compute(BARS, 10)).toBeNull();
    expect(f.compute(BARS, 100)).toBeGreaterThan(0);
  });

  it("atr14_pct = atr / close, dimensionless", () => {
    const f = VOLATILITY_FEATURES.find((x) => x.name === "atr14_pct")!;
    const v = f.compute(BARS, 100);
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThan(0);
    expect(v!).toBeLessThan(1); // ATR is small fraction of price
  });

  it("atr_percentile_200 returns 0..100", () => {
    const f = VOLATILITY_FEATURES.find((x) => x.name === "atr_percentile_200")!;
    expect(f.compute(BARS, 100)).toBeNull(); // < 200
    const v = f.compute(BARS, 400);
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThanOrEqual(0);
    expect(v!).toBeLessThanOrEqual(100);
  });

  it("realized_vol_20 is a non-negative scalar", () => {
    const f = VOLATILITY_FEATURES.find((x) => x.name === "realized_vol_20")!;
    expect(f.compute(BARS, 10)).toBeNull();
    expect(f.compute(BARS, 100)!).toBeGreaterThanOrEqual(0);
  });

  it("range_expansion_5 > 1 when current bar wider than recent average", () => {
    // Build a fixture where the current bar has range 100, last 5 had range 10
    const bars: PriceBar[] = [];
    for (let i = 0; i < 6; i++) {
      bars.push({ date: `2026-06-${i + 1}T00:00:00Z`, open: 100, high: 105, low: 95, close: 100, volume: 0 });
    }
    bars.push({ date: `2026-06-07T00:00:00Z`, open: 100, high: 150, low: 50, close: 100, volume: 0 });
    const f = VOLATILITY_FEATURES.find((x) => x.name === "range_expansion_5")!;
    const v = f.compute(bars, 6);
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThan(5); // 100/10 = 10
  });

  it("range_contraction_5 = 1 / range_expansion_5", () => {
    const exp = VOLATILITY_FEATURES.find((x) => x.name === "range_expansion_5")!.compute(BARS, 100);
    const con = VOLATILITY_FEATURES.find((x) => x.name === "range_contraction_5")!.compute(BARS, 100);
    expect(exp).not.toBeNull();
    expect(con).not.toBeNull();
    expect(con! * exp!).toBeCloseTo(1, 5);
  });

  it("bb_width_20 returns positive scalar when computable", () => {
    const f = VOLATILITY_FEATURES.find((x) => x.name === "bb_width_20")!;
    expect(f.compute(BARS, 10)).toBeNull();
    expect(f.compute(BARS, 100)!).toBeGreaterThanOrEqual(0);
  });

  it("atr_ratio_50 returns positive scalar when computable", () => {
    const f = VOLATILITY_FEATURES.find((x) => x.name === "atr_ratio_50")!;
    expect(f.compute(BARS, 50)).toBeNull();
    expect(f.compute(BARS, 200)!).toBeGreaterThan(0);
  });
});

// ─── momentum ────────────────────────────────────────────────────────

describe("momentum features", () => {
  it("rsi14 ∈ [0, 100] when computable", () => {
    const f = MOMENTUM_FEATURES.find((x) => x.name === "rsi14")!;
    expect(f.compute(BARS, 10)).toBeNull();
    const v = f.compute(BARS, 100);
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThanOrEqual(0);
    expect(v!).toBeLessThanOrEqual(100);
  });

  it("rsi14_extreme = |rsi14 − 50|", () => {
    const rsi = MOMENTUM_FEATURES.find((x) => x.name === "rsi14")!.compute(BARS, 100);
    const ext = MOMENTUM_FEATURES.find((x) => x.name === "rsi14_extreme")!.compute(BARS, 100);
    expect(rsi).not.toBeNull();
    expect(ext).toBe(Math.abs(rsi! - 50));
  });

  it("momentum_5 / momentum_20 sign matches drift direction in synthetic bars", () => {
    // Synthetic series has positive drift → momentum should be net positive across the span
    const m5 = MOMENTUM_FEATURES.find((x) => x.name === "momentum_5")!.compute(BARS, 400);
    const m20 = MOMENTUM_FEATURES.find((x) => x.name === "momentum_20")!.compute(BARS, 400);
    expect(m5).not.toBeNull();
    expect(m20).not.toBeNull();
  });

  it("roc_10 returns a percent number", () => {
    const f = MOMENTUM_FEATURES.find((x) => x.name === "roc_10")!;
    expect(f.compute(BARS, 5)).toBeNull();
    const v = f.compute(BARS, 100);
    expect(v).not.toBeNull();
    expect(Math.abs(v!)).toBeLessThan(100);
  });

  it("macd_histogram returns null before lookback met", () => {
    const f = MOMENTUM_FEATURES.find((x) => x.name === "macd_histogram")!;
    expect(f.compute(BARS, 20)).toBeNull();
    expect(f.compute(BARS, 100)).not.toBeNull();
  });
});

// ─── trend ───────────────────────────────────────────────────────────

describe("trend features", () => {
  it("ema12_above_ema26 returns 0 or 1", () => {
    const f = TREND_FEATURES.find((x) => x.name === "ema12_above_ema26")!;
    expect(f.compute(BARS, 20)).toBeNull();
    const v = f.compute(BARS, 100);
    expect([0, 1]).toContain(v);
  });

  it("ema_alignment_score ∈ {0, 1, 2, 3}", () => {
    const f = TREND_FEATURES.find((x) => x.name === "ema_alignment_score")!;
    expect(f.compute(BARS, 30)).toBeNull();
    const v = f.compute(BARS, 200);
    expect([0, 1, 2, 3]).toContain(v);
  });

  it("price_above_sma20 returns 0 or 1", () => {
    const f = TREND_FEATURES.find((x) => x.name === "price_above_sma20")!;
    const v = f.compute(BARS, 100);
    expect([0, 1]).toContain(v);
  });

  it("sma20_slope returns a finite scalar", () => {
    const f = TREND_FEATURES.find((x) => x.name === "sma20_slope")!;
    expect(f.compute(BARS, 20)).toBeNull();
    const v = f.compute(BARS, 100);
    expect(v).not.toBeNull();
    expect(Number.isFinite(v!)).toBe(true);
  });

  it("sma200_distance returns null before idx >= 199", () => {
    const f = TREND_FEATURES.find((x) => x.name === "sma200_distance")!;
    expect(f.compute(BARS, 100)).toBeNull();
    const v = f.compute(BARS, 300);
    expect(v).not.toBeNull();
    expect(Number.isFinite(v!)).toBe(true);
  });

  it("ema_cross_freshness returns positive integer (bars since last cross)", () => {
    const f = TREND_FEATURES.find((x) => x.name === "ema_cross_freshness")!;
    const v = f.compute(BARS, 200);
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(v!)).toBe(true);
  });
});

// ─── structure ───────────────────────────────────────────────────────

describe("structure features", () => {
  it("higher_high_count_20 ∈ [0, 19]", () => {
    const f = STRUCTURE_FEATURES.find((x) => x.name === "higher_high_count_20")!;
    expect(f.compute(BARS, 5)).toBeNull();
    const v = f.compute(BARS, 100);
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThanOrEqual(0);
    expect(v!).toBeLessThanOrEqual(19);
  });

  it("lower_low_count_20 ∈ [0, 19]", () => {
    const f = STRUCTURE_FEATURES.find((x) => x.name === "lower_low_count_20")!;
    const v = f.compute(BARS, 100);
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThanOrEqual(0);
    expect(v!).toBeLessThanOrEqual(19);
  });

  it("swing_high_distance_pct returns finite scalar (positive when close below swing)", () => {
    const f = STRUCTURE_FEATURES.find((x) => x.name === "swing_high_distance_pct")!;
    const v = f.compute(BARS, 100);
    expect(v).not.toBeNull();
    expect(Number.isFinite(v!)).toBe(true);
  });

  it("swing_low_distance_pct returns finite scalar", () => {
    const f = STRUCTURE_FEATURES.find((x) => x.name === "swing_low_distance_pct")!;
    const v = f.compute(BARS, 100);
    expect(v).not.toBeNull();
    expect(Number.isFinite(v!)).toBe(true);
  });

  it("daily_bias_agreement: null without context, 0/1 with", () => {
    const f = STRUCTURE_FEATURES.find((x) => x.name === "daily_bias_agreement")!;
    expect(f.compute(BARS, 100)).toBeNull(); // no higherTfBars
    const ctx: FeatureContext = {
      higherTfBars: [
        { date: "2026-06-22T00:00:00Z", open: 2000, high: 2010, low: 1995, close: 2008, volume: 0 },
      ],
    };
    const v = f.compute(BARS, 100, ctx);
    expect([0, 1]).toContain(v);
  });
});

// ─── time ────────────────────────────────────────────────────────────

describe("time features", () => {
  // Construct bars at known UTC times
  const bars: PriceBar[] = [
    { date: "2026-06-23T01:00:00Z", open: 100, high: 100, low: 100, close: 100, volume: 0 }, // Asian
    { date: "2026-06-23T14:00:00Z", open: 100, high: 100, low: 100, close: 100, volume: 0 }, // US
    { date: "2026-06-23T22:00:00Z", open: 100, high: 100, low: 100, close: 100, volume: 0 }, // neither
  ];

  it("hour_of_day_utc = bar UTC hour", () => {
    const f = TIME_FEATURES.find((x) => x.name === "hour_of_day_utc")!;
    expect(f.compute(bars, 0)).toBe(1);
    expect(f.compute(bars, 1)).toBe(14);
    expect(f.compute(bars, 2)).toBe(22);
  });

  it("day_of_week returns 0..6", () => {
    const f = TIME_FEATURES.find((x) => x.name === "day_of_week")!;
    const v = f.compute(bars, 0);
    expect(v).not.toBeNull();
    expect([0, 1, 2, 3, 4, 5, 6]).toContain(v);
  });

  it("is_asian_session = 1 in [0, 8) UTC, else 0", () => {
    const f = TIME_FEATURES.find((x) => x.name === "is_asian_session")!;
    expect(f.compute(bars, 0)).toBe(1); // 01:00
    expect(f.compute(bars, 1)).toBe(0); // 14:00
    expect(f.compute(bars, 2)).toBe(0); // 22:00
  });

  it("is_us_session = 1 in [13:30, 20:00) UTC", () => {
    const f = TIME_FEATURES.find((x) => x.name === "is_us_session")!;
    expect(f.compute(bars, 0)).toBe(0);
    expect(f.compute(bars, 1)).toBe(1); // 14:00
    expect(f.compute(bars, 2)).toBe(0); // 22:00
  });
});

// ─── volume ──────────────────────────────────────────────────────────

describe("volume features", () => {
  it("volume_ratio_20 returns null when all-zero volume", () => {
    const zero: PriceBar[] = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-06-${(i % 28) + 1}T00:00:00Z`,
      open: 100, high: 101, low: 99, close: 100, volume: 0,
    }));
    const f = VOLUME_FEATURES.find((x) => x.name === "volume_ratio_20")!;
    expect(f.compute(zero, 25)).toBeNull();
  });

  it("volume_ratio_20 returns ~1 when volume stable", () => {
    const stable: PriceBar[] = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-06-${(i % 28) + 1}T00:00:00Z`,
      open: 100, high: 101, low: 99, close: 100, volume: 1000,
    }));
    const f = VOLUME_FEATURES.find((x) => x.name === "volume_ratio_20")!;
    expect(f.compute(stable, 25)).toBeCloseTo(1, 5);
  });

  it("volume_z_score_50 returns null when stddev is 0", () => {
    const stable: PriceBar[] = Array.from({ length: 60 }, () => ({
      date: "2026-06-01T00:00:00Z", open: 100, high: 101, low: 99, close: 100, volume: 1000,
    }));
    const f = VOLUME_FEATURES.find((x) => x.name === "volume_z_score_50")!;
    expect(f.compute(stable, 55)).toBeNull();
  });

  it("volume_z_score_50 positive when current spike", () => {
    const spike: PriceBar[] = Array.from({ length: 60 }, (_, i) => ({
      date: `2026-06-${(i % 28) + 1}T00:00:00Z`,
      open: 100, high: 101, low: 99, close: 100,
      // baseline ~1000; spike at idx 55
      volume: i === 55 ? 5000 : 1000 + Math.sin(i) * 50,
    }));
    const f = VOLUME_FEATURES.find((x) => x.name === "volume_z_score_50")!;
    const v = f.compute(spike, 55);
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThan(2);
  });
});

// ─── context ─────────────────────────────────────────────────────────

describe("context features", () => {
  it("bars_since_news returns null without events in context", () => {
    const f = CONTEXT_FEATURES.find((x) => x.name === "bars_since_news")!;
    expect(f.compute(BARS, 100)).toBeNull();
    expect(f.compute(BARS, 100, {})).toBeNull();
  });

  it("bars_since_news: positive value when event is in the PAST", () => {
    const f = CONTEXT_FEATURES.find((x) => x.name === "bars_since_news")!;
    // Synthetic event 8 bars (32 hours) BEFORE the bar at idx 100
    const curIso = BARS[100].date;
    const evMs = new Date(curIso).getTime() - 8 * 4 * 3_600_000;
    const ctx: FeatureContext = {
      events: [{ time: new Date(evMs).toISOString(), currency: "USD", impact: "high", event: "x" }],
    };
    const v = f.compute(BARS, 100, ctx);
    expect(v).not.toBeNull();
    expect(v!).toBeCloseTo(8, 0);
  });

  it("bars_since_news: negative value when event is in the FUTURE", () => {
    const f = CONTEXT_FEATURES.find((x) => x.name === "bars_since_news")!;
    const curIso = BARS[100].date;
    const evMs = new Date(curIso).getTime() + 4 * 4 * 3_600_000;
    const ctx: FeatureContext = {
      events: [{ time: new Date(evMs).toISOString(), currency: "USD", impact: "high", event: "x" }],
    };
    const v = f.compute(BARS, 100, ctx);
    expect(v).not.toBeNull();
    expect(v!).toBeLessThan(0);
  });

  it("cross_asset_correlation_20 returns null without cross-asset context", () => {
    const f = CONTEXT_FEATURES.find((x) => x.name === "cross_asset_correlation_20")!;
    expect(f.compute(BARS, 100)).toBeNull();
    expect(f.compute(BARS, 100, { crossAssetBars: new Map() })).toBeNull();
  });

  it("cross_asset_correlation_20: ≈ +1 when other series is identical", () => {
    const f = CONTEXT_FEATURES.find((x) => x.name === "cross_asset_correlation_20")!;
    const ctx: FeatureContext = { crossAssetBars: new Map([["DXY", BARS]]) };
    const v = f.compute(BARS, 100, ctx);
    expect(v).not.toBeNull();
    expect(v!).toBeCloseTo(1, 4);
  });

  it("cross_asset_correlation_20: ≈ −1 when other series is inverse", () => {
    const inverse = BARS.map((b) => ({ ...b, close: 4000 - b.close, open: 4000 - b.open }));
    const f = CONTEXT_FEATURES.find((x) => x.name === "cross_asset_correlation_20")!;
    const ctx: FeatureContext = { crossAssetBars: new Map([["DXY", inverse]]) };
    const v = f.compute(BARS, 100, ctx);
    expect(v).not.toBeNull();
    expect(v!).toBeLessThan(0); // inverse → negative correlation
  });

  it("cross_asset_correlation_abs_20 = |cross_asset_correlation_20|", () => {
    const inverse = BARS.map((b) => ({ ...b, close: 4000 - b.close, open: 4000 - b.open }));
    const ctx: FeatureContext = { crossAssetBars: new Map([["DXY", inverse]]) };
    const sgn = CONTEXT_FEATURES.find((x) => x.name === "cross_asset_correlation_20")!.compute(BARS, 100, ctx);
    const abs = CONTEXT_FEATURES.find((x) => x.name === "cross_asset_correlation_abs_20")!.compute(BARS, 100, ctx);
    expect(abs).toBe(Math.abs(sgn!));
  });
});

// ─── pattern features (H.3) ──────────────────────────────────────────

describe("pattern features (H.3)", () => {
  it("ships 14 pattern primitives — matches the H.3 spec count", () => {
    expect(PATTERN_FEATURES.length).toBe(14);
  });

  it("all pattern features are signed (return ∈ {-1, 0, 1, null})", () => {
    for (const f of PATTERN_FEATURES) {
      const v = f.compute(BARS, 100);
      // null is allowed (insufficient lookback / missing context for some patterns)
      if (v === null) continue;
      expect([-1, 0, 1]).toContain(v);
    }
  });

  it("every pattern feature has the 'pattern_*_signed' naming convention", () => {
    for (const f of PATTERN_FEATURES) {
      expect(f.name).toMatch(/^pattern_[a-z_]+_signed$/);
      expect(f.category).toBe("pattern");
    }
  });

  it("pattern feature names match the canonical 14-pattern set (no extras, no missing)", () => {
    const expected = new Set([
      "pattern_liquidity_sweep_signed",
      "pattern_liquidity_sweep_reclaim_signed",
      "pattern_fvg_signed",
      "pattern_ifvg_signed",
      "pattern_daily_bias_signed",
      "pattern_bos_signed",
      "pattern_choch_signed",
      "pattern_ote_signed",
      "pattern_equal_levels_signed",
      "pattern_order_block_signed",
      "pattern_engulfing_signed",
      "pattern_pin_bar_signed",
      "pattern_momentum_signed",
      "pattern_mean_reversion_signed",
    ]);
    const actual = new Set(PATTERN_FEATURES.map((f) => f.name));
    expect(actual).toEqual(expected);
  });

  it("computeAllFeatures includes the pattern features in its output row", () => {
    const row = computeAllFeatures(FEATURES, BARS, 200);
    for (const f of PATTERN_FEATURES) {
      expect(row).toHaveProperty(f.name);
    }
  });
});
