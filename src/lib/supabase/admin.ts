/**
 * Service-role Supabase client. Bypasses RLS — only use from trusted server
 * paths (cron jobs, internal admin tasks). Never expose this client to a
 * route that takes user input without manual user_id scoping.
 *
 * The cron scan route uses this because cron has no user session: it queries
 * active algorithms across all users, then re-scopes each scan to the
 * algorithm's owner via explicit user_id arguments to scanAlgorithm.
 */
import { createClient } from "@supabase/supabase-js";

let cached: ReturnType<typeof createClient> | null = null;

export function createAdminClient() {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars"
    );
  }

  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
