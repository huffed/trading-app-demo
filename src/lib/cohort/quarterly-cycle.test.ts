/**
 * H.5 quarterly-cycle tests. Locks: cycle-id computation across all 4
 * quarters + year boundary, next-cycle-at math, markdown rendering
 * shape (4 spec'd sections), report payload structure, 0-algo
 * graceful behavior, alpha-library JSONB shape resilience.
 */
import { describe, expect, it } from "vitest";
import {
  buildQuarterlyCycleReport,
  cycleIdFor,
  nextCycleAt,
  renderCycleMarkdown,
} from "./quarterly-cycle";
import type { SupabaseClient } from "@supabase/supabase-js";

// ─── pure: cycle-id math ──────────────────────────────────────────────

describe("cycleIdFor", () => {
  it("Q1 covers Jan/Feb/Mar UTC", () => {
    expect(cycleIdFor(new Date("2026-01-15T12:00:00Z"))).toBe("2026-Q1");
    expect(cycleIdFor(new Date("2026-03-31T23:59:59Z"))).toBe("2026-Q1");
  });
  it("Q2 covers Apr/May/Jun", () => {
    expect(cycleIdFor(new Date("2026-04-01T00:00:00Z"))).toBe("2026-Q2");
    expect(cycleIdFor(new Date("2026-06-30T23:59:59Z"))).toBe("2026-Q2");
  });
  it("Q3 covers Jul/Aug/Sep", () => {
    expect(cycleIdFor(new Date("2026-07-01T00:00:00Z"))).toBe("2026-Q3");
    expect(cycleIdFor(new Date("2026-09-30T23:59:59Z"))).toBe("2026-Q3");
  });
  it("Q4 covers Oct/Nov/Dec", () => {
    expect(cycleIdFor(new Date("2026-10-01T00:00:00Z"))).toBe("2026-Q4");
    expect(cycleIdFor(new Date("2026-12-31T23:59:59Z"))).toBe("2026-Q4");
  });
});

describe("nextCycleAt", () => {
  it("Q1 → Q2 starts Apr 1", () => {
    expect(nextCycleAt(new Date("2026-01-15T12:00:00Z")).toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });
  it("Q2 → Q3 starts Jul 1", () => {
    expect(nextCycleAt(new Date("2026-05-15T12:00:00Z")).toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });
  it("Q3 → Q4 starts Oct 1", () => {
    expect(nextCycleAt(new Date("2026-08-15T12:00:00Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
  it("Q4 → next year Q1 starts Jan 1 of next year (year boundary)", () => {
    expect(nextCycleAt(new Date("2026-11-15T12:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(nextCycleAt(new Date("2026-12-31T23:59:59Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
  it("exactly on quarter boundary returns next quarter (not same)", () => {
    expect(nextCycleAt(new Date("2026-04-01T00:00:00Z")).toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });
});

// ─── DB integration via mock ──────────────────────────────────────────

function fakeSupabase(opts: {
  algoRows?: {
    id: string; name: string; status: string; live_trading_enabled: boolean | null;
    backtest_results: Record<string, unknown> | null;
    algorithm_watchlist?: { ticker: string }[];
  }[];
  activeAlgosForDecay?: { id: string; name: string; status: string; live_trading_enabled?: boolean; user_id?: string; backtest_results: { sharpe_ratio?: number } | null }[];
  positionsByAlgo?: Record<string, unknown[]>;
} = {}) {
  return {
    from: (table: string) => {
      if (table === "algorithms") {
        return {
          select: () => ({
            // `.in(...).order(...)` chain — used by buildAlphaLibrarySnapshot
            in: () => ({
              order: () => Promise.resolve({ data: opts.algoRows ?? [], error: null }),
            }),
            // `.eq(...)` — used by buildAlphaDecaySummary
            eq: () => Promise.resolve({ data: opts.activeAlgosForDecay ?? [], error: null }),
            // Direct `.order(...)` — defensive fallback
            order: () => Promise.resolve({ data: opts.algoRows ?? [], error: null }),
          }),
        };
      }
      if (table === "paper_positions") {
        return {
          select: () => ({
            eq: (_col1: string, val1: string) => ({
              eq: () => ({
                gte: () => Promise.resolve({ data: opts.positionsByAlgo?.[val1] ?? [], error: null }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
}

describe("buildQuarterlyCycleReport (DB integration via mock)", () => {
  const T0 = new Date("2026-06-23T18:00:00Z");

  it("0 algos → returns valid report with empty alpha_library + 0-evaluated decay", async () => {
    const r = await buildQuarterlyCycleReport(fakeSupabase({}), T0);
    expect(r.cycle_id).toBe("2026-Q2");
    expect(r.next_cycle_at).toBe("2026-07-01T00:00:00.000Z");
    expect(r.alpha_library).toEqual([]);
    expect(r.decay.evaluated).toBe(0);
    expect(r.feature_library.total_count).toBeGreaterThanOrEqual(30); // H.2 floor
    expect(r.markdown).toContain("Quarterly Research Cycle — 2026-Q2");
  });

  it("populated alpha library — extracts JSONB stats correctly", async () => {
    const r = await buildQuarterlyCycleReport(
      fakeSupabase({
        algoRows: [{
          id: "a1", name: "Test Algo", status: "active", live_trading_enabled: true,
          algorithm_watchlist: [{ ticker: "XAU/USD" }],
          backtest_results: {
            step2: { total_return: 5908, max_static_dd: 6.31, win_rate: 36.7, total_trades: 177 },
            sharpe_ratio: 0.26,
            statistical_rigor: {
              deflated: {
                deflated_sharpe: { deflatedSharpe: 0.983 },
                pbo: { probabilityOfBacktestOverfitting: 0.229 },
              },
            },
          },
        }],
      }),
      T0,
    );
    expect(r.alpha_library).toHaveLength(1);
    const a = r.alpha_library[0];
    expect(a.algorithm_name).toBe("Test Algo");
    expect(a.ticker).toBe("XAU/USD");
    expect(a.baseline_total_return).toBe(5908);
    expect(a.baseline_max_drawdown).toBe(6.31);
    expect(a.baseline_sharpe).toBe(0.26);
    expect(a.deflated_sharpe).toBe(0.983);
    expect(a.pbo).toBe(0.229);
  });

  it("resilient to missing/partial backtest_results fields", async () => {
    const r = await buildQuarterlyCycleReport(
      fakeSupabase({
        algoRows: [
          { id: "a1", name: "No baseline", status: "draft", live_trading_enabled: false, backtest_results: null, algorithm_watchlist: [] },
          { id: "a2", name: "Partial", status: "paused", live_trading_enabled: false, backtest_results: { step2: { total_return: 100 } } },
        ],
      }),
      T0,
    );
    expect(r.alpha_library).toHaveLength(2);
    expect(r.alpha_library[0].baseline_total_return).toBeNull();
    expect(r.alpha_library[0].deflated_sharpe).toBeNull();
    expect(r.alpha_library[1].baseline_total_return).toBe(100);
    expect(r.alpha_library[1].baseline_max_drawdown).toBeNull();
  });
});

// ─── markdown rendering shape ─────────────────────────────────────────

describe("renderCycleMarkdown", () => {
  const baseReport = {
    cycle_id: "2026-Q3",
    generated_at: "2026-07-01T00:00:00.000Z",
    next_cycle_at: "2026-10-01T00:00:00.000Z",
    feature_library: {
      total_count: 48,
      by_category: { volatility: 8, momentum: 6, trend: 6, structure: 5, time: 4, volume: 2, context: 3, pattern: 14 },
      feature_names: ["atr14", "rsi14"],
    },
    alpha_library: [],
    decay: {
      generated_at: "2026-07-01T00:00:00.000Z",
      evaluated: 0,
      per_algo: [],
      paused: [],
      counts: { none: 0, warn: 0, decay: 0, insufficient_data: 0, no_baseline: 0 },
      source: "snapshot" as const,
    },
  };

  it("includes all 4 spec'd sections", () => {
    const md = renderCycleMarkdown(baseReport);
    expect(md).toContain("## 1. Feature library refresh");
    expect(md).toContain("## 2. Alpha library snapshot");
    expect(md).toContain("## 3. Alpha decay report");
    expect(md).toContain("## 4. New-hypothesis log");
  });

  it("includes cycle-id in H1 header", () => {
    expect(renderCycleMarkdown(baseReport)).toContain("# Quarterly Research Cycle — 2026-Q3");
  });

  it("includes generated_at + next_cycle_at metadata", () => {
    const md = renderCycleMarkdown(baseReport);
    expect(md).toContain("**Generated:** 2026-07-01T00:00:00.000Z");
    expect(md).toContain("**Next cycle:** 2026-10-01T00:00:00.000Z");
  });

  it("renders feature category table with all 8 categories", () => {
    const md = renderCycleMarkdown(baseReport);
    expect(md).toContain("| volatility | 8 |");
    expect(md).toContain("| pattern | 14 |");
    expect(md).toContain("**Total features:** 48");
  });

  it("renders empty-alpha-library message when alpha_library is []", () => {
    expect(renderCycleMarkdown(baseReport)).toContain("_No active or paused algorithms — nothing to snapshot._");
  });

  it("renders alpha rows with stats when alpha_library populated", () => {
    const md = renderCycleMarkdown({
      ...baseReport,
      alpha_library: [{
        algorithm_id: "a1", algorithm_name: "EngLong", status: "active",
        live_trading_enabled: true, ticker: "XAU/USD",
        baseline_total_return: 5908, baseline_max_drawdown: 6.31, baseline_sharpe: 0.26,
        baseline_win_rate: 36.7, baseline_total_trades: 177,
        deflated_sharpe: 0.983, pbo: 0.229,
      }],
    });
    expect(md).toContain("| EngLong | active | yes | 5908 | 6.31% | 0.260 | 0.983 | 0.229 | 177 |");
  });

  it("renders decay severity counts table", () => {
    const md = renderCycleMarkdown(baseReport);
    expect(md).toContain("| decay | 0 |");
    expect(md).toContain("| warn | 0 |");
    expect(md).toContain("| none | 0 |");
  });

  it("hypothesis-log section is a TEMPLATE prompt (operator fills in)", () => {
    const md = renderCycleMarkdown(baseReport);
    expect(md).toContain("Operator-maintained");
    expect(md).toContain("- [ ]");
  });
});
