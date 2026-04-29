/**
 * Wave 7 algorithm-creation flow: user provides (capital, monthly_target,
 * prefer/avoid). The system runs the combinatorial search, calibrates
 * the top candidate's risk to the target, and persists it as a draft
 * algorithm with watchlist seeded from the candidate's contributing
 * symbols.
 *
 * Distinct from the legacy `generateAlgorithm` server action — that
 * one is LLM-driven and asks the user to pick asset class / risk level
 * / time horizon / interests up front. This one outputs all of those
 * via search.
 *
 * `live_trading_enabled` is always false on creation; operator
 * activates manually after reviewing readiness check / paper performance.
 */
"use server";

import {
  runCombinatorialSearch,
  type SearchInput,
  type CandidateResult,
} from "@/lib/algorithm/combinatorial-search";
import { calibrateRiskToTarget, type CalibrationResult } from "@/lib/algorithm/combinatorial-search/calibrate";
import { loadDefaultPriceCorpus } from "@/lib/algorithm/combinatorial-search/price-loader";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types/action-result";
import { algorithmRulesSchema } from "@/lib/validators/algorithm";
import type { Algorithm } from "@/types/algorithm";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface GenerateFromSearchInput extends SearchInput {
  /** Optional name override. When omitted the system synthesises one
   *  from the candidate's template + universe. */
  name?: string;
  /** Optional description override. */
  description?: string;
}

export interface GenerateFromSearchSuccess {
  algorithm: Algorithm;
  /** The candidate the search picked, before calibration — for the UI
   *  to show "we tried X templates and picked this one because…" */
  picked_candidate: CandidateResult;
  /** Calibration outcome — caller can surface "scaled risk from 0.5% to
   *  1.2% to hit your 10% target" or "couldn't reach target — capped
   *  at 2% per trade, expected ~6% monthly". */
  calibration: CalibrationResult;
}

/**
 * Server action — uses the calling user's Supabase session (RLS
 * applies). For the admin / cron path use the helper directly with
 * `createAdminClient()`.
 */
export async function generateAlgorithmFromSearch(
  input: GenerateFromSearchInput
): Promise<ActionResult<GenerateFromSearchSuccess>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };
  return generateAlgorithmFromSearchForUser(supabase, user.id, input);
}

/**
 * Persistence helper — accepts an explicit `userId` so admin /
 * scheduled callers can use `createAdminClient()` without a session.
 *
 * Surfaces the search engine's "no candidates passed" state as a
 * structured error, not a thrown exception, so the UI can render a
 * helpful "loosen your constraints" prompt rather than a 500.
 */
export async function generateAlgorithmFromSearchForUser(
  supabase: SupabaseClient,
  userId: string,
  input: GenerateFromSearchInput
): Promise<ActionResult<GenerateFromSearchSuccess>> {
  if (input.capital <= 0) return { success: false, error: "Capital must be positive" };
  if (input.monthly_target_pct <= 0) {
    return { success: false, error: "Monthly target must be positive" };
  }

  const searchResult = await runCombinatorialSearch(input, loadDefaultPriceCorpus, {
    top_n: 1,
  });
  if (searchResult.top.length === 0) {
    return {
      success: false,
      error:
        searchResult.candidates_passed === 0
          ? `No candidates passed walk-forward stability + DD-safety + target ${input.monthly_target_pct}% over ${searchResult.candidates_evaluated} evaluated. Try lowering your monthly target or broadening prefer/avoid filters.`
          : "Search produced candidates but ranking returned empty — likely a scoring edge case.",
    };
  }

  const picked = searchResult.top[0];
  const calibration = calibrateRiskToTarget(
    picked.rules,
    picked.monthly_return_pct,
    input.monthly_target_pct
  );

  // Re-validate calibrated rules through the same Zod schema the legacy
  // generateAlgorithm path uses. Catches any cap-edge cases.
  const parsed = algorithmRulesSchema.safeParse(calibration.rules);
  if (!parsed.success) {
    return {
      success: false,
      error: `Calibrated rules failed validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    };
  }

  return persistGenerated(supabase, userId, input, picked, calibration);
}

/** Build the algorithm row + watchlist rows from a search-picked +
 *  calibrated candidate. Extracted so the parent function stays under
 *  the line-count cap; the persistence path is self-contained. */
async function persistGenerated(
  supabase: SupabaseClient,
  userId: string,
  input: GenerateFromSearchInput,
  picked: CandidateResult,
  calibration: CalibrationResult
): Promise<ActionResult<GenerateFromSearchSuccess>> {
  const name =
    input.name?.trim() ||
    `${picked.label.replace(/_/g, " ")} (search-found ${picked.monthly_return_pct.toFixed(1)}%/mo)`;
  const description = input.description?.trim() || buildAutoDescription(picked, calibration);

  const { data, error } = await supabase
    .from("algorithms")
    .insert({
      user_id: userId,
      name,
      description,
      asset_class: calibration.rules.asset_class,
      risk_level: deriveRiskLevel(calibration.rules),
      time_horizon: calibration.rules.timeframe,
      capital: input.capital,
      rules: calibration.rules,
      status: "draft" as const,
      live_trading_enabled: false,
      broker_connection_id: null,
      leverage: calibration.rules.leverage ?? 30,
    })
    .select()
    .single();
  if (error) return { success: false, error: error.message };

  const watchlistRows = picked.symbols.map((ticker) => ({
    algorithm_id: data.id,
    user_id: userId,
    ticker,
    name: ticker,
    added_by: "ai" as const,
    auto_paused: false,
  }));
  if (watchlistRows.length > 0) {
    // Non-fatal: algo exists; caller can re-seed if this fails.
    await supabase.from("algorithm_watchlist").insert(watchlistRows);
  }
  return {
    success: true,
    data: { algorithm: data as Algorithm, picked_candidate: picked, calibration },
  };
}

/** Build a default description summarising what the search picked +
 *  what calibration did. Operator can edit later. */
function buildAutoDescription(
  picked: CandidateResult,
  calibration: CalibrationResult
): string {
  const cap = calibration.capped
    ? ` (capped at ${calibration.calibrated_value}% per trade — target may not be reachable inside FTMO-safe risk; expected ~${calibration.estimated_monthly_pct.toFixed(1)}%/mo)`
    : "";
  const sym = picked.symbols.join(", ");
  return (
    `Auto-generated by combinatorial search. Template: ${picked.label}. ` +
    `Walk-forward: ${(picked.walk_forward.win_rate_of_windows * 100).toFixed(0)}% green windows, ` +
    `mean DD ${picked.walk_forward.mean_drawdown.toFixed(2)}%, score ${picked.score.toFixed(2)}. ` +
    `Symbols (search-screened): ${sym}. ` +
    `Risk calibrated from ${calibration.original_value}% to ${calibration.calibrated_value}% per trade${cap}.`
  );
}

/** Best-effort risk-level label for the algorithms.risk_level column.
 *  The legacy LLM path required the user to pick this up front; here
 *  we synthesise it from the calibrated risk so the UI's risk-level
 *  badges match what the algo actually does. */
function deriveRiskLevel(rules: import("@/types/algorithm").AlgorithmRules): string {
  const sizing = rules.position_sizing;
  let effective = 0;
  if (sizing.type === "risk_per_trade") effective = sizing.value;
  else if (sizing.type === "conviction_scaled") effective = sizing.value * (sizing.max_multiplier ?? 4);
  else if (sizing.type === "percentage_of_capital") effective = sizing.value / 50; // crude — 50% pos size ≈ 1% effective risk
  if (effective <= 0.7) return "conservative";
  if (effective <= 1.5) return "moderate";
  return "aggressive";
}
