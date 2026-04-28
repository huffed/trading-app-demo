"use server";

import { getAuthedUser } from "@/lib/supabase/get-authed-user";
import { type ActionResult } from "@/lib/types/action-result";
import type { CreatePortfolioInput, Portfolio } from "@/types/portfolio";

export async function createPortfolio(
  input: CreatePortfolioInput
): Promise<ActionResult<Portfolio>> {
  try {
    const { supabase, user } = await getAuthedUser();
    const { data, error } = await supabase
      .from("portfolios")
      .insert({
        user_id: user.id,
        name: input.name.trim(),
        capital: input.capital,
        broker_connection_id: input.broker_connection_id ?? null,
        prop_firm_rules: input.prop_firm_rules ?? {},
      })
      .select()
      .single();
    if (error) return { success: false, error: error.message };
    return { success: true, data: data as unknown as Portfolio };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create portfolio";
    return { success: false, error: msg };
  }
}

export async function listPortfolios(): Promise<ActionResult<Portfolio[]>> {
  try {
    const { supabase, user } = await getAuthedUser();
    const { data, error } = await supabase
      .from("portfolios")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    if (error) return { success: false, error: error.message };
    return { success: true, data: (data ?? []) as unknown as Portfolio[] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to list portfolios";
    return { success: false, error: msg };
  }
}

/**
 * Link or unlink an algorithm to a portfolio. Pass `null` portfolioId to
 * detach. Caller must own both the algorithm and the portfolio.
 */
export async function linkAlgorithmToPortfolio(
  algorithmId: string,
  portfolioId: string | null
): Promise<ActionResult<{ algorithm_id: string; portfolio_id: string | null }>> {
  try {
    const { supabase, user } = await getAuthedUser();
    if (portfolioId) {
      const { data: portfolio } = await supabase
        .from("portfolios")
        .select("id")
        .eq("id", portfolioId)
        .eq("user_id", user.id)
        .single();
      if (!portfolio) return { success: false, error: "Portfolio not found" };
    }
    const { error } = await supabase
      .from("algorithms")
      .update({ portfolio_id: portfolioId })
      .eq("id", algorithmId)
      .eq("user_id", user.id);
    if (error) return { success: false, error: error.message };
    return {
      success: true,
      data: { algorithm_id: algorithmId, portfolio_id: portfolioId },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to link";
    return { success: false, error: msg };
  }
}
