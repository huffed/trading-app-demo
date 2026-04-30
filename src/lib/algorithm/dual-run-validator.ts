/**
 * Dual-run validator — measures the edge differential of using one of the
 * gold-only pattern primitives in an algorithm's entry conditions. Runs
 * walk-forward TWICE on the same template:
 *
 *   1. With the gold-only condition(s) included.
 *   2. With the gold-only condition(s) stripped.
 *
 * Returns the metric deltas so the caller (or operator) can decide whether
 * the carve-out is paying its way.
 *
 * Why this exists: `feedback_data_driven_gates` says no clock-bound
 * filters; the gold workstream takes a measured exception for the named
 * session windows + asian_range_break + post_news_window. The exception
 * is justified ONLY when this validator produces positive edge differential
 * against the same template without the filter. If a template's
 * `with_filter` walk-forward looks the same as `without_filter`, the
 * filter isn't earning its place and the template should be re-thought.
 *
 * Pure compute. No DB, no external calls — caller supplies the same price
 * corpus the search engine uses. Caller decides whether to log, persist,
 * or surface results.
 */
import type { PriceBar } from "@/lib/market-data/types";
import {
  runWalkForward,
  type WalkForwardOptions,
  type WalkForwardSummary,
} from "@/lib/market-data/walk-forward";
import type { AlgorithmRules, EntryCondition } from "@/types/algorithm";

/** Pattern names whose presence in entry_conditions triggers the dual run.
 *  Update this set when adding new gold-scoped primitives. */
const GOLD_ONLY_PATTERNS = new Set<string>([
  "gold_session_window",
  "asian_range_break",
  "post_news_window",
]);

export interface DualRunResult {
  with_filter: WalkForwardSummary;
  without_filter: WalkForwardSummary;
  /** Metric deltas (with_filter minus without_filter). Interpretation:
   *  - win_rate_of_windows_pp:  positive = filter helps
   *  - mean_return_pp:          positive = filter helps
   *  - mean_drawdown_pp:        negative = filter helps (less DD)
   *  - std_return_pp:           negative = filter helps (more stable) */
  edge_diff: {
    win_rate_of_windows_pp: number;
    mean_return_pp: number;
    mean_drawdown_pp: number;
    std_return_pp: number;
  };
  /** Count of gold-only conditions stripped for the without-filter run.
   *  When 0, both runs are identical and edge_diff is all zeros. */
  filters_stripped: number;
}

/**
 * Run the dual-comparison walk-forward. The without-filter rule is the
 * input rule with all gold-only pattern conditions removed from
 * entry_conditions. If the input has no gold-only patterns, both runs
 * are identical and edge_diff is all zeros — the caller should detect
 * this via `filters_stripped === 0` and skip reporting.
 */
export function dualRunGoldFilter(
  rules: AlgorithmRules,
  prices: Map<string, PriceBar[]>,
  capital: number,
  options: WalkForwardOptions
): DualRunResult {
  const stripped = stripGoldOnlyConditions(rules);
  const filtersStripped = rules.entry_conditions.length - stripped.entry_conditions.length;

  const withSummary = runWalkForward(rules, prices, capital, options);
  const withoutSummary = runWalkForward(stripped, prices, capital, options);

  return {
    with_filter: withSummary,
    without_filter: withoutSummary,
    edge_diff: {
      win_rate_of_windows_pp: roundpp(
        withSummary.win_rate_of_windows - withoutSummary.win_rate_of_windows
      ),
      mean_return_pp: roundpp(withSummary.mean_return - withoutSummary.mean_return),
      mean_drawdown_pp: roundpp(withSummary.mean_drawdown - withoutSummary.mean_drawdown),
      std_return_pp: roundpp(withSummary.std_return - withoutSummary.std_return),
    },
    filters_stripped: filtersStripped,
  };
}

function stripGoldOnlyConditions(rules: AlgorithmRules): AlgorithmRules {
  return {
    ...rules,
    entry_conditions: rules.entry_conditions.filter((c) => !isGoldOnlyPattern(c)),
  };
}

function isGoldOnlyPattern(cond: EntryCondition): boolean {
  return cond.type === "pattern" && GOLD_ONLY_PATTERNS.has(cond.pattern);
}

function roundpp(n: number): number {
  return Number(n.toFixed(4));
}
