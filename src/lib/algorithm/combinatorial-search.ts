/**
 * Combinatorial backtest search — the "give me an algorithm" entry point
 * for the Wave 7 autonomous-creation flow. The user provides three things:
 *
 *   - capital (e.g. $20,000)
 *   - monthly_target_pct (e.g. 10)
 *   - optional prefer / avoid filters (asset class or specific symbols)
 *
 * The system handles everything else: it walks a curated grid of
 * strategy templates × timeframes × SL/TP / sizing combinations, runs
 * walk-forward validation against a real price corpus, and returns the
 * top N candidates ranked by expected-return-per-unit-of-risk.
 *
 * Design constraints:
 *   - Must complete within ~2 min wall-clock so the user gets a result
 *     while sitting at the screen. Each candidate's walk-forward = O(seconds).
 *     The grid is sized so 50-80 candidates × 1.5s ≈ 1.5 min.
 *   - No DB writes — search is read-only. Persisting candidates is
 *     PR-B's job (replace the existing generateAlgorithm flow).
 *   - Reuses the production walk-forward + portfolio-backtest engines so
 *     candidates are scored against the same logic that runs live.
 *
 * Phase plan:
 *   PR-A (this file): search engine + admin endpoint. Smoke-testable in
 *                      isolation. Returns ranked candidates as JSON.
 *   PR-B:              hook into algorithm generation flow. Replace LLM-
 *                      driven rule emission with search-driven selection.
 *   PR-C:              UI — "show me 3 candidates" / pick + create.
 */
import type { WalkForwardSummary } from "@/lib/market-data/walk-forward";
import type { AlgorithmRules } from "@/types/algorithm";
import { evaluateCandidate } from "./combinatorial-search/evaluator";
import { enumerateCandidates, collectCandidateTimeframes } from "./combinatorial-search/grid";
import { filterUniverse } from "./combinatorial-search/universe";

export interface SearchInput {
  /** User's total trading capital. Drives sizing-percent calibration. */
  capital: number;
  /** User's stated monthly return target as a percentage of capital
   *  (e.g. 10 → "I want to make 10% per month"). Used as the pass-fail
   *  cutoff and as the calibration anchor for risk_per_trade. */
  monthly_target_pct: number;
  /** Optional asset-class filter. Empty / undefined = catalog default
   *  (forex + commodities). When set, only symbols whose `assetClass`
   *  matches are eligible. */
  prefer_asset_classes?: string[];
  /** Asset classes to exclude from the search universe. */
  avoid_asset_classes?: string[];
  /** Specific symbols to prefer (if non-empty, search universe is
   *  limited to these). */
  prefer_symbols?: string[];
  /** Specific symbols to exclude. */
  avoid_symbols?: string[];
}

export interface CandidateResult {
  rank: number;
  /** The full rule object — ready to insert into `algorithms.rules`
   *  if the user picks this candidate. */
  rules: AlgorithmRules;
  /** Symbols that contributed bars to the walk-forward backtest. */
  symbols: string[];
  /** Aggregate score used for ranking. Higher = better. */
  score: number;
  /** Mean per-window return, expressed as a fraction (0.10 = 10%). */
  monthly_return_pct: number;
  /** Worst single-window drawdown, percent. */
  worst_dd_pct: number;
  /** Walk-forward result so the UI can show evidence behind the score. */
  walk_forward: WalkForwardSummary;
  /** Why this candidate is in the ranking. Each predicate is a binary
   *  pass/fail on a real readiness criterion. */
  pass_criteria: {
    walk_forward_green: boolean;
    target_met: boolean;
    dd_safe: boolean;
  };
  /** Human-readable label so the UI / log doesn't have to derive it. */
  label: string;
}

export interface SearchResult {
  /** Total candidate configs evaluated (some may have failed early). */
  candidates_evaluated: number;
  /** Subset that passed all hard gates (walk-forward green, target met,
   *  DD safe). Only these are eligible for the top-N ranking. */
  candidates_passed: number;
  /** Top N by score, descending. Empty when nothing passed — the caller
   *  should surface the closest near-misses or recommend the user
   *  loosen constraints. */
  top: CandidateResult[];
  /** All evaluated candidates (passed and failed), only populated when
   *  `include_evaluated: true` is set in options. Used for diagnostics
   *  — too verbose for the default response. */
  all_evaluated?: CandidateResult[];
  /** Wall-clock duration of the search run (ms). Surfaced for
   *  observability — if this consistently approaches the design budget
   *  (~120s) we either trim the grid or move to background processing. */
  duration_ms: number;
}

export interface SearchOptions {
  /** Cap on how many candidate rule combos to evaluate. Default 60.
   *  Smaller for faster iteration; larger for more thorough search. */
  max_candidates?: number;
  /** How many top candidates to surface. Default 5. */
  top_n?: number;
  /** Walk-forward window settings. Default 180-day window, 30-day step
   *  (matches the readiness-check defaults). */
  walk_forward_window_days?: number;
  walk_forward_step_days?: number;
  /** Include the full evaluated candidate list in the response (passed
   *  + failed). Off by default — only enable for diagnostics, since
   *  payload grows linearly with grid size. */
  include_evaluated?: boolean;
}

/**
 * Run the search. Pure compute — no Supabase needed. Caller must
 * already have ensured price bars are available (via getCachedPrices /
 * fetchDailyPrices); the search uses an injected price loader so it
 * stays testable without network mocks.
 *
 * Returns ranked candidates. When zero pass the gates, `top` is empty
 * and the caller should either widen the user's constraints (lower
 * monthly_target, broaden universe) or surface "no algorithm matches".
 *
 * Implementation lives in the helper modules below — kept in this file
 * for now since the surface area is small and the modules co-evolve.
 * Will split when any of them grows beyond ~150 lines.
 */
export async function runCombinatorialSearch(
  input: SearchInput,
  loadPriceCorpus: PriceCorpusLoader,
  options: SearchOptions = {}
): Promise<SearchResult> {
  const start = Date.now();
  const maxCandidates = options.max_candidates ?? 60;
  const topN = options.top_n ?? 5;
  const windowDays = options.walk_forward_window_days ?? 180;
  const stepDays = options.walk_forward_step_days ?? 30;

  const universe = filterUniverse(input);
  if (universe.length === 0) {
    return { candidates_evaluated: 0, candidates_passed: 0, top: [], duration_ms: Date.now() - start };
  }

  const rawCandidates = enumerateCandidates(input);
  const candidates = rawCandidates.slice(0, maxCandidates);

  // Pre-load prices once per timeframe needed by the candidate set,
  // not per-candidate. Most templates only use 1 or 2 timeframes
  // total — pre-loading shaves the per-candidate evaluation cost
  // by avoiding redundant cache lookups.
  const timeframesNeeded = collectCandidateTimeframes(candidates);
  const priceCorpus = await loadPriceCorpus(universe, timeframesNeeded);

  const evaluated: CandidateResult[] = [];
  for (const cand of candidates) {
    const result = evaluateCandidate(cand, priceCorpus, input, windowDays, stepDays);
    if (result) evaluated.push(result);
  }

  const passed = evaluated.filter(
    (c) => c.pass_criteria.walk_forward_green && c.pass_criteria.target_met && c.pass_criteria.dd_safe
  );
  passed.sort((a, b) => b.score - a.score);
  const top = passed.slice(0, topN).map((c, i) => ({ ...c, rank: i + 1 }));

  const result: SearchResult = {
    candidates_evaluated: evaluated.length,
    candidates_passed: passed.length,
    top,
    duration_ms: Date.now() - start,
  };
  if (options.include_evaluated) {
    // Sort all evaluated by score descending so the diagnostic view is
    // still useful at a glance. Don't reassign rank — that field is only
    // meaningful for the canonical top-N.
    const all = [...evaluated].sort((a, b) => b.score - a.score);
    result.all_evaluated = all;
  }
  return result;
}

// Forward-declare the helper signatures used above — implementations
// follow in this file. Keeping them at the bottom so the public API
// reads first.

/** Loads price bars for the universe. The caller supplies the loader so
 *  the search engine has no network dependency in tests. Returns
 *  Map<timeframe, Map<symbol, bars>>. */
export type PriceCorpusLoader = (
  symbols: string[],
  timeframes: string[]
) => Promise<Map<string, Map<string, import("@/lib/market-data/types").PriceBar[]>>>;
