"use server";

import { createClient } from "@/lib/supabase/server";

type ActionResult =
  | { success: true }
  | { success: false; error: string };

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
  return { success: true };
}
