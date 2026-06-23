/**
 * Algorithm-search state fetcher — DB rows → frontend Search tab summary.
 *
 * Shared by:
 *   - /reports Search tab (via getAlgoSearchStateAction in reports/actions.ts)
 *   - Future CLI summary commands (optional; not built yet)
 *
 * Pure-read aggregation; never writes. RLS-scoped via the caller's
 * supabase client. Does NOT trigger the sweep — operator launches that
 * separately via `MODE=full pnpm dlx tsx scripts/canonical/algo-search.ts`.
 */
import type { Database } from "@/lib/supabase/database.types";
import {
  evaluateAgainstCriteria,
  passesPerCandidate,
  passesShipCriteria,
  SEARCH_LAYER_A_CRITERIA,
  type DeflatedBlock,
  type PersistedBacktestResults,
} from "./criteria";
import {
  CANDIDATE_NAME_PREFIX,
  enumerateLayerACandidates,
  SEARCH_INSTRUMENTS,
  SEARCH_PATTERNS,
  SEARCH_TIMEFRAMES,
  type SearchCandidate,
} from "./enumerate";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface SearchSurvivor {
  algorithm_id: string;
  name: string;
  ticker: string;
  timeframe: string;
  pattern: string;
  side: string;
  total_return: number | null;
  win_rate: number | null;
  total_trades: number | null;
  mean_r_ci_lower: number | null;
  bonferroni_p: number | null;
  oos_held_out_trades: number | null;
  /** Ship-readiness status. `ship-ready` = passes per-candidate criteria 1–7
   *  AND deflated criteria 8–10 (DSR ≥ 0.95 + PBO < 0.5 + k-fold ≥ 4/5).
   *  `per-candidate-pass-only` = passes 1–7 but deflated block missing OR
   *  deflated criteria not met. Frontend uses this to badge survivors. */
  ship_status: "ship-ready" | "per-candidate-pass-only";
}

/** A LayerB:* row (geometry-refined variant of a Layer A base candidate) with
 *  its deflated stats sub-block when present. Populated by the prior Layer B
 *  sweep + the revalidate-candidates script. Frontend renders these in the
 *  Search tab's "Layer B variants with deflated stats" section. */
export interface LayerBVariantRow {
  algorithm_id: string;
  name: string;
  base_name: string | null;       // derived from name (left of " | ")
  variant_tag: string | null;     // derived from name (right of " | ")
  total_return: number | null;
  total_trades: number | null;
  win_rate: number | null;
  static_dd: number | null;
  mean_r_ci_lower: number | null;
  sharpe_ratio: number | null;
  oos_held_out_n: number | null;
  oos_r_delta_pct: number | null;
  /** Deflated stats. Null until revalidate-candidates is run for this variant. */
  deflated: {
    deflated_sharpe: number;
    pbo: number;
    purged_kfold_consistency: { count: number; total: number } | null;
    family_size: number;
    family_trial_sharpe_std: number;
    computed_at: string;
  } | null;
}

export interface SearchTopBlocker {
  /** Criterion key (matches SearchCriteria keys). */
  key: string;
  /** Human label e.g. "WR ≥ 37%". */
  label: string;
  /** How many evaluated rows failed THIS specific criterion. */
  failed_count: number;
}

export interface SearchState {
  /** Total cells in the Layer A enumeration. */
  enumerated_count: number;
  /** Inserted candidate rows where name LIKE 'Search:%'. Equal to or
   *  greater than enumerated_count if a prior run left rows for cells
   *  the current enumeration doesn't reproduce (semantic drift detector). */
  inserted_count: number;
  /** Inserted rows whose backtest_results JSONB is populated (sweep ran). */
  evaluated_count: number;
  /** Rows passing per-candidate criteria 1–7. */
  per_candidate_pass_count: number;
  /** Rows passing per-candidate AND deflated criteria 8–10 (DSR + PBO + k-fold).
   *  Most Layer A rows lack the deflated block (haven't been run through
   *  revalidate-candidates) → 0 ship-ready at Layer A is typical. Ship-ready
   *  Layer B survivors live in `layer_b_variants` (where some have the
   *  deflated block). */
  ship_ready_count: number;
  /** Of evaluated rows, how many were marked promotion_eligible by
   *  validate-algo (separate legacy criteria — informational comparison). */
  validate_algo_eligible_count: number;
  /** Top-of-table actionable list: per-candidate criteria + how many
   *  evaluated rows failed each. Renders WHY most of the search isn't
   *  surviving (e.g. "290 failed mean R CI lower > 0"). */
  blockers: SearchTopBlocker[];
  /** Per-axis tallies for sanity-check display. */
  by_instrument: Record<string, number>;
  by_timeframe: Record<string, number>;
  by_pattern: Record<string, number>;
  by_side: Record<string, number>;
  /** Layer A survivors: rows passing per-candidate criteria 1–7. Includes
   *  `ship_status` per row indicating whether deflated criteria also pass. */
  survivors: SearchSurvivor[];
  /** Layer B geometry-refined variants (rows whose name LIKE 'LayerB:%').
   *  Sorted by deflated_sharpe DESC when present, else total_return DESC.
   *  Each includes the deflated stats sub-block when populated by
   *  revalidate-candidates. Frontend renders as a separate section with the
   *  deflated columns (DSR / PBO / k-fold consistency). */
  layer_b_variants: LayerBVariantRow[];
  /** Timestamp of the most-recent backtest_results.computed_at across
   *  the search rows. null if no rows have been evaluated yet. */
  last_evaluated_at: string | null;
}

interface AlgoRow {
  id: string;
  name: string;
  backtest_results: unknown;
}

function parseCellFromName(name: string): { ticker: string; pattern: string; side: string; timeframe: string } | null {
  // Format: "Search: <TICKER> <Pattern>-<SideTag> <TF>"
  // Example: "Search: XAU/USD FVG-Long 4h"
  // Robust parser: split on "Search: " then last token = TF, prior token
  // contains pattern + side joined by "-".
  if (!name.startsWith(`${CANDIDATE_NAME_PREFIX} `)) return null;
  const rest = name.slice(CANDIDATE_NAME_PREFIX.length + 1).trim();
  const tokens = rest.split(" ");
  if (tokens.length < 3) return null;
  const timeframe = tokens[tokens.length - 1];
  const patternSide = tokens[tokens.length - 2];
  const ticker = tokens.slice(0, tokens.length - 2).join(" ");
  const lastDash = patternSide.lastIndexOf("-");
  if (lastDash < 0) return null;
  const pattern = patternSide.slice(0, lastDash);
  const side = patternSide.slice(lastDash + 1).toLowerCase();
  return { ticker, pattern, side, timeframe };
}

interface UniverseTallies {
  enumerated_count: number;
  by_instrument: Record<string, number>;
  by_timeframe: Record<string, number>;
  by_pattern: Record<string, number>;
  by_side: Record<string, number>;
}

function computeUniverseTallies(): UniverseTallies {
  const candidates = enumerateLayerACandidates();
  const by_instrument: Record<string, number> = {};
  const by_timeframe: Record<string, number> = {};
  const by_pattern: Record<string, number> = {};
  const by_side: Record<string, number> = {};
  for (const c of candidates) {
    by_instrument[c.ticker] = (by_instrument[c.ticker] ?? 0) + 1;
    by_timeframe[c.timeframe] = (by_timeframe[c.timeframe] ?? 0) + 1;
    by_pattern[c.pattern] = (by_pattern[c.pattern] ?? 0) + 1;
    by_side[c.side] = (by_side[c.side] ?? 0) + 1;
  }
  return { enumerated_count: candidates.length, by_instrument, by_timeframe, by_pattern, by_side };
}

interface DbAggregation {
  inserted_count: number;
  evaluated_count: number;
  validate_algo_eligible_count: number;
  ship_ready_count: number;
  per_candidate_pass: SearchSurvivor[];
  blockers: SearchTopBlocker[];
  last_evaluated_at: string | null;
}

function survivorFromRow(
  row: AlgoRow,
  results: PersistedBacktestResults,
  ship_status: SearchSurvivor["ship_status"],
): SearchSurvivor {
  const cell = parseCellFromName(row.name);
  return {
    algorithm_id: row.id,
    name: row.name,
    ticker: cell?.ticker ?? "?",
    timeframe: cell?.timeframe ?? "?",
    pattern: cell?.pattern ?? "?",
    side: cell?.side ?? "?",
    total_return: results.step2?.total_return ?? null,
    win_rate: results.step2?.win_rate ?? null,
    total_trades: results.step2?.total_trades ?? null,
    mean_r_ci_lower: results.statistical_rigor?.mean_r_ci?.lower ?? null,
    bonferroni_p: results.statistical_rigor?.mean_r_bonferroni?.p_value ?? null,
    oos_held_out_trades: results.step6?.held_out_n ?? null,
    ship_status,
  };
}

function aggregateAlgoRows(algoRows: AlgoRow[]): DbAggregation {
  const blockerCounts = new Map<string, number>();
  const blockerLabels = new Map<string, string>();
  let evaluated_count = 0;
  let validate_algo_eligible_count = 0;
  let ship_ready_count = 0;
  const per_candidate_pass: SearchSurvivor[] = [];
  let last_evaluated_at: string | null = null;
  for (const row of algoRows) {
    const results = (row.backtest_results ?? null) as PersistedBacktestResults | null;
    if (!results) continue;
    evaluated_count++;
    if (results.promotion_eligible) validate_algo_eligible_count++;
    const computedAt = (results as { computed_at?: string }).computed_at;
    if (computedAt && (!last_evaluated_at || computedAt > last_evaluated_at)) {
      last_evaluated_at = computedAt;
    }
    for (const c of evaluateAgainstCriteria(results)) {
      if (!c.passed) {
        blockerCounts.set(c.key, (blockerCounts.get(c.key) ?? 0) + 1);
        blockerLabels.set(c.key, c.label);
      }
    }
    if (passesPerCandidate(results)) {
      // Ship status: needs the deflated block populated by revalidate-candidates.
      const deflatedBlock = (results.statistical_rigor as { deflated?: DeflatedBlock })?.deflated ?? null;
      const shipReady = passesShipCriteria(results, deflatedBlock);
      const status: SearchSurvivor["ship_status"] = shipReady ? "ship-ready" : "per-candidate-pass-only";
      if (shipReady) ship_ready_count++;
      per_candidate_pass.push(survivorFromRow(row, results, status));
    }
  }
  const blockers: SearchTopBlocker[] = [...blockerCounts.entries()]
    .map(([key, failed_count]) => ({ key, label: blockerLabels.get(key) ?? key, failed_count }))
    .sort((a, b) => b.failed_count - a.failed_count);
  // Sort by total_return DESC for the FE table.
  per_candidate_pass.sort((a, b) => (b.total_return ?? 0) - (a.total_return ?? 0));
  return {
    inserted_count: algoRows.length,
    evaluated_count,
    validate_algo_eligible_count,
    ship_ready_count,
    per_candidate_pass,
    blockers,
    last_evaluated_at,
  };
}

const LAYER_B_NAME_PREFIX = "LayerB:";
const LAYER_B_FAMILY_DELIM = " | ";

interface DeflatedJsonbBlock {
  deflated_sharpe?: { deflatedSharpe?: number };
  pbo?: { probabilityOfBacktestOverfitting?: number };
  purged_kfold_snapshot?: { consistency_count?: number; n_folds?: number } | null;
  family_size?: number;
  family_trial_sharpe_std?: number;
  computed_at?: string;
}

function rowToLayerBVariant(row: AlgoRow): LayerBVariantRow {
  const results = (row.backtest_results ?? {}) as PersistedBacktestResults & {
    statistical_rigor?: {
      sharpe_ratio?: number;
      deflated?: DeflatedJsonbBlock;
    };
  };
  const step2 = results.step2 ?? {};
  const step6 = results.step6 ?? {};
  const rigor = results.statistical_rigor ?? {};
  const meanRCi = rigor.mean_r_ci ?? {};
  const deflated = rigor.deflated ?? null;
  const delimIdx = row.name.lastIndexOf(LAYER_B_FAMILY_DELIM);
  const base_name = delimIdx > 0 ? row.name.slice(0, delimIdx) : null;
  const variant_tag = delimIdx > 0 ? row.name.slice(delimIdx + LAYER_B_FAMILY_DELIM.length) : null;
  return {
    algorithm_id: row.id,
    name: row.name,
    base_name,
    variant_tag,
    total_return: step2.total_return ?? null,
    total_trades: step2.total_trades ?? null,
    win_rate: step2.win_rate ?? null,
    static_dd: step2.max_static_dd ?? null,
    mean_r_ci_lower: meanRCi.lower ?? null,
    sharpe_ratio: rigor.sharpe_ratio ?? null,
    oos_held_out_n: step6.held_out_n ?? null,
    oos_r_delta_pct: step6.r_delta_pct ?? null,
    deflated:
      deflated &&
      typeof deflated.deflated_sharpe?.deflatedSharpe === "number" &&
      typeof deflated.pbo?.probabilityOfBacktestOverfitting === "number"
        ? {
            deflated_sharpe: deflated.deflated_sharpe.deflatedSharpe,
            pbo: deflated.pbo.probabilityOfBacktestOverfitting,
            purged_kfold_consistency:
              deflated.purged_kfold_snapshot &&
              typeof deflated.purged_kfold_snapshot.consistency_count === "number" &&
              typeof deflated.purged_kfold_snapshot.n_folds === "number"
                ? {
                    count: deflated.purged_kfold_snapshot.consistency_count,
                    total: deflated.purged_kfold_snapshot.n_folds,
                  }
                : null,
            family_size: deflated.family_size ?? 0,
            family_trial_sharpe_std: deflated.family_trial_sharpe_std ?? 0,
            computed_at: deflated.computed_at ?? "",
          }
        : null,
  };
}

async function fetchLayerBVariants(supabase: SupabaseClient<Database>): Promise<LayerBVariantRow[]> {
  const { data, error } = await supabase
    .from("algorithms")
    .select("id, name, backtest_results")
    .like("name", `${LAYER_B_NAME_PREFIX}%`);
  if (error) {
    throw new Error(
      `fetchLayerBVariants: algorithms query failed: ${error.message} (code=${error.code ?? "n/a"})`,
    );
  }
  const rows = (data ?? []) as AlgoRow[];
  const out = rows.map(rowToLayerBVariant);
  out.sort((a, b) => (b.total_return ?? 0) - (a.total_return ?? 0));
  return out;
}

/** Build the SearchState payload from the algorithms table. Pure-read;
 *  never writes. RLS-scoped via the caller's supabase client.
 *
 *  Three-pass evaluation:
 *    1. Universe tallies (deterministic, no DB).
 *    2. Layer A read + per-candidate criterion evaluation (spec §4 criteria
 *       1–7) + deflated criteria evaluation (8–10) for rows with the
 *       deflated block populated.
 *    3. Layer B variants fetch (includes deflated stats block when populated
 *       by revalidate-candidates.ts). */
export async function buildSearchState(
  supabase: SupabaseClient<Database>,
): Promise<SearchState> {
  const universe = computeUniverseTallies();
  const { data: rows, error } = await supabase
    .from("algorithms")
    .select("id, name, backtest_results")
    .like("name", `${CANDIDATE_NAME_PREFIX}%`);
  if (error) {
    throw new Error(
      `buildSearchState: algorithms query failed: ${error.message} (code=${error.code ?? "n/a"})`,
    );
  }
  const agg = aggregateAlgoRows((rows ?? []) as AlgoRow[]);
  const layerBVariants = await fetchLayerBVariants(supabase);
  return {
    enumerated_count: universe.enumerated_count,
    inserted_count: agg.inserted_count,
    evaluated_count: agg.evaluated_count,
    per_candidate_pass_count: agg.per_candidate_pass.length,
    ship_ready_count: agg.ship_ready_count,
    validate_algo_eligible_count: agg.validate_algo_eligible_count,
    blockers: agg.blockers,
    by_instrument: universe.by_instrument,
    by_timeframe: universe.by_timeframe,
    by_pattern: universe.by_pattern,
    by_side: universe.by_side,
    survivors: agg.per_candidate_pass,
    layer_b_variants: layerBVariants,
    last_evaluated_at: agg.last_evaluated_at,
  };
}

/** Re-export for component convenience. */
export {
  CANDIDATE_NAME_PREFIX,
  SEARCH_INSTRUMENTS,
  SEARCH_LAYER_A_CRITERIA,
  SEARCH_PATTERNS,
  SEARCH_TIMEFRAMES,
  type SearchCandidate,
};
