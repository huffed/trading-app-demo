/**
 * Per-candidate evaluator. Runs walk-forward on the candidate's price
 * corpus, applies pass-fail gates against the user's targets, and
 * computes a single aggregate score for ranking.
 *
 * Score formula:
 *   score = monthly_return − dd_penalty − instability_penalty
 *
 *   dd_penalty         = max(0, mean_dd_pct − 5) / 5
 *     - dd up to 5% is "free" (well under the FTMO 10% cap)
 *     - each 5pp above 5% costs 1.0 score points (linear ramp)
 *   instability_penalty = (std_return / |mean_return|) × 0.5
 *     - normalised CV penalty; a strategy with mean 10% std 10% pays
 *       0.5 score points, mean 10% std 5% pays 0.25
 *     - skipped when mean_return ≤ 0 (CV is meaningless when the mean
 *       is negative or zero)
 *
 * The score isn't on a fixed scale — it's only meaningful for ranking
 * candidates against each other within a single search run. The caller
 * should never compare scores across runs (different price ranges,
 * different windows, different universe).
 */
import type { PriceBar } from "@/lib/market-data/types";
import { runWalkForward } from "@/lib/market-data/walk-forward";
import type { Candidate } from "./grid";
import type { CandidateResult, SearchInput } from "../combinatorial-search";

const DD_FREE_THRESHOLD_PCT = 5;
const DD_PENALTY_DIVISOR = 5;
const INSTABILITY_PENALTY_WEIGHT = 0.5;

/** Pass-fail gates. Each predicate is a single readiness criterion;
 *  a candidate must clear all three to be eligible for the top-N. */
const MIN_GREEN_WINDOW_RATE = 0.7;
const MAX_MEAN_DD_PCT = 8;
const MAX_WINDOW_DD_PCT = 10;

/**
 * Evaluate a single candidate. Returns null when the candidate can't
 * be scored (no price corpus for its timeframe, walk-forward produced
 * zero windows). The runner treats null as "drop silently" — it's not
 * a failure that should surface to the user, just a degenerate combo.
 */
export function evaluateCandidate(
  candidate: Candidate,
  priceCorpus: Map<string, Map<string, PriceBar[]>>,
  input: SearchInput,
  windowDays: number,
  stepDays: number
): CandidateResult | null {
  const tfPrices = priceCorpus.get(candidate.rules.timeframe);
  if (!tfPrices || tfPrices.size === 0) return null;

  const wf = runWalkForward(candidate.rules, tfPrices, input.capital, {
    testWindowDays: windowDays,
    stepDays,
  });
  if (wf.total_windows === 0) return null;

  const monthlyReturnPct = windowReturnToMonthlyPct(wf.mean_return, input.capital, windowDays);
  const worstDdPct = wf.windows.reduce((max, w) => Math.max(max, w.max_drawdown), 0);

  const passWalkForward = wf.win_rate_of_windows >= MIN_GREEN_WINDOW_RATE;
  const passTarget = monthlyReturnPct >= input.monthly_target_pct;
  const passDd = wf.mean_drawdown <= MAX_MEAN_DD_PCT && worstDdPct <= MAX_WINDOW_DD_PCT;

  const score = computeScore(monthlyReturnPct, wf.mean_drawdown, wf.std_return, wf.mean_return);

  return {
    rank: 0, // assigned by the caller after sorting
    rules: candidate.rules,
    symbols: Array.from(tfPrices.keys()),
    score,
    monthly_return_pct: monthlyReturnPct,
    worst_dd_pct: worstDdPct,
    walk_forward: wf,
    pass_criteria: {
      walk_forward_green: passWalkForward,
      target_met: passTarget,
      dd_safe: passDd,
    },
    label: candidate.label,
  };
}

/**
 * Convert a walk-forward window's mean return (USD) into a monthly
 * percentage of the user's capital.
 *
 * `mean_return` from walk-forward is the average per-window absolute
 * USD return (each window resets capital to the original, so windows
 * don't compound — see walk-forward.ts header). We convert to monthly
 * pct by:
 *   1. windowMonths = windowDays / 30
 *   2. windowReturnPct = mean_return / capital × 100
 *   3. monthlyPct = windowReturnPct / windowMonths
 *
 * This is the same shape the user's `monthly_target_pct` uses, so the
 * pass-fail gate is a direct comparison.
 */
function windowReturnToMonthlyPct(
  meanReturnUsd: number,
  capital: number,
  windowDays: number
): number {
  if (capital <= 0 || windowDays <= 0) return 0;
  const windowMonths = windowDays / 30;
  const windowReturnPct = (meanReturnUsd / capital) * 100;
  return windowReturnPct / windowMonths;
}

function computeScore(
  monthlyReturnPct: number,
  meanDdPct: number,
  stdReturn: number,
  meanReturn: number
): number {
  const ddPenalty = Math.max(0, meanDdPct - DD_FREE_THRESHOLD_PCT) / DD_PENALTY_DIVISOR;
  let instabilityPenalty = 0;
  if (meanReturn > 0) {
    const cv = stdReturn / Math.abs(meanReturn);
    instabilityPenalty = cv * INSTABILITY_PENALTY_WEIGHT;
  }
  return monthlyReturnPct - ddPenalty - instabilityPenalty;
}
