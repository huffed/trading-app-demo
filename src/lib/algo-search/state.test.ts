/**
 * SearchState fetcher tests. Mock supabase to lock the aggregation
 * semantics (criterion-blocker counting, survivor extraction, name-parse
 * round-trip) without hitting the real DB.
 */
import { describe, expect, it } from "vitest";
import type { Database } from "@/lib/supabase/database.types";
import { CANDIDATE_NAME_PREFIX } from "./enumerate";
import { buildSearchState } from "./state";
import type { SupabaseClient } from "@supabase/supabase-js";

interface FakeRow {
  id: string;
  name: string;
  backtest_results: unknown;
}

function fakeSupabase(rows: FakeRow[]): SupabaseClient<Database> {
  const stub = {
    from: () => ({
      select: () => ({
        like: () => Promise.resolve({ data: rows, error: null }),
      }),
    }),
  };
  return stub as unknown as SupabaseClient<Database>;
}

const FULL_PASS = {
  step2: { total_return: 1500, total_trades: 60, win_rate: 42, max_static_dd: 4, max_daily_dd: 2 },
  step6: { held_out_n: 15, r_delta_pct: -10 },
  statistical_rigor: {
    mean_r_ci: { lower: 0.1 },
    mean_r_bonferroni: { p_value: 1e-5 },
  },
  promotion_eligible: true,
  computed_at: "2026-06-23T01:00:00Z",
};

const WR_BLOCKED = {
  ...FULL_PASS,
  step2: { ...FULL_PASS.step2, win_rate: 30 },
  promotion_eligible: false,
};

describe("buildSearchState", () => {
  it("empty DB → enumerated_count=308 + survivors=0 + evaluated_count=0", async () => {
    const s = await buildSearchState(fakeSupabase([]));
    expect(s.enumerated_count).toBe(308);
    expect(s.family_alpha).toBe(0.05);
    expect(s.per_test_alpha).toBeCloseTo(0.05 / 308, 10);
    expect(s.inserted_count).toBe(0);
    expect(s.evaluated_count).toBe(0);
    expect(s.survivor_count).toBe(0);
    expect(s.validate_algo_eligible_count).toBe(0);
    expect(s.last_evaluated_at).toBeNull();
  });

  it("inserted-but-unevaluated rows count in inserted_count, NOT evaluated_count", async () => {
    const s = await buildSearchState(
      fakeSupabase([
        { id: "a1", name: `${CANDIDATE_NAME_PREFIX} XAU/USD FVG-Long 4h`, backtest_results: null },
        { id: "a2", name: `${CANDIDATE_NAME_PREFIX} EUR/USD BOS-Short 1h`, backtest_results: null },
      ]),
    );
    expect(s.inserted_count).toBe(2);
    expect(s.evaluated_count).toBe(0);
  });

  it("1 full-pass row → survivor_count=1 + validate_algo_eligible=1", async () => {
    const s = await buildSearchState(
      fakeSupabase([
        { id: "a1", name: `${CANDIDATE_NAME_PREFIX} XAU/USD FVG-Long 4h`, backtest_results: FULL_PASS },
      ]),
    );
    expect(s.survivor_count).toBe(1);
    expect(s.validate_algo_eligible_count).toBe(1);
    expect(s.survivors[0].ticker).toBe("XAU/USD");
    expect(s.survivors[0].pattern).toBe("FVG");
    expect(s.survivors[0].side).toBe("long");
    expect(s.survivors[0].timeframe).toBe("4h");
  });

  it("blockers tally counts per-criterion failures (WR-blocked rows show in min_win_rate_pct)", async () => {
    const s = await buildSearchState(
      fakeSupabase([
        { id: "a1", name: `${CANDIDATE_NAME_PREFIX} XAU/USD FVG-Long 4h`, backtest_results: WR_BLOCKED },
        { id: "a2", name: `${CANDIDATE_NAME_PREFIX} EUR/USD BOS-Short 1h`, backtest_results: WR_BLOCKED },
      ]),
    );
    expect(s.evaluated_count).toBe(2);
    expect(s.survivor_count).toBe(0);
    const wrBlocker = s.blockers.find((b) => b.key === "min_win_rate_pct");
    expect(wrBlocker?.failed_count).toBe(2);
  });

  it("blockers sorted desc by failed_count", async () => {
    const s = await buildSearchState(
      fakeSupabase([
        // WR failures (1 row) + bonferroni failures (1 row, full pass on WR)
        { id: "a1", name: `${CANDIDATE_NAME_PREFIX} XAU/USD FVG-Long 4h`, backtest_results: WR_BLOCKED },
        {
          id: "a2",
          name: `${CANDIDATE_NAME_PREFIX} EUR/USD BOS-Short 1h`,
          backtest_results: {
            ...FULL_PASS,
            statistical_rigor: { ...FULL_PASS.statistical_rigor, mean_r_bonferroni: { p_value: 0.5 } },
          },
        },
      ]),
    );
    // WR appears 1×, Bonferroni appears 1×. Tie → either order is acceptable.
    expect(s.blockers.length).toBeGreaterThanOrEqual(2);
    // Strict sort check: each successive entry's count is <= the previous.
    for (let i = 1; i < s.blockers.length; i++) {
      expect(s.blockers[i].failed_count).toBeLessThanOrEqual(s.blockers[i - 1].failed_count);
    }
  });

  it("last_evaluated_at returns MAX computed_at across rows", async () => {
    const older = { ...FULL_PASS, computed_at: "2026-06-23T00:00:00Z" };
    const newer = { ...FULL_PASS, computed_at: "2026-06-23T05:00:00Z" };
    const s = await buildSearchState(
      fakeSupabase([
        { id: "a1", name: `${CANDIDATE_NAME_PREFIX} XAU/USD FVG-Long 4h`, backtest_results: older },
        { id: "a2", name: `${CANDIDATE_NAME_PREFIX} EUR/USD BOS-Short 1h`, backtest_results: newer },
      ]),
    );
    expect(s.last_evaluated_at).toBe("2026-06-23T05:00:00Z");
  });
});
