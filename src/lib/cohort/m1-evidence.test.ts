/**
 * Unit tests for the M1 evidence tracker (G.8 gate comparator).
 *
 * Locks: canonical R math (initial_stop anchor, side-signed, null on
 * broken rows), evidence-clock filter, band/tracking-ratio math, status
 * transitions (no_trades → accruing → gate_reached), per-algo baseline
 * name-matching, excluded-row honesty, display cap.
 */
import { describe, expect, it } from "vitest";
import { M1_BASELINE, type M1Baseline } from "./m1-baseline";
import { buildM1Evidence } from "./m1-evidence";
import type { SupabaseClient } from "@supabase/supabase-js";

interface Captured {
  algoEq?: [string, unknown];
  posIn?: [string, unknown];
  posGte?: [string, unknown];
}

function makeSupabase(
  algos: Array<Record<string, unknown>> | { error: string },
  positions: Array<Record<string, unknown>> = [],
  captured: Captured = {}
): SupabaseClient {
  return {
    from(table: string) {
      if (table === "algorithms") {
        return {
          select: () => ({
            eq: (col: string, val: unknown) => {
              captured.algoEq = [col, val];
              if ("error" in algos && !Array.isArray(algos)) {
                return Promise.resolve({ data: null, error: { message: algos.error } });
              }
              return Promise.resolve({ data: algos, error: null });
            },
          }),
        };
      }
      if (table === "paper_positions") {
        return {
          select: () => ({
            in: (col: string, ids: unknown) => {
              captured.posIn = [col, ids];
              return {
                gte: (col2: string, val2: unknown) => {
                  captured.posGte = [col2, val2];
                  return {
                    order: () => Promise.resolve({ data: positions, error: null }),
                  };
                },
              };
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
}

function makeBaseline(overrides: Partial<M1Baseline> = {}): M1Baseline {
  return {
    ...M1_BASELINE,
    gate: { min_trades: 30, tolerance_pct: 30 },
    portfolio: { ...M1_BASELINE.portfolio, mean_r: 0.25 },
    ...overrides,
  };
}

const ALGO_A = {
  id: "algo-a",
  name: "Deploy: XAU/USD ARB+DailyBias 4h | r085 v1", // matches baseline live_name
  capital: 100_000,
};
const ALGO_B = { id: "algo-b", name: "Deploy: Future Addition", capital: 100_000 };

let positionSeq = 0;
function makePosition(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  positionSeq++;
  return {
    id: `pos-${positionSeq}`,
    algorithm_id: "algo-a",
    ticker: "XAU/USD",
    side: "long",
    status: "closed",
    quantity: 20,
    entry_price: 100,
    exit_price: 110,
    stop_loss_price: 95,
    initial_stop_loss_price: 95,
    opened_at: "2026-07-21T08:00:00Z",
    closed_at: "2026-07-21T16:00:00Z",
    exit_reason: "take_profit",
    ...overrides,
  };
}

describe("buildM1Evidence", () => {
  it("no active algos → empty no_trades result, positions never queried", async () => {
    const captured: Captured = {};
    const result = await buildM1Evidence(makeSupabase([], [], captured));
    expect(result.status).toBe("no_trades");
    expect(result.closed_trades).toBe(0);
    expect(result.per_algo).toEqual([]);
    expect(result.trades).toEqual([]);
    expect(captured.posIn).toBeUndefined();
  });

  it("algos but no positions → no_trades with per-algo rows + baseline name-match", async () => {
    const result = await buildM1Evidence(makeSupabase([ALGO_A, ALGO_B]));
    expect(result.status).toBe("no_trades");
    expect(result.per_algo).toHaveLength(2);
    const a = result.per_algo.find((p) => p.algorithm_id === "algo-a")!;
    expect(a.baseline?.label).toBe("ARB rr3_lb3");
    const b = result.per_algo.find((p) => p.algorithm_id === "algo-b")!;
    expect(b.baseline).toBeNull();
    expect(result.realized_mean_r).toBeNull();
    expect(result.in_band).toBeNull();
    expect(result.tracking_ratio).toBeNull();
  });

  it("evidence-clock: positions filtered by opened_at >= clock_start; algos by status=active", async () => {
    const captured: Captured = {};
    await buildM1Evidence(makeSupabase([ALGO_A], [], captured));
    expect(captured.algoEq).toEqual(["status", "active"]);
    expect(captured.posGte).toEqual(["opened_at", M1_BASELINE.clock_start]);
    expect(captured.posIn).toEqual(["algorithm_id", ["algo-a"]]);
  });

  it("canonical R math: long win +2R, long loss −1R, short win +2R", async () => {
    const positions = [
      makePosition({ entry_price: 100, initial_stop_loss_price: 95, exit_price: 110 }), // +2R
      makePosition({ entry_price: 100, initial_stop_loss_price: 95, exit_price: 95 }), // −1R
      makePosition({
        side: "short",
        entry_price: 100,
        initial_stop_loss_price: 105,
        stop_loss_price: 105,
        exit_price: 90,
      }), // +2R
    ];
    const result = await buildM1Evidence(makeSupabase([ALGO_A], positions));
    expect(result.closed_trades).toBe(3);
    expect(result.realized_mean_r).toBeCloseTo((2 - 1 + 2) / 3, 10);
    expect(result.realized_win_rate_pct).toBeCloseTo((2 / 3) * 100, 10);
    const rs = result.trades.map((t) => t.r_multiple);
    expect(rs).toEqual([2, -1, 2]);
  });

  it("BE-moved stop: R anchors on initial_stop_loss_price, not the mutated stop", async () => {
    const positions = [
      makePosition({
        entry_price: 100,
        initial_stop_loss_price: 95,
        stop_loss_price: 100, // moved to BE mid-trade
        exit_price: 99,
      }),
    ];
    const result = await buildM1Evidence(makeSupabase([ALGO_A], positions));
    // (99 − 100) / (100 − 95) = −0.2 — NOT (99−100)/(100−100) = broken.
    expect(result.realized_mean_r).toBeCloseTo(-0.2, 10);
    expect(result.excluded_rows).toBe(0);
  });

  it("broken rows are EXCLUDED from the mean, not counted as 0R", async () => {
    const positions = [
      makePosition({ entry_price: 100, initial_stop_loss_price: 95, exit_price: 110 }), // +2R valid
      makePosition({ initial_stop_loss_price: 105, stop_loss_price: 105 }), // long w/ SL above entry → risk<0
      makePosition({ exit_price: null, closed_at: "2026-07-21T16:00:00Z" }), // closed w/o exit price
      makePosition({ initial_stop_loss_price: null, stop_loss_price: null }), // no stop at all
    ];
    const result = await buildM1Evidence(makeSupabase([ALGO_A], positions));
    expect(result.closed_trades).toBe(1);
    expect(result.excluded_rows).toBe(3);
    expect(result.realized_mean_r).toBeCloseTo(2, 10); // untainted by the broken rows
  });

  it("open positions: counted separately, no R, present in trades", async () => {
    const positions = [
      makePosition({ status: "open", exit_price: null, closed_at: null, exit_reason: null }),
      makePosition({ entry_price: 100, initial_stop_loss_price: 95, exit_price: 110 }),
    ];
    const result = await buildM1Evidence(makeSupabase([ALGO_A], positions));
    expect(result.open_positions).toBe(1);
    expect(result.closed_trades).toBe(1);
    expect(result.excluded_rows).toBe(0);
    const open = result.trades.find((t) => t.status === "open")!;
    expect(open.r_multiple).toBeNull();
  });

  it("band + tracking ratio: inside and outside the ±30% band", async () => {
    const baseline = makeBaseline(); // portfolio mean_r 0.25 → band [0.175, 0.325]
    // One trade at +0.2R → in band.
    const inBand = await buildM1Evidence(
      makeSupabase([ALGO_A], [makePosition({ entry_price: 100, initial_stop_loss_price: 95, exit_price: 101 })]),
      baseline
    );
    expect(inBand.band.lower_r).toBeCloseTo(0.175, 10);
    expect(inBand.band.upper_r).toBeCloseTo(0.325, 10);
    expect(inBand.realized_mean_r).toBeCloseTo(0.2, 10);
    expect(inBand.in_band).toBe(true);
    expect(inBand.tracking_ratio).toBeCloseTo(0.8, 10);

    // One trade at +2R → outside band.
    const outBand = await buildM1Evidence(
      makeSupabase([ALGO_A], [makePosition({ entry_price: 100, initial_stop_loss_price: 95, exit_price: 110 })]),
      baseline
    );
    expect(outBand.in_band).toBe(false);
    expect(outBand.tracking_ratio).toBeCloseTo(8, 10);
  });

  it("status transitions: accruing below min_trades, gate_reached at min_trades", async () => {
    const baseline = makeBaseline({ gate: { min_trades: 3, tolerance_pct: 30 } });
    const twoTrades = await buildM1Evidence(
      makeSupabase([ALGO_A], [makePosition(), makePosition()]),
      baseline
    );
    expect(twoTrades.status).toBe("accruing");

    const threeTrades = await buildM1Evidence(
      makeSupabase([ALGO_A], [makePosition(), makePosition(), makePosition()]),
      baseline
    );
    expect(threeTrades.status).toBe("gate_reached");
  });

  it("risk_pct_at_entry derived from initial SL distance × qty / capital", async () => {
    const positions = [
      makePosition({ entry_price: 100, initial_stop_loss_price: 95, quantity: 20 }),
    ];
    const result = await buildM1Evidence(makeSupabase([ALGO_A], positions));
    // |100−95| × 20 / 100,000 = 0.1%
    expect(result.trades[0].risk_pct_at_entry).toBeCloseTo(0.1, 10);
  });

  it("per-algo aggregation splits by algorithm", async () => {
    const positions = [
      makePosition({ algorithm_id: "algo-a", entry_price: 100, initial_stop_loss_price: 95, exit_price: 110 }), // +2R
      makePosition({ algorithm_id: "algo-b", entry_price: 100, initial_stop_loss_price: 95, exit_price: 95 }), // −1R
    ];
    const result = await buildM1Evidence(makeSupabase([ALGO_A, ALGO_B], positions));
    const a = result.per_algo.find((p) => p.algorithm_id === "algo-a")!;
    const b = result.per_algo.find((p) => p.algorithm_id === "algo-b")!;
    expect(a.closed_trades).toBe(1);
    expect(a.mean_r).toBeCloseTo(2, 10);
    expect(a.win_rate_pct).toBe(100);
    expect(b.mean_r).toBeCloseTo(-1, 10);
    expect(b.win_rate_pct).toBe(0);
  });

  it("trades display capped at 50; gate statistic still counts everything", async () => {
    const positions = Array.from({ length: 55 }, () => makePosition());
    const result = await buildM1Evidence(makeSupabase([ALGO_A], positions));
    expect(result.trades).toHaveLength(50);
    expect(result.closed_trades).toBe(55);
  });

  it("query error → throws loudly", async () => {
    await expect(buildM1Evidence(makeSupabase({ error: "DB down" }))).rejects.toThrow(
      /algorithms query failed: DB down/
    );
  });

  it("shipped baseline sanity: 5 algos, positive portfolio mean R, gate 30/±30", async () => {
    expect(M1_BASELINE.per_algo).toHaveLength(5);
    expect(M1_BASELINE.portfolio.mean_r).toBeGreaterThan(0);
    expect(M1_BASELINE.gate).toEqual({ min_trades: 30, tolerance_pct: 30 });
    expect(M1_BASELINE.portfolio.n).toBe(843);
    // Every baseline entry maps to a Deploy:-named live row.
    for (const b of M1_BASELINE.per_algo) expect(b.live_name).toMatch(/^Deploy: /);
  });
});
