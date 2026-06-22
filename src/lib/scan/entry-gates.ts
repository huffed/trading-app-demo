/**
 * Entry-side gates that check external state (sibling positions, economic
 * calendar, live market regime). Extracted from entry.ts in CB.C1 (2026-06-20).
 *
 * What's here:
 *  - `checkDirectionConflict` — refuse if a sibling algo holds an opposing
 *    position on the same ticker (2026-04-30 incident)
 *  - `checkNewsVeto` — refuse near tier-1 economic events
 *  - `computeLiveMarketState` — fetch 1h bars + compute the 4h-frame
 *    market-state read shared by deterministic + LLM entry paths
 *
 * Each gate is a small async function with no shared state — caller threads
 * the supabase client + rules through. Imported by:
 *  - entry.ts → all three
 *  - entry-llm-trader.ts → computeLiveMarketState
 */
import {
  fetchEconomicCalendar,
  getEventCurrencies,
  isWithinVetoWindow,
} from "@/lib/market-data/economic-calendar";
import { computeMarketState4h, type MarketState } from "@/lib/market-data/market-state";
import { getCachedPrices, savePricesToCache } from "@/lib/market-data/price-cache";
import { fetchDailyPrices } from "@/lib/market-data/prices";
import { resampleTo } from "@/lib/market-data/resample";
import type { PriceBar } from "@/lib/market-data/types";
import type { AlgorithmRules } from "@/types/algorithm";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Refuse a new entry when any sibling algorithm (same user, different
 *  algorithm_id) already holds an OPEN position on the same ticker in
 *  the OPPOSITE direction. Two algos opening opposing positions on one
 *  instrument cancel out economically — the operator pays the spread
 *  twice while net exposure is zero. Diagnosed from 2026-04-30 live
 *  gold trades where Algo B opened SHORT XAU/USD and Algo D opened
 *  LONG XAU/USD 11 seconds apart. */
export async function checkDirectionConflict(
  supabase: SupabaseClient,
  userId: string,
  algoId: string,
  ticker: string,
  proposedSide: "long" | "short"
): Promise<
  | { block: false }
  | { block: true; reason: string; conflicting_algorithm_ids: string[] }
> {
  const opposite: "long" | "short" = proposedSide === "long" ? "short" : "long";
  const { data, error } = await supabase
    .from("paper_positions")
    .select("algorithm_id")
    .eq("user_id", userId)
    .eq("ticker", ticker)
    .eq("status", "open")
    .eq("side", opposite)
    .neq("algorithm_id", algoId);
  if (error || !data || data.length === 0) return { block: false };
  const ids = Array.from(new Set(data.map((p) => p.algorithm_id as string)));
  return {
    block: true,
    reason: `Direction conflict: ${ids.length} sibling algo(s) hold opposing ${opposite} on ${ticker}`,
    conflicting_algorithm_ids: ids,
  };
}

export async function checkNewsVeto(
  rules: AlgorithmRules,
  ticker: string
): Promise<{ vetoed: boolean; reason?: string }> {
  const v = rules.news_veto;
  if (!v?.enabled) return { vetoed: false };
  const currencies = getEventCurrencies(ticker);
  if (currencies.length === 0) return { vetoed: false };

  const now = new Date();
  const windowMs = Math.max(v.block_minutes_before, v.block_minutes_after) * 60 * 1000;
  const events = await fetchEconomicCalendar(
    new Date(now.getTime() - windowMs),
    new Date(now.getTime() + windowMs)
  );
  const hit = isWithinVetoWindow(
    now,
    events,
    currencies,
    v.block_minutes_before,
    v.block_minutes_after,
    v.min_impact
  );
  if (!hit) return { vetoed: false };
  return { vetoed: true, reason: `${hit.currency} ${hit.event} (${hit.impact} impact)` };
}

/** Live market-state read shared by the LLM and deterministic entry
 *  paths — feeds the market_state_gate and the decision-audit/cohort
 *  shadow logging. 4h-frame only (the study's frame — lower TFs come
 *  with the S4 re-entry); never throws: null means "unreadable", which
 *  gated specialists fail closed on. One compact-1h fetch per call. */
export async function computeLiveMarketState(
  ticker: string,
  timeframe: string,
  bars: PriceBar[],
  dailyBars?: PriceBar[] | null,
  dxyBars?: PriceBar[] | null
): Promise<MarketState | null> {
  if (timeframe !== "4h") return null;
  try {
    let oneHourBars = await getCachedPrices(ticker, "compact", "1h");
    if (!oneHourBars || oneHourBars.length < 30) {
      oneHourBars = await fetchDailyPrices(ticker, "compact", "1h");
      savePricesToCache(ticker, "compact", oneHourBars, "1h").catch(() => {});
    }
    return computeMarketState4h(
      {
        bars4h: bars,
        oneHourBars: oneHourBars ?? [],
        dailyBars: dailyBars ?? [],
        // dxyBars arrive as EUR/USD 1h from the scan engine; the state
        // math is defined on the 4h frame (study parity).
        eurusd4h: dxyBars && dxyBars.length > 0 ? resampleTo(dxyBars, "4h") : [],
      },
      bars.length - 1
    );
  } catch {
    return null;
  }
}
