/**
 * Typed env-var access with lazy validation. Each accessor throws a clear
 * error on first use if the var is missing — beats undefined-flowing-through-
 * fetch-calls debugging at 2am.
 *
 * Conventions:
 *  - Required vars throw `Missing required env var: NAME` if absent.
 *  - Optional vars return null when absent (callers branch on null).
 *  - Server-only secrets accessed client-side will read undefined from
 *    process.env (Next.js inlines only NEXT_PUBLIC_*) and throw, which is
 *    exactly what we want — the mistake fails loudly at the call site.
 *
 * Add new vars here, document them in `.env.example`, and migrate the
 * inline `process.env.X` reads when convenient.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

export const env = {
  // --- Browser-safe (NEXT_PUBLIC_*) ---
  get supabaseUrl() {
    return required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);
  },
  get supabaseAnonKey() {
    return required("NEXT_PUBLIC_SUPABASE_ANON_KEY", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  },

  // --- Server-only secrets ---
  get supabaseServiceRoleKey() {
    return required("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY);
  },
  get groqApiKey() {
    return required("GROQ_API_KEY", process.env.GROQ_API_KEY);
  },
  get alphaVantageApiKey() {
    return required("ALPHA_VANTAGE_API_KEY", process.env.ALPHA_VANTAGE_API_KEY);
  },
  get finnhubApiKey() {
    return required("FINNHUB_API_KEY", process.env.FINNHUB_API_KEY);
  },
  get twelveDataApiKey() {
    return required("TWELVE_DATA_API_KEY", process.env.TWELVE_DATA_API_KEY);
  },
  get cronSecret() {
    return required("CRON_SECRET", process.env.CRON_SECRET);
  },

  // --- Optional broker creds ---
  get ctraderClientId() {
    return optional(process.env.CTRADER_CLIENT_ID);
  },
  get ctraderClientSecret() {
    return optional(process.env.CTRADER_CLIENT_SECRET);
  },

  // --- System ---
  get isProduction() {
    return process.env.NODE_ENV === "production";
  },
};
