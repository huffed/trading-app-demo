/**
 * Portfolio-level daily-loss-limit halt. Mirrors the per-algorithm
 * `daily-halt` module but operates over an entire portfolio: sums
 * realised + unrealised P&L across every algorithm linked to the
 * portfolio, compares against the portfolio's `prop_firm_rules` DLL,
 * and on breach flattens EVERY algorithm's open positions and disables
 * live trading on all of them.
 *
 * Runs once per scan ahead of the per-algorithm scans. Without this,
 * three algos at \$700 risk each could collectively breach FTMO's 5%
 * DLL even though no single algo crossed its own threshold.
 */
import { getTodayAnchor } from "@/lib/utils/date";
import type { Portfolio } from "@/types/portfolio";
import { flattenAlgorithmPositions } from "./flatten";
import { logActivity } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

interface PnlRow {
  realized_pnl: number | null;
}
interface OpenRow {
  unrealized_pnl: number | null;
}

export interface PortfolioHaltResult {
  tripped: boolean;
  todays_pnl_pct: number;
  threshold_pct: number;
  realized: number;
  unrealized: number;
  algos_in_portfolio: number;
}

/**
 * Measure today's combined P&L across every algorithm in a portfolio.
 * Returns null when the portfolio has no DLL configured.
 */
export async function checkPortfolioHalt(
  supabase: SupabaseClient,
  portfolio: Portfolio,
  algoIds: string[]
): Promise<PortfolioHaltResult | null> {
  const pf = portfolio.prop_firm_rules;
  if (!pf?.daily_loss_limit) return null;
  if (algoIds.length === 0) return null;

  const startIso = getTodayAnchor().utcIso;

  const [closedTodayRes, openRes] = await Promise.all([
    supabase
      .from("paper_positions")
      .select("realized_pnl")
      .in("algorithm_id", algoIds)
      .eq("status", "closed")
      .gte("closed_at", startIso),
    supabase
      .from("paper_positions")
      .select("unrealized_pnl")
      .in("algorithm_id", algoIds)
      .eq("status", "open"),
  ]);

  const realized = ((closedTodayRes.data ?? []) as PnlRow[]).reduce(
    (s, r) => s + (r.realized_pnl ?? 0),
    0
  );
  const unrealized = ((openRes.data ?? []) as OpenRow[]).reduce(
    (s, r) => s + (r.unrealized_pnl ?? 0),
    0
  );

  const haltPct = (pf.daily_loss_halt_pct ?? 100) / 100;
  const thresholdPct = -pf.daily_loss_limit * haltPct;
  const todaysPnlPct =
    portfolio.capital > 0 ? ((realized + unrealized) / portfolio.capital) * 100 : 0;

  return {
    tripped: todaysPnlPct <= thresholdPct,
    todays_pnl_pct: todaysPnlPct,
    threshold_pct: thresholdPct,
    realized,
    unrealized,
    algos_in_portfolio: algoIds.length,
  };
}

/**
 * Has this portfolio already fired its halt today? E2.25.d — without
 * this guard `applyPortfolioHalts` re-flattens (no-op), re-disables
 * live trading, and writes N `portfolio_halt` rows on EVERY 15-min tick
 * of a tripped day (~380 rows/day for a 4-algo portfolio), because the
 * halt condition (realized loss ≥ threshold today) stays true until the
 * UTC day rolls over. One halt per portfolio per day is sufficient —
 * the flatten already closed everything and disabled the mirror.
 */
export async function portfolioHaltFiredToday(
  supabase: SupabaseClient,
  portfolioId: string
): Promise<boolean> {
  const startIso = getTodayAnchor().utcIso;
  const { data } = await supabase
    .from("activity_log")
    .select("id")
    .eq("event_type", "portfolio_halt")
    .gte("created_at", startIso)
    .filter("details->>portfolio_id", "eq", portfolioId)
    .limit(1)
    .maybeSingle();
  return data != null;
}

/**
 * Halt the entire portfolio: flatten every algorithm's open positions
 * (broker + paper) and disable live trading on each. Logs one
 * activity_log entry per algorithm so the halt is visible from any
 * algorithm's detail page.
 */
export async function executePortfolioHalt(
  supabase: SupabaseClient,
  userId: string,
  portfolio: Portfolio,
  algoIds: string[],
  result: PortfolioHaltResult
): Promise<void> {
  for (const algoId of algoIds) {
    const flattened = await flattenAlgorithmPositions(supabase, algoId, "portfolio_halt");
    await supabase
      .from("algorithms")
      .update({ live_trading_enabled: false })
      .eq("id", algoId);
    await logActivity(supabase, userId, {
      algorithm_id: algoId,
      event_type: "portfolio_halt",
      details: {
        portfolio_id: portfolio.id,
        portfolio_name: portfolio.name,
        todays_pnl_pct: Number(result.todays_pnl_pct.toFixed(3)),
        threshold_pct: Number(result.threshold_pct.toFixed(3)),
        realized: Number(result.realized.toFixed(2)),
        unrealized: Number(result.unrealized.toFixed(2)),
        positions_flattened: flattened.length,
        algos_in_portfolio: algoIds.length,
      },
    });
  }
}
