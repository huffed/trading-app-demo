/**
 * Cumulative paper-vs-broker divergence kill switch.
 *
 * The backtest engine models a fixed slippage in basis points; the live
 * bridge can quietly diverge from this if the broker's real fills are
 * consistently worse than expected. We watch the rolling average of
 * |broker_fill - entry| in bps across the last N entries that produced a
 * recorded broker fill, and disable live trading on the algorithm once it
 * crosses the user-configured threshold.
 *
 * Bps is unit-neutral, so the same threshold (e.g., 20 bp = 0.20%) works
 * across forex, commodities, and equities. 1 pip on EUR/USD ≈ 1.4 bp,
 * 1 pip on EUR/JPY ≈ 0.5 bp.
 */
import { logActivity } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

interface DivergenceKillRule {
  max_avg_bps: number;
  window_trades: number;
}

interface PositionRow {
  entry_price: number;
  broker_fill_price: number | null;
}

export interface DivergenceCheckResult {
  /** True iff the average crossed the threshold AND we have enough samples. */
  tripped: boolean;
  /** Mean absolute divergence in bps across the window. NaN with <2 samples. */
  avgBps: number;
  /** How many entries with a real broker fill we used in the average. */
  samples: number;
}

/**
 * Compute the rolling-mean divergence and decide whether to halt. Caller is
 * responsible for actually disabling live trading on the algorithm; this
 * helper only measures + reports. Returns {tripped: false} when sample size
 * is below the configured window, even if early data already exceeds the
 * threshold — small samples are too noisy to halt on.
 */
export async function checkDivergenceKill(
  supabase: SupabaseClient,
  algorithmId: string,
  rule: DivergenceKillRule
): Promise<DivergenceCheckResult> {
  const { data } = await supabase
    .from("paper_positions")
    .select("entry_price, broker_fill_price")
    .eq("algorithm_id", algorithmId)
    .not("broker_fill_price", "is", null)
    .order("opened_at", { ascending: false })
    .limit(rule.window_trades);

  const rows = (data ?? []) as PositionRow[];
  const samples = rows.length;
  if (samples < rule.window_trades) {
    return { tripped: false, avgBps: NaN, samples };
  }

  let sum = 0;
  for (const r of rows) {
    if (r.broker_fill_price == null || r.entry_price <= 0) continue;
    const bps = Math.abs(r.broker_fill_price - r.entry_price) / r.entry_price * 10000;
    sum += bps;
  }
  const avgBps = sum / samples;
  return { tripped: avgBps > rule.max_avg_bps, avgBps, samples };
}

/**
 * Halt the algorithm in response to a tripped divergence check. Disables
 * live trading (so future scans don't mirror to broker) and writes an
 * activity log entry that captures the metric for future review. Paper
 * trading + scans continue — only the broker mirror is paused.
 */
export async function haltAlgorithmForDivergence(
  supabase: SupabaseClient,
  userId: string,
  algorithmId: string,
  result: DivergenceCheckResult,
  rule: DivergenceKillRule
): Promise<void> {
  await supabase
    .from("algorithms")
    .update({ live_trading_enabled: false })
    .eq("id", algorithmId);

  await logActivity(supabase, userId, {
    algorithm_id: algorithmId,
    event_type: "divergence_halt",
    details: {
      avg_bps: Number(result.avgBps.toFixed(2)),
      threshold_bps: rule.max_avg_bps,
      samples: result.samples,
      window_trades: rule.window_trades,
    },
  });
}
