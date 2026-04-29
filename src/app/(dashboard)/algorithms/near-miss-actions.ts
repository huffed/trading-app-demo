"use server";

import { getAuthedUser } from "@/lib/supabase/get-authed-user";
import { type ActionResult } from "@/lib/types/action-result";

export type NearMissCategory =
  | "conditions_close_call"
  | "conditions_far"
  | "atr_close_call"
  | "atr_far"
  | "news_veto"
  | "halt"
  | "spread"
  | "other";

export interface NearMiss {
  id: string;
  ticker: string | null;
  created_at: string;
  category: NearMissCategory;
  /** Top-line summary, ready to display. */
  headline: string;
  /** Optional per-category detail (e.g. "3 of 5 fired"). */
  detail: string | null;
  /** 0..1 — how close was this to firing? 1 = would-have-fired,
   *  0 = nowhere near. Used for sorting "close calls" to the top. */
  closeness: number;
}

interface RawDetails {
  reason?: string;
  conditions_met?: number;
  conditions_total?: number;
  atr_current?: number;
  atr_threshold?: number;
  observed_spread_pips?: number;
}

interface RawRow {
  id: string;
  ticker: string | null;
  created_at: string;
  details: RawDetails | null;
}

interface CategorizationResult {
  category: NearMissCategory;
  headline: string;
  detail: string | null;
  closeness: number;
}

function classifyDetails(d: RawDetails, fallbackReason: string): CategorizationResult {
  if (typeof d.conditions_met === "number" && typeof d.conditions_total === "number") {
    const ratio = d.conditions_total > 0 ? d.conditions_met / d.conditions_total : 0;
    return {
      category: ratio >= 0.6 ? "conditions_close_call" : "conditions_far",
      headline: `Entry conditions ${d.conditions_met}/${d.conditions_total}`,
      detail: ratio >= 0.6 ? "close call" : null,
      closeness: ratio,
    };
  }
  if (typeof d.atr_current === "number" && typeof d.atr_threshold === "number") {
    const ratio = d.atr_threshold > 0 ? d.atr_current / d.atr_threshold : 0;
    const pct = (ratio * 100).toFixed(0);
    return {
      category: ratio >= 0.9 ? "atr_close_call" : "atr_far",
      headline: `ATR liquidity gate (${pct}% of threshold)`,
      detail:
        ratio >= 0.9
          ? "close call — tape was almost active enough"
          : "tape too quiet; gate adapts as volatility returns",
      closeness: Math.min(ratio, 1),
    };
  }
  const reason = d.reason ?? fallbackReason;
  if (reason.startsWith("News veto")) {
    return {
      category: "news_veto",
      headline: reason,
      detail: "blocked by economic calendar",
      closeness: 0,
    };
  }
  if (
    reason.startsWith("Consecutive-loss halt") ||
    reason.includes("daily-loss") ||
    reason.includes("Consistency")
  ) {
    return {
      category: "halt",
      headline: reason,
      detail: "algo paused — would not have entered regardless of signal",
      closeness: 0,
    };
  }
  if (reason.startsWith("Spread") || typeof d.observed_spread_pips === "number") {
    return {
      category: "spread",
      headline: reason,
      detail:
        typeof d.observed_spread_pips === "number"
          ? `observed ${d.observed_spread_pips.toFixed(1)} pips`
          : null,
      closeness: 0.5,
    };
  }
  return { category: "other", headline: reason, detail: null, closeness: 0 };
}

function categorize(row: RawRow): NearMiss {
  const result = classifyDetails(row.details ?? {}, "Entry filtered");
  return {
    id: row.id,
    ticker: row.ticker,
    created_at: row.created_at,
    ...result,
  };
}

export interface NearMissFeed {
  hours: number;
  total: number;
  near_misses: NearMiss[];
  /** Per-ticker counts so the UI can render summary chips. */
  by_ticker: Array<{ ticker: string; count: number; close_calls: number }>;
}

/**
 * Fetch and categorize signal_no_action events for an algorithm over
 * the last `hours` (default 48). Each event becomes a NearMiss with a
 * computed `closeness` score so the UI can sort/highlight the most
 * "almost-fired" attempts.
 */
export async function getNearMissFeed(
  algorithmId: string,
  hours = 48
): Promise<ActionResult<NearMissFeed>> {
  try {
    const { supabase, user } = await getAuthedUser();
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("activity_log")
      .select("id, ticker, created_at, details")
      .eq("user_id", user.id)
      .eq("algorithm_id", algorithmId)
      .eq("event_type", "signal_no_action")
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false });
    if (error) return { success: false, error: error.message };

    const rows = (data ?? []) as RawRow[];
    const near = rows.map(categorize);

    const tickerStats = new Map<string, { count: number; close_calls: number }>();
    for (const m of near) {
      if (!m.ticker) continue;
      const slot = tickerStats.get(m.ticker) ?? { count: 0, close_calls: 0 };
      slot.count++;
      if (m.closeness >= 0.6) slot.close_calls++;
      tickerStats.set(m.ticker, slot);
    }
    const by_ticker = Array.from(tickerStats.entries())
      .map(([ticker, s]) => ({ ticker, count: s.count, close_calls: s.close_calls }))
      .sort((a, b) => b.close_calls - a.close_calls || b.count - a.count);

    return {
      success: true,
      data: {
        hours,
        total: near.length,
        near_misses: near,
        by_ticker,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Near-miss fetch failed",
    };
  }
}
