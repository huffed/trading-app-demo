"use server";

import { createClient } from "@/lib/supabase/server";

/**
 * Mark onboarding as completed for the current user. Called from
 * TourProvider when the operator dismisses the tour overlay. After
 * this fires, the tour overlay won't show again.
 *
 * Note: this used to also seed a generated algorithm via the wizard
 * flow. The wizard was deleted (PR #270) so the action is now just
 * the boolean flip.
 */
export async function completeOnboarding(): Promise<{ success: boolean; error?: string }> {
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
