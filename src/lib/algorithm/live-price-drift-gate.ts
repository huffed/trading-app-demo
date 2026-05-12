/**
 * Live-price drift gate — refuses LLM-trader entries when the broker's
 * current quote has drifted materially from the bar-close price the
 * LLM analyzed, in EITHER direction.
 *
 * Why this matters: the LLM is given context anchored on the last
 * completed primary-TF bar (currentTimestamp = bars[last].date, last
 * close = bars[last].close). Execution fires at the broker's live price
 * moments later. When live price has moved meaningfully since that
 * close, the setup the LLM described no longer exists at the fill price
 * — the trade is being placed against a different chart than the one
 * the model evaluated.
 *
 * Why absolute (not direction-aware): the original ship was direction-
 * aware (only block when price ran INTO the trade direction past
 * threshold). The 2026-05-12 incident proved that wrong:
 *
 *   - Trade #2 (15m long): LLM analyzed close 4756, filled at 4767 →
 *     +0.23% adverse drift. Caught by direction-aware gate.
 *
 *   - Trade #3 (30m long, opened 17s after Trade #1 stopped): LLM
 *     analyzed close ~4759 (60-min-stale cache), filled at 4736 →
 *     -0.49% "favourable" drift. NOT caught by direction-aware gate
 *     because price had fallen, not risen. Stopped out 10 min later
 *     at -$399 for a "cheaper entry into a falling knife".
 *
 * Lesson: the LLM's reasoning is anchored to a SPECIFIC price level
 * ("retest of 4761 support", "scalp-grade setup at 4756"). Drift in
 * either direction invalidates that reasoning — the support level is
 * no longer being retested, the scalp setup has played out, etc. Block
 * absolute drift, regardless of sign.
 *
 * Threshold default 0.20%. Caught Trade #2 (0.23%) by a hair and would
 * have caught Trade #3 (0.49%) with room. Tunable per algo once
 * telemetry justifies a different per-symbol value.
 */

/** Default maximum absolute drift between bar close and live price.
 *  0.20% — empirically catches the 2026-05-12 gold incidents without
 *  blocking ordinary cross-bar lag. */
export const DEFAULT_MAX_DRIFT_PCT = 0.002;

export interface LivePriceDriftGateResult {
  /** True when the entry should be refused. */
  block: boolean;
  /** "no_live_price" when livePrice is null/invalid — caller should NOT
   *  block, since with no broker quote we're entering at the bar close
   *  itself (no drift possible). "ok" when |drift| within tolerance. */
  status: "ok" | "drifted" | "no_live_price";
  /** Signed drift as a fraction of bar close (live - barClose) / barClose.
   *  Positive = live price ABOVE the analyzed close, negative = BELOW.
   *  Sign preserved for telemetry/analysis even though the block
   *  decision uses absolute value. */
  drift_pct: number;
  /** Absolute drift used for the block decision. Always ≥ 0. */
  drift_abs_pct: number;
  bar_close: number;
  live_price: number;
  threshold_pct: number;
  reason?: string;
}

export function checkLivePriceDrift(args: {
  side: "long" | "short";
  /** Close of the last completed primary-TF bar — the price the LLM
   *  was anchored on. */
  barClose: number;
  /** Broker quote midpoint (or whatever the caller passes as livePrice
   *  into evaluateEntry). Null/undefined → no_live_price status, no
   *  block. */
  livePrice: number | null | undefined;
  /** Override the default threshold. For per-algo tuning if/when a
   *  rules-level config is added; for now defaults are fine. */
  maxDriftPct?: number;
}): LivePriceDriftGateResult {
  const threshold = args.maxDriftPct ?? DEFAULT_MAX_DRIFT_PCT;

  if (
    args.livePrice == null ||
    !Number.isFinite(args.livePrice) ||
    args.livePrice <= 0 ||
    !Number.isFinite(args.barClose) ||
    args.barClose <= 0
  ) {
    return {
      block: false,
      status: "no_live_price",
      drift_pct: 0,
      drift_abs_pct: 0,
      bar_close: args.barClose,
      live_price: args.livePrice ?? 0,
      threshold_pct: threshold,
    };
  }

  const rawDelta = args.livePrice - args.barClose;
  const driftPct = rawDelta / args.barClose;
  const absDriftPct = Math.abs(driftPct);

  if (absDriftPct > threshold) {
    const direction = driftPct > 0 ? "above" : "below";
    return {
      block: true,
      status: "drifted",
      drift_pct: driftPct,
      drift_abs_pct: absDriftPct,
      bar_close: args.barClose,
      live_price: args.livePrice,
      threshold_pct: threshold,
      reason: `Live price ${args.livePrice.toFixed(4)} drifted ${(absDriftPct * 100).toFixed(3)}% ${direction} bar close ${args.barClose.toFixed(4)} (threshold ${(threshold * 100).toFixed(2)}%) — LLM analyzed a ${args.side} setup anchored on ${args.barClose.toFixed(4)} which no longer exists at the current quote`,
    };
  }

  return {
    block: false,
    status: "ok",
    drift_pct: driftPct,
    drift_abs_pct: absDriftPct,
    bar_close: args.barClose,
    live_price: args.livePrice,
    threshold_pct: threshold,
  };
}
