/**
 * Parse a bar `date` string as UTC, regardless of the host machine's
 * timezone setting.
 *
 * Why this is needed: both providers (Twelve Data with `timezone=UTC`,
 * OANDA after our `oanda.ts` normalisation) emit bar dates in the
 * format `"YYYY-MM-DD HH:MM:SS"` with NO timezone marker. Node's
 * `new Date(string)` on that format defaults to the SYSTEM-LOCAL
 * timezone, NOT UTC. On a host running in BST (UTC+1), every bar
 * gets parsed 60 min earlier than reality — every wall-clock-vs-bar
 * comparison reads as 60 min more stale than it actually is.
 *
 * The 2026-05-12 incident: the bar-staleness gate fired on every 15m
 * scan after the cron had been correctly fetching fresh OANDA bars.
 * The gate's log showed `last_bar_date: 2026-05-12T08:00:00.000Z`
 * when the actual fresh bar was at `09:00:00 UTC` — the .toISOString()
 * was the BST-misparsed representation. Threshold 22.5 min, computed
 * age 75 min → false-positive refusal.
 *
 * This helper handles both formats:
 *  - "YYYY-MM-DD HH:MM:SS" → append T + Z, parsed unambiguously as UTC
 *  - "YYYY-MM-DDTHH:MM:SS...Z" (Supabase / ISO 8601 with TZ marker) →
 *    plain `new Date(...)` is already TZ-correct, pass through
 *
 * Use this anywhere a bar's date is compared against wall-clock `Date.now()`
 * or used with `.getUTCHours()` etc. Bar-vs-bar comparisons (sort,
 * resample alignment) are TZ-shift-cancelling and don't strictly need
 * this — but using it everywhere is harmless and removes the foot-gun.
 */

export function parseBarDate(input: string | Date): Date {
  if (input instanceof Date) return input;
  // Already TZ-marked (Z or ±HH:MM offset)? Constructor is already
  // unambiguous, return directly.
  if (
    input.includes("T") &&
    (input.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(input))
  ) {
    return new Date(input);
  }
  // Naïve "YYYY-MM-DD HH:MM:SS" — append Z so Node parses as UTC.
  return new Date(input.replace(" ", "T") + "Z");
}
