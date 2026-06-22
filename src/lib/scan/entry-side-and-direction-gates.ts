/**
 * Side resolution + post-side directional gates (steps 7-11 of the
 * deterministic entry ladder). Extracted from
 * `entry-deterministic-gates.ts` on 2026-06-22 (CB.H1 pass 18b) so the
 * pre-side and post-side phases sit in their own files.
 *
 * Gates run in order:
 *  7. Side resolution (auto-side reads D1 bias)
 *  8. Direction conflict (sibling algo holding opposite side)
 *  9. DXY directional filter (opt-in per algo)
 * 10. Regime gate (ATR percentile on D1)
 * 11. ADX trend-strength gate
 */
import { checkDxyDirection } from "@/lib/algorithm/dxy-filter";
import { isWeakTrendByAdx } from "@/lib/market-data/adx-filter";
import { resolveSide } from "@/lib/market-data/auto-side";
import { isRangingByAtr } from "@/lib/market-data/regime-filter";
import { resampleToDaily } from "@/lib/market-data/resample";
import type { PriceBar } from "@/lib/market-data/types";
import type { AlgorithmRules } from "@/types/algorithm";
import { checkDirectionConflict } from "./entry-gates";
import { logActivity } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

export type SideAndDirectionResult =
  | { blocked: true }
  | {
      blocked: false;
      side: "long" | "short";
      directionOverride?: "bullish" | "bearish";
      higherTfBars: PriceBar[];
    };

interface GateInputs {
  supabase: SupabaseClient;
  userId: string;
  algoId: string;
  ticker: string;
  rules: AlgorithmRules;
  bars: PriceBar[];
  dailyBars: PriceBar[] | null | undefined;
  dxyBars: PriceBar[] | null | undefined;
}

export async function runSideAndDirectionGates(
  args: GateInputs
): Promise<SideAndDirectionResult> {
  const { supabase, userId, algoId, ticker, rules, bars, dailyBars, dxyBars } = args;
  const higherTfBars = dailyBars ?? resampleToDaily(bars);
  const resolved = resolveSide(rules.side ?? "long", higherTfBars);
  if (resolved === null) {
    const reason =
      higherTfBars.length < 20
        ? `Auto-side: insufficient D1 history (${higherTfBars.length} bars, need 20)`
        : "Auto-side: D1 bias is neutral";
    await logActivity(supabase, userId, {
      algorithm_id: algoId,
      event_type: "signal_no_action",
      ticker,
      details: { reason },
    });
    return { blocked: true };
  }
  const conflict = await checkDirectionConflict(supabase, userId, algoId, ticker, resolved.side);
  if (conflict.block) {
    await logActivity(supabase, userId, {
      algorithm_id: algoId,
      event_type: "signal_no_action",
      ticker,
      details: {
        reason: conflict.reason,
        proposed_side: resolved.side,
        conflicting_algorithm_ids: conflict.conflicting_algorithm_ids,
      },
    });
    return { blocked: true };
  }
  const postSideBlocked = await runPostSideDirectionalFilters({
    supabase,
    userId,
    algoId,
    ticker,
    rules,
    bars,
    dxyBars,
    higherTfBars,
    side: resolved.side,
  });
  if (postSideBlocked) return { blocked: true };
  return {
    blocked: false,
    side: resolved.side,
    directionOverride: resolved.directionOverride,
    higherTfBars,
  };
}

interface PostSideArgs {
  supabase: SupabaseClient;
  userId: string;
  algoId: string;
  ticker: string;
  rules: AlgorithmRules;
  bars: PriceBar[];
  dxyBars: PriceBar[] | null | undefined;
  higherTfBars: PriceBar[];
  side: "long" | "short";
}

/** Steps 9-11 (DXY / regime / ADX) after side is resolved + conflict
 *  cleared. Returns true when ANY of the 3 gates blocked. */
async function runPostSideDirectionalFilters(a: PostSideArgs): Promise<boolean> {
  if (a.rules.dxy_filter?.enabled && a.dxyBars && a.dxyBars.length > 0) {
    const dxy = checkDxyDirection({
      side: a.side,
      currentTimestamp: a.bars[a.bars.length - 1].date,
      proxyBars: a.dxyBars,
      config: a.rules.dxy_filter,
    });
    if (dxy.block) {
      await logActivity(a.supabase, a.userId, {
        algorithm_id: a.algoId,
        event_type: "signal_no_action",
        ticker: a.ticker,
        details: {
          reason: dxy.reason ?? "DXY filter blocked",
          proposed_side: a.side,
          dxy_status: dxy.status,
          dxy_delta_pips: dxy.delta_pips,
          dxy_threshold_pips: dxy.threshold_pips,
          dxy_lookback_hours: dxy.lookback_hours,
        },
      });
      return true;
    }
  }
  if (a.rules.regime_filter?.enabled) {
    const regime = isRangingByAtr(a.higherTfBars, a.higherTfBars.length - 1, a.rules.regime_filter);
    if (regime.skip) {
      await logActivity(a.supabase, a.userId, {
        algorithm_id: a.algoId,
        event_type: "signal_no_action",
        ticker: a.ticker,
        details: { reason: `Regime filter: ${regime.reason}` },
      });
      return true;
    }
  }
  if (a.rules.adx_filter?.enabled) {
    const adx = isWeakTrendByAdx(a.higherTfBars, a.higherTfBars.length - 1, a.rules.adx_filter);
    if (adx.skip) {
      await logActivity(a.supabase, a.userId, {
        algorithm_id: a.algoId,
        event_type: "signal_no_action",
        ticker: a.ticker,
        details: { reason: `ADX filter: ${adx.reason}` },
      });
      return true;
    }
  }
  return false;
}
