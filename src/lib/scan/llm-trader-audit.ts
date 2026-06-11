/**
 * LLM-trader decision audit — write helper for the `llm_decisions` table.
 *
 * Foundation for both operator retracing ("what did the LLM see when it
 * bought XAU at $4500?") and Layer 3 in-context reflection ("of your
 * last 10 HH-regime enter_long decisions, X% were profitable" injected
 * at decision time). Migration: 00031_llm_decisions.sql.
 *
 * Insert flow:
 *   1. evaluateLlmTraderEntry receives a decision back from the LLM
 *   2. Calls `recordLlmDecision` with full context, regardless of whether
 *      the entry will succeed (sanity gates / dry-run / spread refusal)
 *   3. If the decision opens a position, the caller updates the row's
 *      paper_position_id via `linkLlmDecisionToPosition`
 *   4. When the position closes, `manage.ts` calls `backfillLlmDecisionOutcome`
 *      to populate the trade_outcome jsonb
 *
 * Failures: writes are best-effort. We never block the scan engine on
 * audit-log insert failures — the decision and trade still proceed; we
 * just lose the audit row for that bar. Inserts log to console.error
 * but don't throw.
 */
import type { LlmTraderEvaluation } from "@/lib/scan/llm-trader";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface RecordDecisionInput {
  algorithmId: string;
  userId: string;
  /** ISO timestamp of the bar being evaluated (UTC). */
  barDate: string;
  /** From evaluateLlmTrader's return — provenance + regime + the user
   *  message that was sent. */
  evaluation: LlmTraderEvaluation;
  /** Position state at decision time. */
  hadPosition: "flat" | "long" | "short";
  /** "live" for production, "backtest" / "walk_forward" if a script
   *  opts in to DB persistence. */
  source: "live" | "backtest" | "walk_forward";
  /** Optional structured context components for queryable lookups
   *  later (e.g. find all decisions where DXY was rising). For now
   *  we just stash the user message — components can be teased out
   *  in a future migration if needed. */
  contextComponents?: Record<string, unknown>;
}

/** Insert a llm_decisions row. Returns the row id on success, null on
 *  failure (which is logged but not thrown — audit writes never block
 *  trading). */
export async function recordLlmDecision(
  supabase: SupabaseClient,
  input: RecordDecisionInput
): Promise<string | null> {
  if (!input.evaluation.decision) {
    // Retry-exhausted call — nothing to record. The scan engine logs
    // this to activity_log already.
    return null;
  }
  const { decision, regime, userMessage, promptVersion, provider, model } = input.evaluation;
  const context = {
    user_message: userMessage,
    ...(input.contextComponents ?? {}),
  };
  const { data, error } = await supabase
    .from("llm_decisions")
    .insert({
      user_id: input.userId,
      algorithm_id: input.algorithmId,
      bar_date: input.barDate,
      prompt_version: promptVersion,
      provider,
      model,
      regime,
      decision: decision.decision,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      context,
      had_position: input.hadPosition,
      paper_position_id: null,
      trade_outcome: null,
      source: input.source,
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[llm-trader-audit] recordLlmDecision failed:", error?.message);
    return null;
  }
  return (data as { id: string }).id;
}

/** Link a previously-recorded decision row to the paper_positions row
 *  it opened. Called by entry.ts after openPosition succeeds for an
 *  enter_long / enter_short decision. */
export async function linkLlmDecisionToPosition(
  supabase: SupabaseClient,
  decisionId: string,
  paperPositionId: string
): Promise<void> {
  const { error } = await supabase
    .from("llm_decisions")
    .update({ paper_position_id: paperPositionId })
    .eq("id", decisionId);
  if (error) {
    console.error("[llm-trader-audit] linkLlmDecisionToPosition failed:", error.message);
  }
}

export interface DecisionOutcome {
  r_multiple: number;
  exit_reason: string;
  realized_pnl: number;
  side: "long" | "short";
  entry_price: number;
  exit_price: number;
  exit_date: string;
}

/** R-multiple — realised P&L expressed as multiples of risk (entry-to-SL
 *  distance). +1.0 means the trade gave back exactly its risk on the
 *  upside; +3.0 = full TP at 1.5%/4.5% RR; -1.0 = SL fill. */
function computeRMultiple(
  side: "long" | "short",
  entryPrice: number,
  stopPrice: number,
  exitPrice: number
): number {
  const risk = side === "long" ? entryPrice - stopPrice : stopPrice - entryPrice;
  if (risk <= 0) return 0;
  const move = side === "long" ? exitPrice - entryPrice : entryPrice - exitPrice;
  return move / risk;
}

interface BackfillPaperRow {
  side: "long" | "short";
  entry_price: number;
  stop_loss_price: number;
  /** Entry-time SL price, snapshotted at insert and never mutated. Used
   *  for R-multiple math so BE-moved trades still produce the correct
   *  multiple on close. Null on legacy rows opened before migration
   *  00032 — fall back to stop_loss_price (which equals the original
   *  for any non-BE-moved trade). */
  initial_stop_loss_price: number | null;
  exit_price: number;
  exit_reason: string;
  realized_pnl: number;
  closed_at: string;
  status: string;
}

interface BackfillRow {
  id: string;
  // Supabase typegen returns the joined relation as an array; we use
  // !inner so there's exactly one row per result, but the type signature
  // still has it as an array.
  paper_positions: BackfillPaperRow | BackfillPaperRow[] | null;
}

/** Backfill the trade_outcome jsonb on llm_decisions rows whose linked
 *  paper_positions have closed but haven't been processed yet.
 *  Idempotent — runs on every manage tick, processes only rows where
 *  trade_outcome IS NULL. */
export async function backfillClosedTradeOutcomes(
  supabase: SupabaseClient
): Promise<{ backfilled: number }> {
  const { data, error } = await supabase
    .from("llm_decisions")
    .select(
      `id, paper_position_id, paper_positions!inner(side, entry_price, stop_loss_price, initial_stop_loss_price, exit_price, exit_reason, realized_pnl, closed_at, status)`
    )
    .is("trade_outcome", null)
    .not("paper_position_id", "is", null)
    .eq("paper_positions.status", "closed");

  if (error) {
    console.error("[llm-trader-audit] backfill query failed:", error.message);
    return { backfilled: 0 };
  }

  const rows = (data ?? []) as unknown as BackfillRow[];
  let backfilled = 0;
  for (const row of rows) {
    if (!row.paper_positions) continue;
    const pp = Array.isArray(row.paper_positions)
      ? row.paper_positions[0]
      : row.paper_positions;
    if (!pp) continue;
    const slForR = pp.initial_stop_loss_price ?? pp.stop_loss_price;
    const outcome: DecisionOutcome = {
      r_multiple: computeRMultiple(pp.side, pp.entry_price, slForR, pp.exit_price),
      exit_reason: pp.exit_reason,
      realized_pnl: pp.realized_pnl,
      side: pp.side,
      entry_price: pp.entry_price,
      exit_price: pp.exit_price,
      exit_date: pp.closed_at,
    };
    const { error: updErr } = await supabase
      .from("llm_decisions")
      .update({ trade_outcome: outcome })
      .eq("id", row.id);
    if (updErr) {
      console.error("[llm-trader-audit] backfill update failed:", updErr.message);
      continue;
    }
    backfilled++;
  }
  return { backfilled };
}
