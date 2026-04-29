/**
 * FTMO consistency-rule guard. FTMO's evaluation requires no single
 * trading day to exceed N% of the account's total net profit (40% on
 * the standard challenge, 50% on some funded plans). One blowout day
 * disqualifies the whole pass even if the rest of the metrics are
 * pristine — so the guard refuses to OPEN new entries on a day that
 * has already pushed today's contribution past the configured ratio.
 *
 * The check is approximate by design: FTMO evaluates the constraint
 * at the END of the trading window (cumulative-final basis), but we
 * make the call in real-time. A high mid-eval ratio can correct
 * itself if subsequent days add profit, so the guard is a "stop
 * making it worse" rule rather than "you've already failed".
 *
 * Halting LOGIC:
 *   tripped = today_net / total_net >= threshold/100
 *
 *   - total_net <= 0 → not tripped (no profit to be over-concentrated against)
 *   - today_net <= 0 → not tripped (a losing day reduces concentration risk)
 *   - threshold == 0 → disabled
 *
 * Distinct from `daily-halt.ts` (DLL force-close) and from
 * `consec-loss-halt.ts` (3-strikes streak halt).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

interface ClosedRow {
  realized_pnl: number | null;
  closed_at: string;
}

export interface ConsistencyHaltResult {
  /** True iff today's net profit is at or above the configured ratio
   *  of total accumulated net profit. */
  tripped: boolean;
  /** Sum of realized_pnl for trades closed today (UTC). */
  today_net: number;
  /** Sum of realized_pnl across all closed trades on this algorithm. */
  total_net: number;
  /** today_net / total_net, or 0 when total_net ≤ 0 (avoids divide-by-zero
   *  and a misleading "ratio" when there's no cumulative profit yet). */
  ratio: number;
  /** Threshold the ratio is being measured against, expressed as a
   *  fraction (40% → 0.40). */
  threshold: number;
}

/**
 * Compute today's profit ratio against lifetime profit and decide
 * whether to halt new entries. Pulls all closed trades for the algo
 * and partitions by today's UTC start; the per-algo close count is
 * small enough (hundreds per month even on aggressive scalping) that
 * a single SELECT is fine — no need for a server-side aggregate yet.
 *
 * `threshold_pct` is the FTMO-style percentage value (e.g. 40 → 40%).
 * Returns disabled (`tripped: false`) when the rule is 0 or unset.
 */
export async function checkConsistencyHalt(
  supabase: SupabaseClient,
  algorithmId: string,
  thresholdPct: number
): Promise<ConsistencyHaltResult> {
  const blank = (): ConsistencyHaltResult => ({
    tripped: false,
    today_net: 0,
    total_net: 0,
    ratio: 0,
    threshold: thresholdPct / 100,
  });
  if (!thresholdPct || thresholdPct <= 0) return blank();

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const startIso = startOfDay.toISOString();

  const { data } = await supabase
    .from("paper_positions")
    .select("realized_pnl, closed_at")
    .eq("algorithm_id", algorithmId)
    .eq("status", "closed");

  const rows = (data ?? []) as ClosedRow[];
  let totalNet = 0;
  let todayNet = 0;
  for (const r of rows) {
    const pnl = r.realized_pnl ?? 0;
    totalNet += pnl;
    if (r.closed_at >= startIso) {
      todayNet += pnl;
    }
  }
  if (totalNet <= 0 || todayNet <= 0) {
    return {
      tripped: false,
      today_net: todayNet,
      total_net: totalNet,
      ratio: 0,
      threshold: thresholdPct / 100,
    };
  }
  const ratio = todayNet / totalNet;
  return {
    tripped: ratio >= thresholdPct / 100,
    today_net: todayNet,
    total_net: totalNet,
    ratio,
    threshold: thresholdPct / 100,
  };
}
