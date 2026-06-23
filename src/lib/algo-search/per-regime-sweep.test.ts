/**
 * H.6 — Per-regime sweep tests. Covers result shape, regime
 * partitioning, single-model vs regime-routed comparison, DSR gate
 * verdict (literal-spec), and the saturated-baseline edge case where
 * the absolute +0.10 gate is unreachable.
 */
import { describe, expect, it } from "vitest";
import { runPerRegimeSweep } from "./per-regime-sweep";
import { REGIMES } from "../algorithm/regime-classifier";
import type { AlgorithmRules } from "@/types/algorithm";
import type { PriceBar } from "@/lib/market-data/types";

function makeRules(): AlgorithmRules {
  return {
    entry_conditions: [{ type: "pattern", pattern: "engulfing", side: "long" }],
    exit_conditions: [],
    entry_logic: "all",
    stop_loss: { type: "swing_anchor", value: 0.1, lookback: 6 },
    take_profit: { type: "rr_multiple", value: 3 },
    position_sizing: { type: "risk_per_trade", value: 0.6 },
    max_positions: 1,
    timeframe: "4h",
    asset_class: "commodity",
  } as unknown as AlgorithmRules;
}

function syntheticBars(n: number): PriceBar[] {
  const bars: PriceBar[] = [];
  let close = 2000;
  const T0 = new Date("2026-01-01T00:00:00Z").getTime();
  for (let i = 0; i < n; i++) {
    // Mix high-frequency + low-frequency noise so vol percentiles span
    // the full 0..100 range (otherwise classifyAllBars would put every
    // bar in the same tercile and the regime sweep would degenerate)
    const fast = Math.sin(i * 0.7) * 8;
    const slow = Math.cos(i * 0.05) * 20;
    const drift = 0.05;
    const newClose = close + drift + fast + slow;
    const high = Math.max(close, newClose) + 2;
    const low = Math.min(close, newClose) - 2;
    bars.push({
      date: new Date(T0 + i * 4 * 3_600_000).toISOString(),
      open: close,
      high,
      low,
      close: newClose,
      volume: 100,
    });
    close = newClose;
  }
  return bars;
}

describe("runPerRegimeSweep", () => {
  // Use enough bars to give classifyAllBars something to work with
  // (200 lookback + buffer for trades)
  const BARS = syntheticBars(800);
  const ALGO = {
    name: "LayerB: XAU/USD Engulfing-Long 4h | rr3_lb6_r06_rf0_af0",
    capital: 10000,
    rules: makeRules(),
    ticker: "XAU/USD",
    timeframe: "4h",
  };

  it("returns expected top-level fields", () => {
    const r = runPerRegimeSweep(ALGO, BARS);
    expect(r.ticker).toBe("XAU/USD");
    expect(r.timeframe).toBe("4h");
    expect(r.total_bars).toBe(800);
    expect(r.classified_bars).toBeGreaterThan(0);
    expect(r.classified_bars).toBeLessThanOrEqual(600); // bars - REGIME_LOOKBACK_BARS
    expect(r.total_variants).toBeGreaterThan(0);
    expect(r.total_variants).toBeLessThanOrEqual(96);
  }, 120_000);

  it("produces per-regime cells for all 3 regimes (some may have 0 trades)", () => {
    const r = runPerRegimeSweep(ALGO, BARS);
    expect(r.cells.length).toBeGreaterThan(0);
    for (const cell of r.cells.slice(0, 5)) {
      for (const regime of REGIMES) {
        expect(cell.per_regime).toHaveProperty(regime);
        expect(cell.per_regime[regime].regime).toBe(regime);
        expect(cell.per_regime[regime].n_trades).toBeGreaterThanOrEqual(0);
      }
    }
  }, 120_000);

  it("single_model winner is among the variants + has full_sharpe field", () => {
    const r = runPerRegimeSweep(ALGO, BARS);
    expect(r.single_model.variant_tag).toMatch(/^rr/);
    expect(Number.isFinite(r.single_model.sharpe)).toBe(true);
    expect(Number.isFinite(r.single_model.dsr)).toBe(true);
    expect(r.single_model.dsr).toBeGreaterThanOrEqual(0);
    expect(r.single_model.dsr).toBeLessThanOrEqual(1);
  }, 120_000);

  it("regime_routed: per_regime_best populated for all 3 regimes", () => {
    const r = runPerRegimeSweep(ALGO, BARS);
    for (const regime of REGIMES) {
      expect(r.regime_routed.per_regime_best).toHaveProperty(regime);
      const best = r.regime_routed.per_regime_best[regime];
      expect(best.variant_tag).toBeDefined();
      expect(Number.isFinite(best.sharpe)).toBe(true);
      expect(best.n_trades).toBeGreaterThanOrEqual(0);
    }
    expect(Number.isFinite(r.regime_routed.combined_sharpe)).toBe(true);
    expect(Number.isFinite(r.regime_routed.combined_dsr)).toBe(true);
  }, 120_000);

  it("dsr_delta = regime_routed.combined_dsr - single_model.dsr (consistent)", () => {
    const r = runPerRegimeSweep(ALGO, BARS);
    expect(r.dsr_delta).toBeCloseTo(r.regime_routed.combined_dsr - r.single_model.dsr, 8);
  }, 120_000);

  it("passes_gate is exactly dsr_delta >= 0.10 (literal spec)", () => {
    const r = runPerRegimeSweep(ALGO, BARS);
    expect(r.passes_gate).toBe(r.dsr_delta >= 0.10);
  }, 120_000);

  it("DSR values are bounded in [0, 1] (sanity — they're CDF outputs)", () => {
    const r = runPerRegimeSweep(ALGO, BARS);
    expect(r.single_model.dsr).toBeGreaterThanOrEqual(0);
    expect(r.single_model.dsr).toBeLessThanOrEqual(1);
    expect(r.regime_routed.combined_dsr).toBeGreaterThanOrEqual(0);
    expect(r.regime_routed.combined_dsr).toBeLessThanOrEqual(1);
  }, 120_000);
});
