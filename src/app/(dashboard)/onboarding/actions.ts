"use server";

import { generateAlgorithm } from "@/app/(dashboard)/algorithms/actions";
import { seedWatchlist } from "@/app/(dashboard)/algorithms/seed-watchlist-action";
import { createClient } from "@/lib/supabase/server";
import { deriveTradingParams } from "@/lib/utils/derive-trading-params";
import { tradingProfileSchema } from "@/lib/validators/trading-profile";
import type { TradingProfile, TradingProfileAnswers } from "@/types/trading-profile";

type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string };

export async function completeOnboarding(): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  const { error } = await supabase
    .from("profiles")
    .update({ onboarding_completed: true })
    .eq("id", user.id);

  if (error) return { success: false, error: error.message };
  return { success: true, data: undefined };
}

/**
 * Save the trading profile from the onboarding wizard and auto-generate
 * the user's first algorithm using their derived preferences.
 * Returns the new algorithm's ID for navigation.
 */
export async function saveTradingProfileAndGenerate(
  answers: TradingProfileAnswers
): Promise<ActionResult<string>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  // Derive trading parameters from wizard answers
  const derived = deriveTradingParams(answers);
  const profile: TradingProfile = { answers, derived };

  // Validate
  const parsed = tradingProfileSchema.safeParse(profile);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message };

  // Save profile
  const { error: profileError } = await supabase
    .from("profiles")
    .update({ trading_profile: parsed.data })
    .eq("id", user.id);
  if (profileError) return { success: false, error: profileError.message };

  // Generate first algorithm using derived params
  const algoResult = await generateAlgorithm({
    asset_class: derived.asset_class,
    risk_level: derived.risk_level,
    capital: answers.capital,
    time_horizon: derived.time_horizon,
    user_hints: derived.user_hints,
  });

  if (!algoResult.success) return { success: false, error: algoResult.error };

  // Best-effort: seed watchlist with discovered tickers
  seedWatchlist(algoResult.data.id).catch((e) =>
    console.warn("[onboarding] Failed to seed watchlist:", e instanceof Error ? e.message : e)
  );

  return { success: true, data: algoResult.data.id };
}
