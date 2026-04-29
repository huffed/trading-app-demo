"use server";

import { timeframeToInterval } from "@/lib/market-data/interval";
import { getCachedPrices } from "@/lib/market-data/price-cache";
import { fetchDailyPrices } from "@/lib/market-data/prices";
import { computeAtr } from "@/lib/market-data/regime-filter";
import { resampleToDaily } from "@/lib/market-data/resample";
import { getAuthedUser } from "@/lib/supabase/get-authed-user";
import { type ActionResult } from "@/lib/types/action-result";
import {
  isPatternCondition,
  type AlgorithmRules,
  type EntryCondition,
} from "@/types/algorithm";

export interface DailyBiasViz {
  kind: "daily_bias";
  ma_period: number;
  bias_at_entry: "bullish" | "bearish" | "neutral";
  /** Daily-bar SMA series spanning the chart's date range. The chart
   *  maps each intraday bar to the nearest preceding daily SMA value
   *  (step plot). */
  ma_series: { date: string; value: number }[];
}

export interface MomentumViz {
  kind: "momentum";
  direction: "bullish" | "bearish";
  /** Lookback start (inclusive) — primary timeframe. */
  start_date: string;
  /** Lookback end (inclusive — typically the entry bar). */
  end_date: string;
  /** Signed cumulative move over the window in ATR units. Positive
   *  = bullish, negative = bearish. */
  signed_size_atr: number;
  /** Lookback the rule used (default 3). */
  lookback: number;
}

export interface UnsupportedViz {
  kind: "unsupported";
  pattern: string;
  reason: string;
}

export type PatternViz = DailyBiasViz | MomentumViz | UnsupportedViz;

/**
 * Recompute a pattern at the position's entry bar with extra detail
 * needed to overlay it on the chart. Returns a discriminated union
 * keyed on the pattern kind. Currently supports daily_bias and
 * momentum; other patterns return `unsupported` for forward
 * compatibility — the UI shows a "render not implemented" message.
 */
export async function getPatternVisualization(
  positionId: string,
  conditionIndex: number
): Promise<ActionResult<PatternViz | null>> {
  try {
    const { supabase, user } = await getAuthedUser();
    const { data: pos, error } = await supabase
      .from("paper_positions")
      .select("id, ticker, algorithm_id, opened_at, closed_at")
      .eq("id", positionId)
      .eq("user_id", user.id)
      .single();
    if (error) return { success: false, error: error.message };

    const { data: algo } = await supabase
      .from("algorithms")
      .select("rules")
      .eq("id", pos.algorithm_id)
      .single();
    if (!algo) return { success: true, data: null };
    const rules = algo.rules as AlgorithmRules;
    const cond = rules.entry_conditions[conditionIndex];
    if (!cond || !isPatternCondition(cond)) {
      return {
        success: true,
        data: {
          kind: "unsupported",
          pattern: cond ? "non-pattern" : "out-of-range",
          reason: "Only pattern conditions are visualizable today.",
        },
      };
    }

    if (cond.pattern === "daily_bias") {
      return { success: true, data: await buildDailyBiasViz(pos, cond, rules) };
    }
    if (cond.pattern === "momentum") {
      return { success: true, data: await buildMomentumViz(pos, cond, rules) };
    }
    return {
      success: true,
      data: {
        kind: "unsupported",
        pattern: cond.pattern,
        reason: "Visualization not yet implemented for this pattern.",
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Pattern viz failed",
    };
  }
}

interface PositionRef {
  ticker: string;
  opened_at: string;
  closed_at: string | null;
}

async function buildDailyBiasViz(
  pos: PositionRef,
  cond: EntryCondition,
  rules: AlgorithmRules
): Promise<PatternViz> {
  const period = "ma_period" in cond && typeof cond.ma_period === "number" ? cond.ma_period : 20;
  // Pull daily bars; if our cache doesn't have them, fetch.
  let dailyBars = await getCachedPrices(pos.ticker, "full", "1day");
  if (!dailyBars || dailyBars.length === 0) {
    try {
      dailyBars = await fetchDailyPrices(pos.ticker, "full", "1day");
    } catch {
      dailyBars = [];
    }
  }
  if (dailyBars.length === 0) {
    // Fall back to resampling the primary series — works for shorter
    // history but may miss true daily anchors.
    const interval = timeframeToInterval(rules.timeframe);
    const primary = await getCachedPrices(pos.ticker, "full", interval);
    if (primary && primary.length > 0) dailyBars = resampleToDaily(primary);
  }
  if (dailyBars.length < period) {
    return {
      kind: "unsupported",
      pattern: "daily_bias",
      reason: `Not enough daily bars cached (need ${period}, have ${dailyBars.length}).`,
    };
  }

  const ma_series: { date: string; value: number }[] = [];
  for (let i = period - 1; i < dailyBars.length; i++) {
    const window = dailyBars.slice(i - period + 1, i + 1);
    const sum = window.reduce((s, b) => s + b.close, 0);
    ma_series.push({ date: dailyBars[i].date, value: sum / period });
  }

  // Bias at entry: find the daily bar at or before opened_at; compare
  // its close vs the MA at that index.
  const openMs = new Date(pos.opened_at).getTime();
  let entryDailyIdx = -1;
  for (let i = 0; i < dailyBars.length; i++) {
    if (new Date(dailyBars[i].date).getTime() <= openMs) entryDailyIdx = i;
    else break;
  }
  let bias: DailyBiasViz["bias_at_entry"] = "neutral";
  if (entryDailyIdx >= period - 1) {
    const close = dailyBars[entryDailyIdx].close;
    const slice = dailyBars.slice(entryDailyIdx - period + 1, entryDailyIdx + 1);
    const ma = slice.reduce((s, b) => s + b.close, 0) / period;
    if (close > ma) bias = "bullish";
    else if (close < ma) bias = "bearish";
  }

  return { kind: "daily_bias", ma_period: period, bias_at_entry: bias, ma_series };
}

async function buildMomentumViz(
  pos: PositionRef,
  cond: EntryCondition,
  rules: AlgorithmRules
): Promise<PatternViz> {
  const lookback = "lookback" in cond && typeof cond.lookback === "number" ? cond.lookback : 3;
  const interval = timeframeToInterval(rules.timeframe);
  const bars = await getCachedPrices(pos.ticker, "full", interval);
  if (!bars || bars.length === 0) {
    return {
      kind: "unsupported",
      pattern: "momentum",
      reason: "No cached primary-timeframe bars to compute momentum window.",
    };
  }

  const openMs = new Date(pos.opened_at).getTime();
  let entryIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (new Date(bars[i].date).getTime() <= openMs) entryIdx = i;
    else break;
  }
  if (entryIdx < lookback - 1) {
    return {
      kind: "unsupported",
      pattern: "momentum",
      reason: "Not enough bars before entry to compute the lookback.",
    };
  }
  const startIdx = entryIdx - lookback + 1;
  const window = bars.slice(startIdx, entryIdx + 1);
  const netMove = window.reduce((s, b) => s + (b.close - b.open), 0);

  // ATR for ATR-unit normalization; matches what the detector does.
  const atrSeries = computeAtr(bars.slice(0, entryIdx + 1), 14);
  const atr = atrSeries[entryIdx];
  const sizeAtr = atr && atr > 0 ? netMove / atr : 0;

  return {
    kind: "momentum",
    direction: sizeAtr >= 0 ? "bullish" : "bearish",
    start_date: bars[startIdx].date,
    end_date: bars[entryIdx].date,
    signed_size_atr: Number(sizeAtr.toFixed(4)),
    lookback,
  };
}
