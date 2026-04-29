/**
 * Per-hour-of-day win-rate aggregator. Walks an algorithm's closed
 * paper positions, buckets each by its entry hour (UTC), and computes
 * win rate per bucket.
 *
 * Used by the data-driven time-of-day filter: refuses entries during
 * hours whose historical WR is below a configured threshold. Empirical
 * — not a heuristic clock window. Works for whatever pattern the
 * algorithm's actual trading reveals (the friend's 84% in 09-17 UTC
 * concentration would appear here naturally if we replicated his
 * trading; another algorithm might show a different sweet spot).
 *
 * Min sample threshold per bucket avoids gating on noise — an hour
 * with 1-2 trades doesn't carry enough signal to refuse entries on it.
 * Default 5 samples; below that the bucket is reported but flagged
 * `informative: false` so the filter ignores it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface HourBucket {
  /** UTC hour 0-23. */
  hour: number;
  wins: number;
  losses: number;
  /** Wins ÷ (wins + losses). 0 when no closed trades. */
  wr_pct: number;
  samples: number;
  /** True when samples ≥ min_samples; only informative buckets contribute
   *  to filtering decisions. */
  informative: boolean;
}

export interface PerHourStatsOptions {
  /** Min closed trades per hour bucket to count as informative.
   *  Default 5. */
  min_samples?: number;
  /** Optional days-back window. When omitted, uses all closed trades.
   *  Useful for "recent regime" stats — older trades may reflect a
   *  different market regime. */
  window_days?: number;
}

interface ClosedRow {
  realized_pnl: number | null;
  opened_at: string;
}

/**
 * Aggregate closed paper-position trades for `algorithmId` into 24
 * hour-of-day buckets. Hour bucket is determined by the trade's
 * `opened_at` UTC hour, not the close hour — because the filter gates
 * ENTRIES, the entry timing is what matters.
 *
 * Returns a Map keyed by hour 0-23. Hours with no trades are still
 * present with samples=0 and informative=false so callers can iterate
 * the full 24-bucket distribution without conditional checks.
 */
export async function getPerHourStats(
  supabase: SupabaseClient,
  algorithmId: string,
  options: PerHourStatsOptions = {}
): Promise<Map<number, HourBucket>> {
  const minSamples = options.min_samples ?? 5;

  let query = supabase
    .from("paper_positions")
    .select("realized_pnl, opened_at")
    .eq("algorithm_id", algorithmId)
    .eq("status", "closed");

  if (options.window_days != null && options.window_days > 0) {
    const cutoff = new Date(Date.now() - options.window_days * 24 * 60 * 60 * 1000);
    query = query.gte("opened_at", cutoff.toISOString());
  }

  const { data } = await query;
  const rows = (data ?? []) as ClosedRow[];

  const buckets = new Map<number, HourBucket>();
  for (let h = 0; h < 24; h++) {
    buckets.set(h, { hour: h, wins: 0, losses: 0, wr_pct: 0, samples: 0, informative: false });
  }

  for (const r of rows) {
    if (r.realized_pnl == null) continue; // open or break-even-zero — skip
    const hour = new Date(r.opened_at).getUTCHours();
    const bucket = buckets.get(hour);
    if (!bucket) continue;
    if (r.realized_pnl > 0) bucket.wins++;
    else if (r.realized_pnl < 0) bucket.losses++;
    bucket.samples = bucket.wins + bucket.losses;
  }

  for (const bucket of buckets.values()) {
    bucket.wr_pct = bucket.samples > 0 ? (bucket.wins / bucket.samples) * 100 : 0;
    bucket.informative = bucket.samples >= minSamples;
  }
  return buckets;
}
