/**
 * Bar-staleness gate — refuses LLM-trader entries when the most recent
 * bar in the analysis window is too old. Root-cause backstop for the
 * "LLM analyzes minutes-old prices" failure mode that drives the
 * drift-gate work.
 *
 * Why a separate gate from drift: drift catches the SYMPTOM (live price
 * has diverged from analyzed close). Staleness catches the CAUSE (the
 * price cache hasn't refreshed, so the LLM's bars[last] timestamp is
 * meaningfully older than "now"). Both gates can fire on the same
 * incident — but only one needs to refuse the trade for safety, and
 * staleness can fire even when live price happens to coincide with the
 * stale close (luck, not signal).
 *
 * Incident 2026-05-12: 30m algo at 01:30 UTC analyzed a bar dated
 * 00:30 UTC — the price cache hadn't been refreshed since 00:35,
 * leaving the LLM 60 min behind real price. Combined with a tight
 * structural SL (54 lots from 7-pip SL math), the stale-data entry hit
 * SL in 10 min for -$399.
 *
 * Threshold: 1.5× primary-TF bar duration. So:
 *   - 15m algo refuses on bars > 22.5 min stale
 *   - 30m algo refuses on bars > 45 min stale
 *   - 1h  algo refuses on bars > 90 min stale
 *   - 4h  algo refuses on bars > 360 min stale
 *
 * The 1.5× multiplier gives one full bar of grace for the case where a
 * fresh bar has just closed but Twelve Data hasn't published it yet.
 * Anything beyond that means the cache fetch is broken or starved.
 */
import { timeframeToInterval, type BarInterval } from "@/lib/market-data/interval";

/** Multiplier on primary-TF bar duration. >1.5× = stale. */
export const STALENESS_THRESHOLD_MULTIPLIER = 1.5;

function intervalMinutes(interval: BarInterval): number {
  switch (interval) {
    case "15min":
      return 15;
    case "30min":
      return 30;
    case "1h":
      return 60;
    case "4h":
      return 240;
    case "1day":
      return 1440;
  }
}

export interface BarStalenessGateResult {
  block: boolean;
  status: "ok" | "stale" | "no_bars";
  /** Age of the most recent bar in minutes (now - bars[last].date). */
  bar_age_minutes: number;
  /** Threshold the age was compared against, in minutes. */
  threshold_minutes: number;
  /** ISO timestamp of the bar that was checked. */
  last_bar_date?: string;
  reason?: string;
}

/**
 * Returns block:true when the most recent bar is stale relative to the
 * primary timeframe. `now` is injectable for tests; in production
 * callers omit it and the gate uses `Date.now()`.
 */
export function checkBarStaleness(args: {
  /** The algorithm's primary timeframe (e.g. "15m", "30m", "1h", "4h"). */
  timeframe: string;
  /** ISO string (or Date) of the most recent bar's `date` field.
   *  Pass `bars[bars.length - 1].date` here. */
  lastBarDate: string | Date | null | undefined;
  /** Override timestamp for "now" — for tests. Defaults to Date.now(). */
  now?: Date;
  /** Override the staleness multiplier (default 1.5). */
  multiplier?: number;
}): BarStalenessGateResult {
  const interval = timeframeToInterval(args.timeframe);
  const tfMinutes = intervalMinutes(interval);
  const multiplier = args.multiplier ?? STALENESS_THRESHOLD_MULTIPLIER;
  const thresholdMinutes = tfMinutes * multiplier;

  if (!args.lastBarDate) {
    return {
      block: false,
      status: "no_bars",
      bar_age_minutes: 0,
      threshold_minutes: thresholdMinutes,
    };
  }

  const barDate = args.lastBarDate instanceof Date ? args.lastBarDate : new Date(args.lastBarDate);
  if (Number.isNaN(barDate.getTime())) {
    return {
      block: false,
      status: "no_bars",
      bar_age_minutes: 0,
      threshold_minutes: thresholdMinutes,
    };
  }

  const now = args.now ?? new Date();
  const ageMs = now.getTime() - barDate.getTime();
  const ageMinutes = ageMs / 60_000;

  if (ageMinutes > thresholdMinutes) {
    return {
      block: true,
      status: "stale",
      bar_age_minutes: ageMinutes,
      threshold_minutes: thresholdMinutes,
      last_bar_date: barDate.toISOString(),
      reason: `Most recent bar is ${ageMinutes.toFixed(1)} min old (threshold ${thresholdMinutes.toFixed(1)} min = ${multiplier}× ${tfMinutes}m primary-TF). LLM context anchored on prices that no longer reflect the market — likely a stale price cache or Twelve Data fetch failure.`,
    };
  }

  return {
    block: false,
    status: "ok",
    bar_age_minutes: ageMinutes,
    threshold_minutes: thresholdMinutes,
    last_bar_date: barDate.toISOString(),
  };
}
