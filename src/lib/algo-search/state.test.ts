/**
 * SearchState fetcher tests. Locks: per-candidate criterion mapping,
 * ship-status classification (per-candidate vs full ship-ready),
 * Layer B variant parsing (including deflated block), parse-from-name
 * round-trip, MAX(computed_at) reduction.
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

/** Mock supabase. Returns `searchRows` for `LIKE 'Search:%'` queries +
 *  `layerBRows` for `LIKE 'LayerB:%'` queries (matches the buildSearchState
 *  call pattern). Both default to []. */
function fakeSupabase(searchRows: FakeRow[], layerBRows: FakeRow[] = []): SupabaseClient<Database> {
  const stub = {
    from: () => ({
      select: () => ({
        like: (_col: string, pattern: string) => {
          const rows = pattern.startsWith("LayerB:") ? layerBRows : searchRows;
          return Promise.resolve({ data: rows, error: null });
        },
      }),
    }),
  };
  return stub as unknown as SupabaseClient<Database>;
}

const FULL_PASS = {
  step2: { total_return: 1500, total_trades: 60, win_rate: 30, max_static_dd: 4, max_daily_dd: 2 },
  step6: { held_out_n: 15, r_delta_pct: -10 },
  statistical_rigor: {
    mean_r_ci: { lower: 0.1 },
    mean_r_bonferroni: { p_value: 0.01 },
  },
  promotion_eligible: false, // validate-algo's looser flag — separate from ship-readiness
  computed_at: "2026-06-23T01:00:00Z",
};

const FAIL_CI = {
  ...FULL_PASS,
  statistical_rigor: { ...FULL_PASS.statistical_rigor, mean_r_ci: { lower: -0.05 } },
};

describe("buildSearchState", () => {
  it("empty DB → 308 enumerated + 0 per-candidate-pass + 0 ship-ready", async () => {
    const s = await buildSearchState(fakeSupabase([]));
    expect(s.enumerated_count).toBe(308);
    expect(s.inserted_count).toBe(0);
    expect(s.evaluated_count).toBe(0);
    expect(s.per_candidate_pass_count).toBe(0);
    expect(s.ship_ready_count).toBe(0);
    expect(s.last_evaluated_at).toBeNull();
  });

  it("per-candidate-passing row WITHOUT deflated block → in survivors with ship_status='per-candidate-pass-only'", async () => {
    const s = await buildSearchState(
      fakeSupabase([
        { id: "a1", name: `${CANDIDATE_NAME_PREFIX} XAU/USD Momentum-Long 4h`, backtest_results: FULL_PASS },
      ]),
    );
    expect(s.per_candidate_pass_count).toBe(1);
    expect(s.ship_ready_count).toBe(0);
    expect(s.survivors[0].ship_status).toBe("per-candidate-pass-only");
  });

  it("per-candidate-passing row WITH passing deflated block → ship-ready", async () => {
    const passingDeflated = {
      ...FULL_PASS,
      statistical_rigor: {
        ...FULL_PASS.statistical_rigor,
        deflated: {
          deflated_sharpe: { deflatedSharpe: 0.98 },
          pbo: { probabilityOfBacktestOverfitting: 0.2 },
          purged_kfold_snapshot: { consistency_count: 5, n_folds: 5 },
        },
      },
    };
    const s = await buildSearchState(
      fakeSupabase([
        { id: "a1", name: `${CANDIDATE_NAME_PREFIX} XAU/USD Momentum-Long 4h`, backtest_results: passingDeflated },
      ]),
    );
    expect(s.per_candidate_pass_count).toBe(1);
    expect(s.ship_ready_count).toBe(1);
    expect(s.survivors[0].ship_status).toBe("ship-ready");
  });

  it("per-candidate pass + failing deflated (DSR low) → per-candidate-pass-only, NOT ship-ready", async () => {
    const failingDeflated = {
      ...FULL_PASS,
      statistical_rigor: {
        ...FULL_PASS.statistical_rigor,
        deflated: {
          deflated_sharpe: { deflatedSharpe: 0.5 }, // below 0.95 threshold
          pbo: { probabilityOfBacktestOverfitting: 0.2 },
          purged_kfold_snapshot: { consistency_count: 5, n_folds: 5 },
        },
      },
    };
    const s = await buildSearchState(
      fakeSupabase([
        { id: "a1", name: `${CANDIDATE_NAME_PREFIX} XAU/USD Momentum-Long 4h`, backtest_results: failingDeflated },
      ]),
    );
    expect(s.per_candidate_pass_count).toBe(1);
    expect(s.ship_ready_count).toBe(0);
    expect(s.survivors[0].ship_status).toBe("per-candidate-pass-only");
  });

  it("rows failing per-candidate criteria (CI lower < 0) appear in blockers, NOT in survivors", async () => {
    const s = await buildSearchState(
      fakeSupabase([
        { id: "a1", name: `${CANDIDATE_NAME_PREFIX} XAU/USD FVG-Long 4h`, backtest_results: FAIL_CI },
      ]),
    );
    expect(s.per_candidate_pass_count).toBe(0);
    expect(s.ship_ready_count).toBe(0);
    expect(s.survivors).toHaveLength(0);
    const ciBlocker = s.blockers.find((b) => b.key === "min_mean_r_ci_lower");
    expect(ciBlocker?.failed_count).toBe(1);
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

  it("validate_algo_eligible_count counts rows with promotion_eligible=true (validate-algo's looser flag, informational)", async () => {
    const promoted = { ...FULL_PASS, promotion_eligible: true };
    const s = await buildSearchState(
      fakeSupabase([
        { id: "a1", name: `${CANDIDATE_NAME_PREFIX} XAU/USD Momentum-Long 4h`, backtest_results: promoted },
        { id: "a2", name: `${CANDIDATE_NAME_PREFIX} XAU/USD Momentum-Long 1h`, backtest_results: FULL_PASS },
      ]),
    );
    expect(s.validate_algo_eligible_count).toBe(1);
    expect(s.per_candidate_pass_count).toBe(2); // both pass per-candidate; ship-readiness evaluated separately
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

  it("survivors sorted by total_return DESC", async () => {
    const low = { ...FULL_PASS, step2: { ...FULL_PASS.step2, total_return: 500 } };
    const high = { ...FULL_PASS, step2: { ...FULL_PASS.step2, total_return: 5000 } };
    const s = await buildSearchState(
      fakeSupabase([
        { id: "a1", name: `${CANDIDATE_NAME_PREFIX} XAU/USD Momentum-Long 4h`, backtest_results: low },
        { id: "a2", name: `${CANDIDATE_NAME_PREFIX} XAU/USD Momentum-Long 1h`, backtest_results: high },
      ]),
    );
    expect(s.survivors[0].total_return).toBe(5000);
    expect(s.survivors[1].total_return).toBe(500);
  });

  it("layer_b_variants empty when no LayerB:* rows", async () => {
    const s = await buildSearchState(fakeSupabase([]));
    expect(s.layer_b_variants).toEqual([]);
  });

  it("layer_b_variants populated from LayerB:* rows with deflated block parsed", async () => {
    const deflatedBlock = {
      computed_at: "2026-06-23T10:00:00Z",
      family_pattern: "LayerB: XAU/USD BOS-Long 4h | %",
      family_size: 96,
      family_trial_sharpe_std: 0.12,
      family_sharpe_mean: 0.08,
      deflated_sharpe: { deflatedSharpe: 0.85, pValueOneSided: 0.15 },
      pbo: { probabilityOfBacktestOverfitting: 0.42 },
      purged_kfold_snapshot: { consistency_count: 4, n_folds: 5 },
    };
    const variantRow = {
      step2: { total_return: 3793, total_trades: 162, win_rate: 36.4, max_static_dd: 0.79 },
      step6: { held_out_n: 55, r_delta_pct: -6.3 },
      statistical_rigor: {
        mean_r_ci: { lower: 0.068 },
        sharpe_ratio: 0.21,
        deflated: deflatedBlock,
      },
    };
    const s = await buildSearchState(
      fakeSupabase([], [
        {
          id: "lb1",
          name: "LayerB: XAU/USD BOS-Long 4h | rr3_lb3_r06_rf0_af0",
          backtest_results: variantRow,
        },
      ]),
    );
    expect(s.layer_b_variants).toHaveLength(1);
    const v = s.layer_b_variants[0];
    expect(v.base_name).toBe("LayerB: XAU/USD BOS-Long 4h");
    expect(v.variant_tag).toBe("rr3_lb3_r06_rf0_af0");
    expect(v.total_return).toBe(3793);
    expect(v.sharpe_ratio).toBe(0.21);
    expect(v.deflated?.deflated_sharpe).toBe(0.85);
    expect(v.deflated?.pbo).toBe(0.42);
    expect(v.deflated?.purged_kfold_consistency).toEqual({ count: 4, total: 5 });
    expect(v.deflated?.family_size).toBe(96);
  });

  it("layer_b variant with no deflated block → deflated: null (graceful)", async () => {
    const s = await buildSearchState(
      fakeSupabase([], [
        {
          id: "lb1",
          name: "LayerB: XAU/USD BOS-Long 4h | rr3_lb3_r06_rf0_af0",
          backtest_results: {
            step2: { total_return: 100, total_trades: 50, win_rate: 40, max_static_dd: 1 },
            statistical_rigor: { sharpe_ratio: 0.1 }, // no `deflated` sub-block
          },
        },
      ]),
    );
    expect(s.layer_b_variants[0].deflated).toBeNull();
  });

  it("layer_b_variants sorted by total_return DESC", async () => {
    const mk = (id: string, ret: number) => ({
      id,
      name: `LayerB: XAU/USD BOS-Long 4h | v${id}`,
      backtest_results: { step2: { total_return: ret } },
    });
    const s = await buildSearchState(fakeSupabase([], [mk("a", 100), mk("b", 500), mk("c", 300)]));
    expect(s.layer_b_variants.map((v) => v.total_return)).toEqual([500, 300, 100]);
  });
});
