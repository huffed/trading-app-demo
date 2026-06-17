"use server";

import { getInstrumentMeta } from "@/lib/constants/markets";
import { getAuthedUser } from "@/lib/supabase/get-authed-user";
import { type ActionResult } from "@/lib/types/action-result";
import type { PaperPosition } from "@/types/position";

export interface BacktestTradeRow extends PaperPosition {
  /** Distance from entry to SL in pips, signed: long with SL below
   *  entry → positive (loss distance); short with SL above entry →
   *  positive. Null when no SL recorded. */
  sl_pips: number | null;
  tp_pips: number | null;
  /** Effective R per realized pnl, where R = entry → initial-SL
   *  distance × notional. Null when initial SL missing or trade open. */
  r_multiple: number | null;
}

function pipsBetween(ticker: string, fromPrice: number, toPrice: number): number {
  const meta = getInstrumentMeta(ticker);
  const pipSize = meta?.pipSize ?? 0.0001;
  return Math.abs(toPrice - fromPrice) / pipSize;
}

function computeRMultiple(p: PaperPosition): number | null {
  if (p.realized_pnl == null) return null;
  const initialSl = p.initial_stop_loss_price ?? p.stop_loss_price;
  if (initialSl == null) return null;
  const slDistance = Math.abs(p.entry_price - initialSl);
  if (slDistance === 0) return null;
  const rValue = slDistance * p.quantity;
  if (rValue === 0) return null;
  return p.realized_pnl / rValue;
}

export async function getAlgorithmTradesAction(
  algorithmId: string
): Promise<ActionResult<BacktestTradeRow[]>> {
  if (!algorithmId) return { success: false, error: "missing algorithm id" };
  try {
    const { supabase, user } = await getAuthedUser();
    const { data, error } = await supabase
      .from("paper_positions")
      .select("*")
      .eq("user_id", user.id)
      .eq("algorithm_id", algorithmId)
      .order("opened_at", { ascending: false })
      .limit(500);
    if (error) return { success: false, error: error.message };
    const rows: BacktestTradeRow[] = (data ?? []).map((p) => {
      const pos = p as PaperPosition;
      const sl = pos.stop_loss_price;
      const tp = pos.take_profit_price;
      return {
        ...pos,
        sl_pips: sl != null ? pipsBetween(pos.ticker, pos.entry_price, sl) : null,
        tp_pips: tp != null ? pipsBetween(pos.ticker, pos.entry_price, tp) : null,
        r_multiple: computeRMultiple(pos),
      };
    });
    return { success: true, data: rows };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Trade load failed" };
  }
}
