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
 * Threshold: 1.5× primary-TF bar duration, measured from the bar's
 * CLOSE (= open + tfMinutes). So:
 *   - 15m algo refuses when most-recent close is > 22.5 min ago
 *   - 30m algo refuses when most-recent close is > 45 min ago
 *   - 1h  algo refuses when most-recent close is > 90 min ago
 *   - 4h  algo refuses when most-recent close is > 360 min ago
 *
 * The 1.5× multiplier (from close) gives 0.5×TF of grace after the bar
 * closes for the provider to publish, then refuses if a second full bar
 * has effectively elapsed unfed.
 *
 * Why measured from CLOSE not OPEN: provider `date` fields hold the bar's
 * open timestamp by convention. Earlier this gate computed age from open
 * directly and the 1.5×TF threshold was being eaten by the bar's own
 * duration — leaving only 0.5×TF of post-close grace. For 15m/30m that's
 * tolerable, but for 4h it produced a ~2h false-positive deadzone every
 * cycle (gate fired between (open + 1.5×TF) and the next bar close, even
 * though the cached bar was the freshest closed 4h candle in existence).
 * 2026-05-12 incident: 4h algo fired the gate twice at 12:00 and 16:00
 * UTC on the freshest possible closed bar.
 */
import { timeframeToInterval, type BarInterval } from "@/lib/market-data/interval";
import { parseBarDate } from "@/lib/market-data/parse-bar-date";

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
  /** Minutes elapsed since the most recent bar's CLOSE
   *  (= now - bars[last].date - tfMinutes). Can be negative on the rare
   *  scan that lands mid-bar with a leading bar-close timestamp. */
  bar_age_minutes: number;
  /** Threshold the age was compared against, in minutes (from close). */
  threshold_minutes: number;
  /** ISO timestamp of the bar that was checked (open). */
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

  // Parse explicitly as UTC — bar `date` strings come from provider
  // fetchers as "YYYY-MM-DD HH:MM:SS" (no TZ marker), which Node's
  // default `new Date(...)` interprets in system-local TZ. On BST that
  // skews every age check by 60 min, false-firing this gate. See
  // parse-bar-date.ts for the 2026-05-12 incident.
  const barDate = parseBarDate(args.lastBarDate);
  if (Number.isNaN(barDate.getTime())) {
    return {
      block: false,
      status: "no_bars",
      bar_age_minutes: 0,
      threshold_minutes: thresholdMinutes,
    };
  }

  const now = args.now ?? new Date();
  // Age = wall-clock now minus the bar's CLOSE timestamp (open + tfMinutes).
  // Provider `date` fields hold OPEN by convention, so subtract one bar
  // duration. See doc comment for why we measure from close.
  const closeMs = barDate.getTime() + tfMinutes * 60_000;
  const ageMs = now.getTime() - closeMs;
  const ageMinutes = ageMs / 60_000;

  if (ageMinutes > thresholdMinutes) {
    return {
      block: true,
      status: "stale",
      bar_age_minutes: ageMinutes,
      threshold_minutes: thresholdMinutes,
      last_bar_date: barDate.toISOString(),
      reason: `Most recent bar closed ${ageMinutes.toFixed(1)} min ago (threshold ${thresholdMinutes.toFixed(1)} min = ${multiplier}× ${tfMinutes}m primary-TF, measured from close). LLM context anchored on prices that no longer reflect the market — likely a stale price cache or provider fetch failure.`,
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
