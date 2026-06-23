/**
 * G.3-followup — Build the live VolTargetLiveContext required by the
 * scan-path vol_target sizing branch. Pre-fetches:
 *   - ATR(14) / currentPrice → instrumentVolPct
 *   - Recent N R-multiples for the algo from paper_positions
 *     (closed only; chronological DESC; bounded N to match the
 *     backtest's R_MULTIPLE_HISTORY_CAP)
 *
 * Pure-ish: one DB read + one ATR compute. Returns the context the
 * existing `computeVolTargetNotional` math consumes.
 *
 * Live wire-up matches the backtest sweep semantic from
 * `src/lib/algorithm/vol-target-sizing.ts` — same warmup fallback
 * behavior, same R = pnl / oneR formula (using initial_stop_loss_price
 * with stop_loss_price fallback), same fail-safe (insufficient data →
 * null history → warmup fallback in the math).
 */
import { atr14 } from "@/lib/market-data/market-state";
import type { PriceBar } from "@/lib/market-data/types";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface VolTargetLiveContext {
  /** ATR(14) / currentPrice. 0 when ATR can't be computed (insufficient
   *  bars) — `computeVolTargetNotional` treats 0 as "no vol info" and
   *  falls through to its min_vol_floor. */
  instrumentVolPct: number;
  /** Recent R-multiples for the algo (most-recent last). Empty array
   *  when no closed positions or all positions have broken state.
   *  `rollingPerTradeRStd` returns null on length < 2 → warmup fallback. */
  rMultipleHistory: number[];
}

/** Cap matches the backtest's `R_MULTIPLE_HISTORY_CAP` in
 *  `prop-firm-backtest.ts`. Bounds DB read size + matches the default
 *  rolling window (20) × 10 for headroom on rule overrides. */
export const LIVE_R_MULTIPLE_HISTORY_CAP = 200;

interface PositionRow {
  side: string;
  entry_price: number;
  exit_price: number | null;
  initial_stop_loss_price: number | null;
  stop_loss_price: number | null;
  realized_pnl: number | null;
  closed_at: string | null;
}

/** Compute R-multiple from entry / stop / exit / pnl. Inlined here for
 *  the same "no cross-import surface" convention as alpha-decay.ts +
 *  live-mirror-eligibility.ts. Uses initial_stop_loss_price when set,
 *  falls back to stop_loss_price for pre-migration-00032 legacy rows. */
function rMultipleOf(p: PositionRow): number | null {
  if (p.side !== "long" && p.side !== "short") return null;
  if (p.realized_pnl == null || !Number.isFinite(p.realized_pnl)) return null;
  const stop = p.initial_stop_loss_price ?? p.stop_loss_price;
  if (stop == null) return null;
  const risk = p.side === "long" ? p.entry_price - stop : stop - p.entry_price;
  if (risk <= 0) return null;
  // Reconstruct R = pnl / (risk × qty). But pnl already accounts for qty
  // (it's realized cash, not price delta). For consistency with the
  // backtest's `pnl / oneR` formula where `oneR = notional × (slDistance
  // / entryPrice)`, we approximate: pnl/oneR == pnl-pct / risk-pct.
  // pnl_pct = realized_pnl / notional; risk_pct = risk / entry. So
  // R = (realized_pnl / notional) / (risk / entry).
  // We don't have notional on the row directly; the cleanest equivalent
  // uses the price-delta form: R = (exit - entry) signed / risk, which
  // assumes realized_pnl = (exit - entry) × qty (paper positions; live
  // includes commission/swap that broker_realized_synced_at handles
  // separately). Use the price-delta form for stability.
  if (p.exit_price == null) return null;
  const move = p.side === "long" ? p.exit_price - p.entry_price : p.entry_price - p.exit_price;
  return move / risk;
}

/** Build the live vol-target context for an algo. Fetches recent
 *  closed positions for the algo, computes per-trade R-multiples,
 *  combines with the bar-derived ATR ratio. */
export async function buildVolTargetLiveContext(
  supabase: SupabaseClient,
  algorithmId: string,
  bars: PriceBar[],
  currentPrice: number,
): Promise<VolTargetLiveContext> {
  // ATR(14) at the latest bar. Returns null when bars.length < 15 → fall
  // through to instrumentVolPct=0.
  const atr = atr14(bars, bars.length - 1);
  const instrumentVolPct = atr != null && currentPrice > 0 ? atr / currentPrice : 0;

  const { data, error } = await supabase
    .from("paper_positions")
    .select("side, entry_price, exit_price, initial_stop_loss_price, stop_loss_price, realized_pnl, closed_at")
    .eq("algorithm_id", algorithmId)
    .eq("status", "closed")
    .order("closed_at", { ascending: false })
    .limit(LIVE_R_MULTIPLE_HISTORY_CAP);
  if (error) {
    // Fail-safe: empty history → warmup fallback in the math. We log
    // so the operator can see why if a vol_target algo seems to
    // behave like warmup-fallback every time.
    console.error(`[vol-target-live-context] paper_positions query failed for ${algorithmId}:`, error.message);
    return { instrumentVolPct, rMultipleHistory: [] };
  }
  const rows = (data ?? []) as PositionRow[];
  // DB returns DESC; rollingPerTradeRStd expects chronological order
  // (its slice takes the TAIL). Reverse to chronological ASC.
  const reversed = rows.slice().reverse();
  const rMultipleHistory: number[] = [];
  for (const row of reversed) {
    const r = rMultipleOf(row);
    if (r != null && Number.isFinite(r)) rMultipleHistory.push(r);
  }
  return { instrumentVolPct, rMultipleHistory };
}
