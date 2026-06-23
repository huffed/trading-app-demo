/**
 * H.1 — OANDA positioning contrarian gate (live-only evaluator).
 *
 * Reads the most-recent snapshot from `oanda_positioning_cache` for the
 * configured instrument and decides whether the retail crowd is
 * "heavily one-sided AGAINST" the algo's intended direction (the
 * canonical contrarian read — fade the crowd).
 *
 * Semantic:
 *   side === "long"  → fires when long_pct ≤ (100 − crowd_threshold_pct).
 *                      retail is heavily short → contrarian long signal.
 *   side === "short" → fires when long_pct ≥ crowd_threshold_pct.
 *                      retail is heavily long → contrarian short signal.
 *
 * Fail-safe semantics — anything that prevents a clean check returns
 * false (gate closed; algo doesn't enter):
 *   - no snapshot for instrument
 *   - snapshot older than max_snapshot_age_minutes (default 30)
 *   - long_pct / short_pct fields missing or invalid
 *
 * Live-only: backtest cannot replay historical positioning data
 * (migration 00034: OANDA positionBook API exposes only current state;
 * the cache builds history forward from cron-start). The portfolio-backtest
 * filter `(c) => isTechnicalCondition(c) || isPatternCondition(c)` excludes
 * PositioningCondition automatically — same mechanism that excludes
 * sentiment conditions in backtest. Empirical Sharpe-improvement gate
 * (ROADMAP H.1 ≥5%) is deferred to H.1-validation when ≥30 live trades
 * coincide with positioning snapshots (currently 12.97 days of cached
 * data; need 1-3 months minimum for meaningful Sharpe delta).
 */
import type { PositioningCondition } from "@/types/algorithm";
import type { SupabaseClient } from "@supabase/supabase-js";

export const DEFAULT_MAX_SNAPSHOT_AGE_MINUTES = 30;

export interface PositioningSnapshot {
  /** OANDA instrument identifier (e.g. "XAU_USD"). */
  instrument: string;
  /** Timestamp reported by OANDA at snapshot time. */
  oanda_time: string;
  /** Spot price at the snapshot. */
  price: number;
  /** Sum of longCountPercent across buckets (0..100). */
  long_pct: number;
  /** Sum of shortCountPercent across buckets (0..100). long + short ≈ 100. */
  short_pct: number;
}

export interface PositioningGateResult {
  /** True iff the gate ALLOWS the entry (contrarian condition met). */
  passes: boolean;
  /** Human-readable reason. Always populated for audit-log clarity. */
  reason: string;
  /** Snapshot inspected, if one was found. Null when the gate failed
   *  due to no snapshot OR a stale snapshot. */
  snapshot: PositioningSnapshot | null;
  /** Age of the snapshot in minutes at evaluation time. Null when no
   *  snapshot. */
  snapshot_age_minutes: number | null;
}

/** Pure function — given a snapshot + condition + evaluation time,
 *  decides if the contrarian gate passes. No I/O. */
export function evaluatePositioningContrarian(
  condition: PositioningCondition,
  snapshot: PositioningSnapshot | null,
  now: Date = new Date(),
): PositioningGateResult {
  if (!snapshot) {
    return {
      passes: false,
      reason: `No positioning snapshot for ${condition.instrument} — gate fails fail-safe`,
      snapshot: null,
      snapshot_age_minutes: null,
    };
  }
  const ageMs = now.getTime() - new Date(snapshot.oanda_time).getTime();
  const ageMin = ageMs / 60_000;
  const maxAge = condition.max_snapshot_age_minutes ?? DEFAULT_MAX_SNAPSHOT_AGE_MINUTES;
  if (ageMin > maxAge) {
    return {
      passes: false,
      reason: `Snapshot stale (${ageMin.toFixed(1)} min > max ${maxAge} min) — gate fails fail-safe`,
      snapshot,
      snapshot_age_minutes: ageMin,
    };
  }
  const longPct = snapshot.long_pct;
  if (typeof longPct !== "number" || !Number.isFinite(longPct) || longPct < 0 || longPct > 100) {
    return {
      passes: false,
      reason: `Snapshot long_pct invalid (${longPct}) — gate fails fail-safe`,
      snapshot,
      snapshot_age_minutes: ageMin,
    };
  }
  const threshold = condition.crowd_threshold_pct;
  if (condition.side === "long") {
    const passes = longPct <= 100 - threshold;
    return {
      passes,
      reason: passes
        ? `Contrarian long signal — retail ${longPct.toFixed(1)}% long (≤ ${(100 - threshold).toFixed(0)}% means heavily short)`
        : `No contrarian signal — retail ${longPct.toFixed(1)}% long, need ≤ ${(100 - threshold).toFixed(0)}%`,
      snapshot,
      snapshot_age_minutes: ageMin,
    };
  }
  // side === "short"
  const passes = longPct >= threshold;
  return {
    passes,
    reason: passes
      ? `Contrarian short signal — retail ${longPct.toFixed(1)}% long (≥ ${threshold.toFixed(0)}% means heavily long)`
      : `No contrarian signal — retail ${longPct.toFixed(1)}% long, need ≥ ${threshold.toFixed(0)}%`,
    snapshot,
    snapshot_age_minutes: ageMin,
  };
}

/** Fetch the most-recent positioning snapshot for the given instrument.
 *  Returns null when no snapshots exist for that instrument (legitimate
 *  state — OANDA cron hasn't populated this instrument's cache yet) OR
 *  when the query errors (logs the error so the operator can see it). */
export async function fetchLatestPositioningSnapshot(
  supabase: SupabaseClient,
  instrument: string,
): Promise<PositioningSnapshot | null> {
  const { data, error } = await supabase
    .from("oanda_positioning_cache")
    .select("instrument, oanda_time, price, long_pct, short_pct")
    .eq("instrument", instrument)
    .order("oanda_time", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error(`[positioning-contrarian] fetch failed for ${instrument}:`, error.message);
    return null;
  }
  if (!data) return null;
  return {
    instrument: data.instrument as string,
    oanda_time: data.oanda_time as string,
    price: Number(data.price),
    long_pct: Number(data.long_pct),
    short_pct: Number(data.short_pct),
  };
}

/** Live-path entry-gate wrapper. Pulls all PositioningCondition entries
 *  from the rules, fetches each unique instrument's latest snapshot
 *  once, evaluates each condition, and returns an aggregate verdict.
 *
 *  Semantics:
 *  - 0 positioning conditions → passes (no gate present, no opinion)
 *  - ≥1 positioning condition → ALL must pass (AND), matching the
 *    "all" entry_logic default. (If a future operator needs OR semantics
 *    they should compose at the entry_logic level, not here.)
 *
 *  Caller responsible for short-circuiting: don't call this when
 *  rules.entry_conditions has no positioning conditions (cheaper to
 *  pre-filter). The function still works in that case — returns
 *  passes:true with reason:"no positioning conditions".
 */
export async function evaluatePositioningGate(
  supabase: SupabaseClient,
  conditions: PositioningCondition[],
  now: Date = new Date(),
): Promise<PositioningGateResult & { evaluated_conditions: number }> {
  if (conditions.length === 0) {
    return {
      passes: true,
      reason: "No positioning conditions",
      snapshot: null,
      snapshot_age_minutes: null,
      evaluated_conditions: 0,
    };
  }
  // Cache snapshot fetches per instrument — most algos use one instrument.
  const snapshotCache = new Map<string, PositioningSnapshot | null>();
  for (const cond of conditions) {
    let snapshot = snapshotCache.get(cond.instrument);
    if (snapshot === undefined) {
      snapshot = await fetchLatestPositioningSnapshot(supabase, cond.instrument);
      snapshotCache.set(cond.instrument, snapshot);
    }
    const result = evaluatePositioningContrarian(cond, snapshot, now);
    if (!result.passes) {
      return { ...result, evaluated_conditions: conditions.length };
    }
  }
  // All passed
  const last = conditions[conditions.length - 1];
  const snap = snapshotCache.get(last.instrument) ?? null;
  return {
    passes: true,
    reason: `All ${conditions.length} positioning condition(s) passed`,
    snapshot: snap,
    snapshot_age_minutes: snap ? (now.getTime() - new Date(snap.oanda_time).getTime()) / 60_000 : null,
    evaluated_conditions: conditions.length,
  };
}
