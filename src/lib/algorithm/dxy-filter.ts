/**
 * DXY directional filter — refuses gold entries when the dollar index
 * direction over the preceding lookback window contradicts the proposed
 * trade direction.
 *
 * Twelve Data exposes no DXY symbol; EUR/USD is used as proxy (57% of
 * the DXY basket; strong inverse correlation). The convention used
 * here: positive `delta_pips` = EUR/USD up = DXY down = bullish-gold
 * backdrop. Caller is responsible for fetching the proxy bars and
 * passing them in.
 *
 * Per-algo data, not blanket: 2026-04-30 exploratory analysis on the 4
 * live gold algos (corpus: 35-66 trades each over ~7 months) showed
 * dramatic positive impact only on the 15m short algo (B): aligned
 * trades won 86% / +$2,124 avg, against trades won 28% / -$250 avg.
 * For longer-timeframe long algos (C/D/E) the signal was either mixed
 * or inverted (D's longs made MORE money entering against DXY trend —
 * possibly mean-reversion). Enable per-algo only after validating
 * with `inspect-algo` overlay; do not blanket-deploy.
 */
import type { PriceBar } from "@/lib/market-data/types";
import type { AlgorithmRules } from "@/types/algorithm";

export interface DxyFilterResult {
  block: boolean;
  /** Human-readable reason when blocked — surfaced into activity_log. */
  reason?: string;
  /** EUR/USD pip change over the lookback. >0 = DXY weakening (bullish
   *  gold), <0 = DXY strengthening (bearish gold). Logged on every
   *  evaluation so we can later switch to a learned threshold. */
  delta_pips?: number;
  threshold_pips?: number;
  lookback_hours?: number;
  /** Bucket the trade fell into. "blocked" means the bucket triggered
   *  the filter (per `mode`); the other values are pass-through buckets
   *  surfaced for telemetry. "against" is now a pass-through state for
   *  block_neutral_only mode where we keep both directional buckets. */
  status: "blocked" | "aligned" | "against" | "neutral" | "no_data";
}

export interface CheckDxyArgs {
  side: "long" | "short";
  /** ISO timestamp of the bar at which the entry is being evaluated. */
  currentTimestamp: string;
  /** Proxy bars (EUR/USD 1h is the canonical choice). The caller fetches
   *  this and reuses across all entry evaluations in the simulation. */
  proxyBars: PriceBar[];
  config: NonNullable<AlgorithmRules["dxy_filter"]>;
}

const DEFAULT_LOOKBACK_HOURS = 12;
const DEFAULT_PIP_THRESHOLD = 15;

/** Find the latest proxy bar with date <= ts. Binary search — caller
 *  invokes per entry evaluation, so each scan-layer call is O(log n). */
function findBarAtOrBefore(bars: PriceBar[], ts: number): PriceBar | null {
  let lo = 0;
  let hi = bars.length - 1;
  let result: PriceBar | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (new Date(bars[mid].date).getTime() <= ts) {
      result = bars[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

export function checkDxyDirection(args: CheckDxyArgs): DxyFilterResult {
  const { side, currentTimestamp, proxyBars, config } = args;
  if (!config.enabled || proxyBars.length === 0) {
    return { block: false, status: "no_data" };
  }
  const lookbackHours = config.lookback_hours ?? DEFAULT_LOOKBACK_HOURS;
  const pipThreshold = config.pip_threshold ?? DEFAULT_PIP_THRESHOLD;
  // mode = which buckets to block. Defaults to "block_against" so an
  // un-set mode preserves the original PR-95 behaviour. block_neutral
  // is the legacy boolean knob — when true and mode is unset, behaves
  // as "block_against_and_neutral". mode wins when both are set.
  const mode =
    config.mode ?? (config.block_neutral ? "block_against_and_neutral" : "block_against");

  const ts = new Date(currentTimestamp).getTime();
  const lookbackTs = ts - lookbackHours * 3600 * 1000;

  const entryBar = findBarAtOrBefore(proxyBars, ts);
  const lookbackBar = findBarAtOrBefore(proxyBars, lookbackTs);
  if (!entryBar || !lookbackBar) {
    return { block: false, status: "no_data" };
  }
  const deltaPips = (entryBar.close - lookbackBar.close) * 10000;
  const dxyFalling = deltaPips > 0; // EUR/USD up == DXY down
  const aligned =
    (side === "long" && dxyFalling) || (side === "short" && !dxyFalling);
  const isNeutral = Math.abs(deltaPips) < pipThreshold;

  const telemetry = {
    delta_pips: deltaPips,
    threshold_pips: pipThreshold,
    lookback_hours: lookbackHours,
  };

  // Classify the bucket first; THEN decide block based on mode. Cleaner
  // than nested branches and makes adding new modes trivial.
  const bucket: "aligned" | "against" | "neutral" = isNeutral
    ? "neutral"
    : aligned
      ? "aligned"
      : "against";

  let block = false;
  if (mode === "block_against") {
    block = bucket === "against";
  } else if (mode === "block_neutral_only") {
    // Inverted-signal mode (Algo D) — keep both aligned AND against
    // (the strong-direction buckets), block only the choppy mid-range
    // where the signal is undifferentiated.
    block = bucket === "neutral";
  } else {
    // block_against_and_neutral
    block = bucket === "against" || bucket === "neutral";
  }

  if (!block) {
    return { ...telemetry, block: false, status: bucket };
  }
  const reason =
    bucket === "neutral"
      ? `DXY neutral (|EUR/USD ${deltaPips.toFixed(1)}| < ${pipThreshold}pip over ${lookbackHours}h, mode=${mode})`
      : `DXY against ${side} gold (EUR/USD ${deltaPips > 0 ? "+" : ""}${deltaPips.toFixed(1)} pips over ${lookbackHours}h, mode=${mode})`;
  return {
    ...telemetry,
    block: true,
    status: "blocked",
    reason,
  };
}
