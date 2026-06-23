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
  passesLayerA,
  SEARCH_LAYER_A_CRITERIA,
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
  /** Total cells in the Layer A enumeration (Bonferroni denominator). */
  enumerated_count: number;
  /** Family α used for Bonferroni (locked at 0.05 per spec §4). */
  family_alpha: number;
  /** Per-test α = family_alpha / enumerated_count. */
  per_test_alpha: number;
  /** Inserted candidate rows where name LIKE 'Search:%'. Equal to or
   *  greater than enumerated_count if a prior run left rows for cells
   *  the current enumeration doesn't reproduce (semantic drift detector). */
  inserted_count: number;
  /** Inserted rows whose backtest_results JSONB is populated (sweep ran). */
  evaluated_count: number;
  /** Of evaluated rows, how many pass ALL 9 Layer A criteria. */
  survivor_count: number;
  /** Of evaluated rows, how many were marked promotion_eligible by
   *  validate-algo (full pre-reg + step-verdict pipeline — should ≥ survivor_count). */
  validate_algo_eligible_count: number;
  /** Top-of-table actionable list: the 9 criteria + how many evaluated
   *  rows failed each. The frontend renders this so the operator sees
   *  WHY most of the search isn't surviving (e.g. "270 failed WR ≥ 37%"). */
  blockers: SearchTopBlocker[];
  /** Per-axis tallies for sanity-check display. */
  by_instrument: Record<string, number>;
  by_timeframe: Record<string, number>;
  by_pattern: Record<string, number>;
  by_side: Record<string, number>;
  /** Sorted by total_return DESC. Frontend renders top N (e.g. 10). */
  survivors: SearchSurvivor[];
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
  survivors: SearchSurvivor[];
  blockers: SearchTopBlocker[];
  last_evaluated_at: string | null;
}

function survivorFromRow(row: AlgoRow, results: PersistedBacktestResults): SearchSurvivor {
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
  };
}

function aggregateAlgoRows(algoRows: AlgoRow[]): DbAggregation {
  const blockerCounts = new Map<string, number>();
  const blockerLabels = new Map<string, string>();
  let evaluated_count = 0;
  let validate_algo_eligible_count = 0;
  const survivors: SearchSurvivor[] = [];
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
    if (passesLayerA(results)) survivors.push(survivorFromRow(row, results));
  }
  const blockers: SearchTopBlocker[] = [...blockerCounts.entries()]
    .map(([key, failed_count]) => ({ key, label: blockerLabels.get(key) ?? key, failed_count }))
    .sort((a, b) => b.failed_count - a.failed_count);
  survivors.sort((a, b) => (b.total_return ?? 0) - (a.total_return ?? 0));
  return {
    inserted_count: algoRows.length,
    evaluated_count,
    validate_algo_eligible_count,
    survivors,
    blockers,
    last_evaluated_at,
  };
}

/** Build the SearchState payload from the algorithms table. Pure-read;
 *  never writes. RLS-scoped via the caller's supabase client. */
export async function buildSearchState(
  supabase: SupabaseClient<Database>,
): Promise<SearchState> {
  const universe = computeUniverseTallies();
  const family_alpha = 0.05;
  const per_test_alpha = family_alpha / universe.enumerated_count;
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
  return {
    enumerated_count: universe.enumerated_count,
    family_alpha,
    per_test_alpha,
    inserted_count: agg.inserted_count,
    evaluated_count: agg.evaluated_count,
    survivor_count: agg.survivors.length,
    validate_algo_eligible_count: agg.validate_algo_eligible_count,
    blockers: agg.blockers,
    by_instrument: universe.by_instrument,
    by_timeframe: universe.by_timeframe,
    by_pattern: universe.by_pattern,
    by_side: universe.by_side,
    survivors: agg.survivors,
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
