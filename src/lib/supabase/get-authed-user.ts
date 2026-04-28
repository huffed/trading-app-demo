import { createClient } from "./server";

/**
 * Server-action helper: resolves the current Supabase client and user, or
 * throws if unauthenticated. Callers wrap in try/catch and surface the
 * error via ActionResult{ success: false, error }.
 *
 * Use the throw-style helper in actions that fan out to multiple Supabase
 * calls — keeps the auth check off every line. For single-call actions,
 * the inline `if (!user) return { success: false, error: ... }` pattern
 * is still fine.
 */
export async function getAuthedUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("Not authenticated");
  }
  return { supabase, user };
}
