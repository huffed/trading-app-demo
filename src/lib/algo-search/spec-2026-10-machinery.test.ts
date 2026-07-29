/**
 * Machinery tests for the 2026-10 Gold-Maximization + Forex round
 * (algo-search-2026-10.spec.md §7). Everything is OPT-IN — the first
 * block locks that the default enumeration is byte-compatible with the
 * closed 2026-06 round.
 */
import { describe, expect, it } from "vitest";
import type { AlgorithmRules } from "@/types/algorithm";
import { enumerateLayerACandidates, layerACardinality, SESSION_AXIS_WINDOWS } from "./enumerate";
import {
  enumerateLayerBVariants,
  layerBCardinality,
  slLookbacksForTimeframe,
  SL_LOOKBACKS,
} from "./layer-b-enumerate";
import {
  blendedWrPct,
  composePortfolio,
  DEFAULT_PORTFOLIO_COMPOSER_CONFIG,
  type CandidateInput,
} from "./portfolio-composer";
import { assertSpecFeasible, bootstrapPFloor, SPEC_2026_10 } from "./spec-2026-10";

// ---- Layer A axes ----------------------------------------------------

describe("enumerator — 2026-10 axes (opt-in)", () => {
  it("default enumeration is unchanged: 92 gold-only cells, legacy names/keys", () => {
    const cells = enumerateLayerACandidates();
    expect(cells).toHaveLength(92);
    for (const c of cells) {
      expect(c.bias).toBe("none");
      expect(c.session).toBe("all");
      expect(c.name).not.toContain("+Bias");
      expect(c.name).not.toContain("@");
      expect(c.cell_key.split("|")).toHaveLength(4); // legacy 4-part key
      expect(c.rules.session_filter).toBeUndefined();
      expect(
        c.rules.entry_conditions.some((e) => (e as { pattern?: string }).pattern === "daily_bias")
      ).toBe(false);
    }
  });

  it("axes-on gold-only = 424; axes + forex = the spec's N = 1,696", () => {
    expect(layerACardinality({ axes2026_10: true })).toBe(424);
    expect(layerACardinality({ axes2026_10: true, forex: true })).toBe(SPEC_2026_10.N_EXPECTED);
  });

  it("session axis applies to 30m/1h only; 4h cells stay session=all", () => {
    const cells = enumerateLayerACandidates({ axes2026_10: true });
    expect(cells.filter((c) => c.timeframe === "4h" && c.session !== "all")).toHaveLength(0);
    expect(cells.some((c) => c.timeframe === "1h" && c.session === "london")).toBe(true);
    expect(cells.some((c) => c.timeframe === "30m" && c.session === "newyork")).toBe(true);
  });

  it("biased cells carry a direction-aligned daily_bias condition; session cells carry session_filter", () => {
    const cells = enumerateLayerACandidates({ axes2026_10: true });
    const biasedShort = cells.find((c) => c.bias === "aligned" && c.side === "short")!;
    const biasCond = biasedShort.rules.entry_conditions.find(
      (e) => (e as { pattern?: string }).pattern === "daily_bias"
    ) as { direction?: string } | undefined;
    expect(biasCond?.direction).toBe("bearish");

    const london = cells.find((c) => c.session === "london")!;
    expect(london.rules.session_filter).toEqual(SESSION_AXIS_WINDOWS.london);
    expect(london.name).toContain("@london");
    expect(london.cell_key).toContain("|london");
  });

  it("cell keys are unique across the full 1,696-cell universe", () => {
    const cells = enumerateLayerACandidates({ axes2026_10: true, forex: true });
    expect(new Set(cells.map((c) => c.cell_key)).size).toBe(cells.length);
    expect(new Set(cells.map((c) => c.name)).size).toBe(cells.length);
  });
});

// ---- Layer B time-relative lookbacks ---------------------------------

function baseInput(timeframe: string) {
  return {
    name: "Search: XAU/USD BOS-Long 4h",
    ticker: "XAU/USD",
    capital: 10_000,
    rules: {
      timeframe,
      stop_loss: { type: "swing_anchor", value: 0.1, lookback: 4 },
      take_profit: { type: "rr_multiple", value: 3 },
      position_sizing: { type: "risk_per_trade", value: 1 },
      entry_conditions: [],
      exit_conditions: [],
    } as unknown as AlgorithmRules,
  };
}

describe("layer B — time-relative lookbacks (opt-in)", () => {
  it("hour→bar mapping per TF; throws on unmapped TF", () => {
    expect(slLookbacksForTimeframe("4h")).toEqual([3, 6, 12]);
    expect(slLookbacksForTimeframe("1h")).toEqual([12, 24, 48]);
    expect(slLookbacksForTimeframe("30m")).toEqual([24, 48, 96]);
    expect(() => slLookbacksForTimeframe("15m")).toThrow(/no bar mapping/);
  });

  it("legacy default reproduces the 2026-06 grid exactly", () => {
    const variants = enumerateLayerBVariants(baseInput("4h"));
    expect(variants).toHaveLength(96);
    const lbs = new Set(variants.map((v) => v.geometry.sl_lookback));
    expect([...lbs].sort((a, b) => a - b)).toEqual([...SL_LOOKBACKS]);
    // The deployed-variant tag reconstruction must keep working:
    expect(variants.some((v) => v.variant_tag === "rr25_lb4_r06_rf0_af0")).toBe(true);
  });

  it("time-relative mode maps by the base's timeframe; cardinality stays 96", () => {
    const variants = enumerateLayerBVariants(baseInput("30m"), { lookbackMode: "time-relative" });
    expect(variants).toHaveLength(layerBCardinality());
    const lbs = [...new Set(variants.map((v) => v.geometry.sl_lookback))].sort((a, b) => a - b);
    expect(lbs).toEqual([24, 48, 96]);
    expect(variants.some((v) => v.variant_tag.includes("lb96"))).toBe(true);
  });
});

// ---- Composer blended-WR gate ----------------------------------------

function candidate(id: string, wr: number, trades = 100): CandidateInput {
  // Tiny profitable series so DD/corr gates stay quiet.
  return {
    id,
    total_return: 500,
    per_trade_r: [0.5, 0.5, 0.5],
    exit_dates: ["2026-01-15", "2026-02-15", "2026-03-15"],
    per_trade_pnl_dollars: [50, 50, 50],
    max_drawdown_pct: 1,
    wins: Math.round((wr / 100) * trades),
    trades,
  };
}

describe("composer — blended-WR gate (opt-in)", () => {
  it("gate off by default: legacy config selects regardless of WR", () => {
    const out = composePortfolio([candidate("low-wr", 20)], DEFAULT_PORTFOLIO_COMPOSER_CONFIG);
    expect(out.selected).toEqual(["low-wr"]);
  });

  it("armed gate rejects a composition that drags the account blend under 35", () => {
    const cfg = {
      ...DEFAULT_PORTFOLIO_COMPOSER_CONFIG,
      min_blended_wr: 35,
      baseline_pool: { wins: 300, trades: 843 }, // ≈35.6% incumbents
    };
    const out = composePortfolio([candidate("dragger", 20, 500)], cfg);
    expect(out.selected).toEqual([]);
    expect(out.per_step_log.some((l) => l.action === "skipped_blended_wr")).toBe(true);
  });

  it("armed gate accepts when the pooled blend stays >= 35", () => {
    const cfg = {
      ...DEFAULT_PORTFOLIO_COMPOSER_CONFIG,
      min_blended_wr: 35,
      baseline_pool: { wins: 300, trades: 843 },
    };
    const out = composePortfolio([candidate("lifter", 42, 200)], cfg);
    expect(out.selected).toEqual(["lifter"]);
  });

  it("armed gate + candidate missing wins/trades → throws (never silently un-arms)", () => {
    const bare = { ...candidate("bare", 40) };
    delete (bare as Partial<CandidateInput>).wins;
    expect(() => blendedWrPct([bare as CandidateInput], null)).toThrow(/lacks wins\/trades/);
  });
});

// ---- Spec feasibility asserts ----------------------------------------

describe("spec-2026-10 feasibility asserts", () => {
  it("p-floor math + the locked constants are mutually feasible", () => {
    expect(bootstrapPFloor(20_000)).toBeCloseTo(0.5 / 20_001, 12);
    expect(() => assertSpecFeasible(SPEC_2026_10.N_EXPECTED)).not.toThrow();
  });

  it("cell-count drift aborts", () => {
    expect(() => assertSpecFeasible(1_695)).toThrow(/spec drift/);
  });

  it("unpassable-by-construction bootstrap aborts (E2.25.g class)", () => {
    expect(() => assertSpecFeasible(SPEC_2026_10.N_EXPECTED, 10_000)).toThrow(/unpassable-by-construction/);
  });

  it("the REAL enumerator satisfies the spec's N", () => {
    expect(() =>
      assertSpecFeasible(layerACardinality({ axes2026_10: true, forex: true }))
    ).not.toThrow();
  });
});
