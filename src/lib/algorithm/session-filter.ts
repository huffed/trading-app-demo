/**
 * Session window filter — blocks entries outside the configured UTC hours.
 *
 * Disciplined human FTMO traders typically trade within the London +
 * London/NY-overlap window (07:00-16:00 UTC). Trading 24/7 produces
 * entries during low-liquidity periods (Sunday open, Asian session for
 * non-Asian pairs) where spreads are wider and price action is choppier.
 * The friend-trade analysis showed 84% of his trades inside 07-16 UTC.
 *
 * Used by both the live scan engine (entry.ts) and the backtest engines
 * (single-ticker + portfolio) so live behaviour matches what the backtest
 * validates against.
 */
import type { SessionFilter } from "@/types/algorithm";

export interface SessionGateResult {
  /** True when the timestamp is outside the configured session — entries
   *  should be skipped. */
  outside: boolean;
  /** Human-readable reason, suitable for activity_log details.reason. */
  reason?: string;
}

/**
 * Check whether a timestamp falls inside the configured trading session.
 * - filter undefined or disabled → never outside (no-op)
 * - start ≤ hour < end → inside (allowed)
 * - otherwise → outside (skip the entry)
 *
 * Wrap-around windows (e.g. 22-06 for Asian session) are not currently
 * supported — start_hour_utc must be less than end_hour_utc. The schema
 * enforces this, but the helper short-circuits to "inside" if a malformed
 * filter ever slips through.
 */
export function checkSessionFilter(
  filter: SessionFilter | undefined,
  now: Date
): SessionGateResult {
  if (!filter || !filter.enabled) return { outside: false };
  if (filter.start_hour_utc >= filter.end_hour_utc) return { outside: false };
  const hour = now.getUTCHours();
  if (hour >= filter.start_hour_utc && hour < filter.end_hour_utc) {
    return { outside: false };
  }
  return {
    outside: true,
    reason: `Outside session ${pad(filter.start_hour_utc)}-${pad(filter.end_hour_utc)} UTC (now ${pad(hour)}:00)`,
  };
}

function pad(h: number): string {
  return String(h).padStart(2, "0");
}
