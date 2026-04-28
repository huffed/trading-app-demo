"use server";

import { fetchExchangeRate } from "@/lib/market-data/twelve-data";
import { createClient } from "@/lib/supabase/server";
import { type ActionResult } from "@/lib/types/action-result";

export type AutonomyLevel = "paper_only" | "suggest" | "semi_auto" | "full_auto";
export type PropFirmPresetSetting =
  | "ftmo"
  | "topstep"
  | "funded_next"
  | "the5ers"
  | "custom"
  | null;

export async function getProfile(): Promise<
  ActionResult<{
    full_name: string | null;
    email: string;
    timezone: string;
    default_currency: string;
    prop_firm_preset: PropFirmPresetSetting;
    autonomy_level: AutonomyLevel;
  }>
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { success: false, error: "Not authenticated" };
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("full_name, email, timezone, default_currency, prop_firm_preset, autonomy_level")
    .eq("id", user.id)
    .single();

  if (error) {
    return { success: false, error: error.message };
  }
  return { success: true, data };
}

export async function updateProfile(values: {
  full_name?: string;
  timezone?: string;
  default_currency?: string;
  prop_firm_preset?: PropFirmPresetSetting;
  autonomy_level?: AutonomyLevel;
}): Promise<ActionResult<null>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { success: false, error: "Not authenticated" };
  }

  const { error } = await supabase.from("profiles").update(values).eq("id", user.id);

  if (error) {
    return { success: false, error: error.message };
  }
  return { success: true, data: null };
}

export async function getExchangeRate(currency: string): Promise<ActionResult<number>> {
  if (currency === "USD") {
    return { success: true, data: 1 };
  }
  try {
    const rate = await fetchExchangeRate("USD", currency);
    return { success: true, data: rate };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to fetch exchange rate";
    return { success: false, error: msg };
  }
}
