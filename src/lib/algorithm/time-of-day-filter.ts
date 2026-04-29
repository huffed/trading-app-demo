/**
 * Data-driven time-of-day filter. Refuses entries during hours whose
 * historical win rate is below a configured threshold.
 *
 * Empirical, not heuristic — the filter pulls per-hour win rates from
 * the algorithm's own closed trades and decides per-hour from the
 * data. An algorithm whose data shows London/NY-overlap dominance
 * naturally restricts itself to those hours; one that finds an Asian
 * session edge keeps that intact. The friend's 84% in 09-17 UTC
 * concentration would emerge here without being baked in.
 *
 * Warm-up: with no trade history, every bucket has 0 samples and the
 * filter is a no-op. As trades accumulate to ≥ min_samples per hour,
 * those hours' WR becomes informative and the filter can start
 * refusing entries during clearly-bad hours.
 *
 * Distinct from the deleted clock-time `session_filter`: that one
 * baked in 07-17 UTC as a constant. This one learns the right window
 * per algorithm from its own track record.
 */
import type { HourBucket } from "@/lib/scan/per-hour-stats";

export interface TimeOfDayFilterConfig {
  enabled: boolean;
  /** Minimum WR percentage required to allow entries during an hour.
   *  Hours with informative samples below this are blocked. Default 45
   *  — keeps coin-flip-or-better hours, blocks clearly-losing ones.
   *  Tighten to 50 / 55 once enough data accumulates to be reliable. */
  min_wr_pct?: number;
  /** Override for the per-hour-stats min_samples threshold. Default
   *  matches getPerHourStats default of 5. Bumped here would require
   *  a deeper history before any hour bucket starts gating. */
  min_samples?: number;
}

export interface TimeOfDayFilterResult {
  /** True when the entry should be skipped — current hour has informative
   *  samples AND its WR is below the threshold. */
  block: boolean;
  /** Human-readable reason, suitable for activity_log details.reason. */
  reason?: string;
  /** Telemetry — present whether the filter blocks or allows. */
  hour: number;
  hour_wr_pct: number;
  hour_samples: number;
  hour_informative: boolean;
  /** "blocked" | "allowed" | "no_data" (no samples yet at this hour) |
   *  "disabled" (filter switched off in rules). */
  status: "blocked" | "allowed" | "no_data" | "disabled";
}

const DEFAULT_MIN_WR = 45;

/**
 * Decide whether to block an entry at the current hour. Pure function —
 * caller fetches the per-hour stats once per scan tick and passes the
 * relevant bucket in.
 *
 * Returns `status: "no_data"` (allow) when the hour bucket isn't
 * informative yet — preferred over blocking because new algorithms
 * shouldn't get locked out before they've had a chance to trade
 * across the clock.
 */
export function checkTimeOfDayFilter(
  config: TimeOfDayFilterConfig | undefined,
  bucket: HourBucket | undefined
): TimeOfDayFilterResult {
  const hour = bucket?.hour ?? new Date().getUTCHours();
  const empty: TimeOfDayFilterResult = {
    block: false,
    hour,
    hour_wr_pct: 0,
    hour_samples: 0,
    hour_informative: false,
    status: "disabled",
  };
  if (!config?.enabled) return empty;
  if (!bucket) {
    return { ...empty, status: "no_data" };
  }
  const minWr = config.min_wr_pct ?? DEFAULT_MIN_WR;
  const result: TimeOfDayFilterResult = {
    block: false,
    hour: bucket.hour,
    hour_wr_pct: Number(bucket.wr_pct.toFixed(1)),
    hour_samples: bucket.samples,
    hour_informative: bucket.informative,
    status: "allowed",
  };
  if (!bucket.informative) {
    result.status = "no_data";
    return result;
  }
  if (bucket.wr_pct < minWr) {
    result.block = true;
    result.status = "blocked";
    result.reason = `Time-of-day filter: hour ${pad(bucket.hour)}:00 UTC has ${bucket.wr_pct.toFixed(0)}% WR over ${bucket.samples} closed trades (min ${minWr}%)`;
  }
  return result;
}

function pad(h: number): string {
  return String(h).padStart(2, "0");
}
