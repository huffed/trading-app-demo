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
  ROBUSTNESS_EXEMPT_PATTERNS,
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
  /** v2: pattern-robustness status. `robust` = ≥2 cells of same (pattern×side)
   *  pass per-candidate criteria. `singleton-exempt` = only 1 cell but pattern
   *  is on the structural-exemption list (e.g. asian_range_break is 4h-only by
   *  design). `singleton-not-robust` = only 1 cell, not exempt → EXCLUDED from
   *  survivor set (this row appears in `singleton_candidates` instead). */
  robustness_status: "robust" | "singleton-exempt" | "singleton-not-robust";
}

/** Single-cell candidates that pass per-candidate criteria but fail pattern
 *  robustness (criterion 9). Surfaced separately so the operator sees the
 *  near-miss without us auto-treating them as survivors. */
export type SearchSingleton = SearchSurvivor;

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
  /** v2: rows passing per-candidate criteria 1–8 (before robustness check). */
  per_candidate_pass_count: number;
  /** v2: rows passing per-candidate AND pattern-robustness criterion 9. */
  survivor_count: number;
  /** v2: rows passing per-candidate but failing robustness (single-cell wins). */
  singleton_count: number;
  /** Of evaluated rows, how many were marked promotion_eligible by
   *  validate-algo (legacy v1 criteria — informational comparison). */
  validate_algo_eligible_count: number;
  /** Top-of-table actionable list: the 7 per-candidate criteria + how many
   *  evaluated rows failed each. Renders WHY most of the search isn't
   *  surviving (e.g. "290 failed mean R CI lower > 0"). */
  blockers: SearchTopBlocker[];
  /** Per-axis tallies for sanity-check display. */
  by_instrument: Record<string, number>;
  by_timeframe: Record<string, number>;
  by_pattern: Record<string, number>;
  by_side: Record<string, number>;
  /** Robust Layer A survivors (per-candidate pass + ≥2 cells same pattern×side). */
  survivors: SearchSurvivor[];
  /** Per-candidate pass but failed robustness — informational, NOT auto-survivor. */
  singleton_candidates: SearchSingleton[];
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
  per_candidate_pass: SearchSurvivor[];
  blockers: SearchTopBlocker[];
  last_evaluated_at: string | null;
}

function survivorFromRow(
  row: AlgoRow,
  results: PersistedBacktestResults,
  robustness_status: SearchSurvivor["robustness_status"],
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
    robustness_status,
  };
}

function aggregateAlgoRows(algoRows: AlgoRow[]): DbAggregation {
  const blockerCounts = new Map<string, number>();
  const blockerLabels = new Map<string, string>();
  let evaluated_count = 0;
  let validate_algo_eligible_count = 0;
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
      // robustness_status filled in by cross-row pass below; placeholder here.
      per_candidate_pass.push(survivorFromRow(row, results, "singleton-not-robust"));
    }
  }
  const blockers: SearchTopBlocker[] = [...blockerCounts.entries()]
    .map(([key, failed_count]) => ({ key, label: blockerLabels.get(key) ?? key, failed_count }))
    .sort((a, b) => b.failed_count - a.failed_count);
  return {
    inserted_count: algoRows.length,
    evaluated_count,
    validate_algo_eligible_count,
    per_candidate_pass,
    blockers,
    last_evaluated_at,
  };
}

/** Cross-row pattern-robustness pass (spec §4 criterion 9). Group rows by
 *  (pattern × side). For each group, if ≥ 2 cells pass per-candidate
 *  criteria, mark each as "robust". If only 1 cell AND the pattern is on
 *  the exemption list (e.g. asian_range_break is 4h-only by enumeration
 *  design), mark "singleton-exempt" → still a survivor with manual-review
 *  flag. Otherwise mark "singleton-not-robust" → moves to singleton list. */
function applyRobustnessPass(per_candidate_pass: SearchSurvivor[]): {
  survivors: SearchSurvivor[];
  singletons: SearchSurvivor[];
} {
  const byKey = new Map<string, SearchSurvivor[]>();
  for (const row of per_candidate_pass) {
    const key = `${row.pattern}|${row.side}`;
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }
  const survivors: SearchSurvivor[] = [];
  const singletons: SearchSurvivor[] = [];
  for (const [, group] of byKey) {
    if (group.length >= 2) {
      for (const r of group) survivors.push({ ...r, robustness_status: "robust" });
    } else {
      const r = group[0];
      const exempt = ROBUSTNESS_EXEMPT_PATTERNS.has(r.pattern);
      if (exempt) survivors.push({ ...r, robustness_status: "singleton-exempt" });
      else singletons.push({ ...r, robustness_status: "singleton-not-robust" });
    }
  }
  survivors.sort((a, b) => (b.total_return ?? 0) - (a.total_return ?? 0));
  singletons.sort((a, b) => (b.total_return ?? 0) - (a.total_return ?? 0));
  return { survivors, singletons };
}

/** Build the SearchState payload from the algorithms table. Pure-read;
 *  never writes. RLS-scoped via the caller's supabase client.
 *
 *  Three-pass evaluation (v2 spec §4 + §5):
 *    1. Universe tallies (deterministic, no DB).
 *    2. DB read + per-candidate criterion evaluation (criteria 1–8).
 *    3. Cross-row pattern-robustness pass (criterion 9). */
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
  const { survivors, singletons } = applyRobustnessPass(agg.per_candidate_pass);
  return {
    enumerated_count: universe.enumerated_count,
    inserted_count: agg.inserted_count,
    evaluated_count: agg.evaluated_count,
    per_candidate_pass_count: agg.per_candidate_pass.length,
    survivor_count: survivors.length,
    singleton_count: singletons.length,
    validate_algo_eligible_count: agg.validate_algo_eligible_count,
    blockers: agg.blockers,
    by_instrument: universe.by_instrument,
    by_timeframe: universe.by_timeframe,
    by_pattern: universe.by_pattern,
    by_side: universe.by_side,
    survivors,
    singleton_candidates: singletons,
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
