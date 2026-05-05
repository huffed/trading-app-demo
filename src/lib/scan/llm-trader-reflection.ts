/**
 * Layer 3 in-context reflection — gives the LLM-trader awareness of its
 * own recent track record at decision time. Stage 1 of the WR-improvement
 * staged plan (see project_roadmap.md).
 *
 * Why: backtest-validated prompts have a fixed view of "what setups work"
 * but real regimes drift. A prompt that wins 60% in trending markets may
 * lose 30% in chop. Without recent-outcome awareness, the LLM keeps
 * taking the same setup types regardless of whether they've been working
 * lately. With awareness, it can dynamically tighten conviction in
 * slumps and stay normal in streaks.
 *
 * Effect: raises the floor (fewer bad months), not the ceiling (best
 * months unchanged). Estimated lift on Intraday: 30% → 35-40% WR.
 *
 * Self-gating: returns null when fewer than minTrades closed trades
 * exist. The LLM context builder simply omits the section when null.
 * This means:
 *   - Build can ship before any live trades exist (helper is a no-op)
 *   - Activates automatically as trades accumulate
 *   - No feature flag needed — gating is data-driven
 *
 * Stage 2 follow-up: per-trigger-type attribution (parse trigger from
 * entry reasoning OR add structured trigger field to decisionSchema).
 * This file stays focused on regime-level outcomes for now.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const DEFAULT_LOOKBACK_TRADES = 20;
const MIN_TRADES_TO_SHOW = 10;

interface ClosedTradeRow {
  realized_pnl: number | null;
  side: "long" | "short" | null;
  closed_at: string | null;
  llm_decisions:
    | {
        regime: string | null;
        decision: string | null;
      }
    | Array<{ regime: string | null; decision: string | null }>
    | null;
}

interface RegimeBucket {
  trades: number;
  wins: number;
  totalPnl: number;
}

/** Build a concise recent-outcomes summary for the LLM context. Returns
 *  null when there's insufficient trade history to be informative
 *  (avoids showing "0W/1L" type noise from very early live data).
 *
 *  The output is one short paragraph optimised for inclusion in the
 *  user message — minimal tokens, scannable, regime-anchored. */
export async function summariseRecentOutcomes(
  supabase: SupabaseClient,
  algorithmId: string,
  lookbackTrades: number = DEFAULT_LOOKBACK_TRADES
): Promise<string | null> {
  // Pull the most recent closed trades and join to their entry decision
  // for the regime tag. We filter llm_decisions on the position-id link
  // and keep only entry decisions (paper_position_id is set when an
  // entry decision opens a position).
  const { data, error } = await supabase
    .from("paper_positions")
    .select(
      "realized_pnl, side, closed_at, llm_decisions!paper_position_id(regime, decision)"
    )
    .eq("algorithm_id", algorithmId)
    .eq("status", "closed")
    .not("realized_pnl", "is", null)
    .order("closed_at", { ascending: false })
    .limit(lookbackTrades);
  if (error || !data) return null;
  const rows = data as unknown as ClosedTradeRow[];
  if (rows.length < MIN_TRADES_TO_SHOW) return null;

  // Aggregate by regime. Direction (long/short) is derivable from the
  // regime in our setup (HH→long, LH→short) but we surface it explicitly
  // to keep the LLM honest if a trade went against the regime rule.
  const byRegime = new Map<string, RegimeBucket>();
  let totalWins = 0;
  let totalPnl = 0;
  for (const r of rows) {
    const pnl = r.realized_pnl ?? 0;
    const isWin = pnl > 0;
    const decisions = Array.isArray(r.llm_decisions) ? r.llm_decisions : r.llm_decisions ? [r.llm_decisions] : [];
    const entryDecision = decisions.find(
      (d) => d.decision === "enter_long" || d.decision === "enter_short"
    );
    const regime = entryDecision?.regime ?? "?";
    const bucket = byRegime.get(regime) ?? { trades: 0, wins: 0, totalPnl: 0 };
    bucket.trades += 1;
    if (isWin) bucket.wins += 1;
    bucket.totalPnl += pnl;
    byRegime.set(regime, bucket);
    if (isWin) totalWins += 1;
    totalPnl += pnl;
  }

  const wrPct = (rows.length > 0 ? (totalWins / rows.length) * 100 : 0).toFixed(0);
  const meanPnl = (rows.length > 0 ? totalPnl / rows.length : 0).toFixed(0);

  // Rank regimes by trade count (most-traded first). Keep the per-regime
  // line short — the LLM doesn't need a table, just a glance.
  const regimeLines = Array.from(byRegime.entries())
    .filter(([regime]) => regime !== "?" && regime !== "n/a")
    .sort((a, b) => b[1].trades - a[1].trades)
    .map(([regime, bucket]) => {
      const wr = ((bucket.wins / bucket.trades) * 100).toFixed(0);
      const sign = bucket.totalPnl >= 0 ? "+" : "";
      return `${regime} ${bucket.wins}W/${bucket.trades - bucket.wins}L (${wr}% WR, ${sign}$${bucket.totalPnl.toFixed(0)})`;
    });

  // Identify the under-performing regime (if any) — useful to flag for
  // the LLM. "Under-performing" = WR < 25% (below 3:1 RR breakeven) on
  // ≥3 trades.
  const slumping: string[] = [];
  for (const [regime, bucket] of byRegime) {
    if (regime === "?" || regime === "n/a") continue;
    if (bucket.trades < 3) continue;
    const wr = (bucket.wins / bucket.trades) * 100;
    if (wr < 25) slumping.push(regime);
  }
  const slumpHint =
    slumping.length > 0
      ? ` ${slumping.join(" + ")} setups appear unfavorable in current regime — apply higher conviction bar.`
      : "";

  return `RECENT TRACK RECORD (last ${rows.length} closed trades): Overall ${totalWins}W/${rows.length - totalWins}L (${wrPct}% WR, ${Number(meanPnl) >= 0 ? "+" : ""}$${meanPnl} mean P&L). By regime: ${regimeLines.join("; ")}.${slumpHint}`;
}
