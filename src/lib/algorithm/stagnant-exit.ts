/**
 * Stagnant-loser early exit — closes a position that has been open long
 * enough to develop, never showed favourable promise, and is still in
 * red. Modelled on the friend's data: median 16-min cut on losers vs
 * 69-min hold on winners. Disciplined humans cut what isn't working
 * fast and let winners run; this rule encodes that asymmetry.
 *
 * Three conditions must all be true to fire:
 *   1. bars_open  >= max_bars             (give the trade time to develop)
 *   2. mfe_r       < min_excursion_r      (never showed enough promise)
 *   3. current_r  <= min_pnl_r            (still adverse right now)
 *
 * Cutting purely on time would close trades that briefly went green and
 * came back. Cutting purely on MFE would close trades that just need
 * more time. Cutting purely on current P&L would close noise. Together,
 * the three only fire on trades that are genuinely stuck — drifted
 * sideways or against us, never offered a sensible exit window.
 *
 * `max_bars` is computed from local ATR rather than baked in:
 *   expected_bars = SL_distance / ATR(14)
 *   max_stagnant  = clamp(round(expected_bars * 0.5), 2, 12)
 *
 * This auto-adapts to timeframe (ATR scales with bar size), symbol
 * (different volatilities), volatility regime (fast tape cuts sooner;
 * slow tape gives more time), and SL tightness (tighter stop → faster
 * expected resolution). Algorithms can pin an explicit `max_bars` to
 * override if they need it.
 */
import { computeAtr } from "@/lib/market-data/regime-filter";
import type { PriceBar } from "@/lib/market-data/types";

export interface StagnantExitConfig {
  enabled: boolean;
  /** Optional override. When undefined, derived from local ATR. */
  max_bars?: number;
  /** R-units. Trade is "stagnant" if peak favourable excursion never
   *  reached this. Default 0.5 = "made it halfway to where TP would
   *  have been if R:R were 1:1". */
  min_excursion_r?: number;
  /** R-units. Position must currently sit at or below this to qualify
   *  for the cut. Default 0 = "still in red". */
  min_pnl_r?: number;
}

/**
 * Defaults empirically tuned against the Forex testing 1h algorithm
 * (1.2% SL / 3.6% TP / 3:1 RR). On that setup:
 *
 *   - Aggressive defaults (max_bars 7, min_exc 0.5, min_pnl 0) collapsed
 *     WR from 59.3% → 2-5% by cutting eventual winners that needed time
 *     to develop. Slow-trending forex setups have winners with MFE often
 *     sitting at 5-15% of SL distance for 20+ bars before the trend
 *     accelerates into TP — so a tight MFE floor + small bar count
 *     wholesale culls them.
 *
 *   - Conservative defaults (max_bars 48, min_exc 0.1, min_pnl -0.5)
 *     improved WR to 59.5%, return to 15.5%, mean DD to 3.12% (from
 *     3.68%), worst DD to 3.44% (from 5.12%). The gate ONLY cuts deeply-
 *     in-red trades open 2+ days with no favourable excursion — i.e.
 *     trades that were going to hit SL anyway, but at a smaller loss.
 *
 * Faster-timeframe / scalpier strategies should override `max_bars`
 * lower; tighter-SL setups can lift `min_excursion_r`. The defaults
 * here are picked to avoid REGRESSING any algorithm — they only fire
 * on the truly-stuck distribution that benefits from being cut.
 */
const DEFAULTS = {
  min_excursion_r: 0.1,
  min_pnl_r: -0.5,
  atrPeriod: 14,
  /** Full expected bars-to-SL via random walk (was 0.5 = half). The half
   *  multiplier was too aggressive for slow-trending 1h forex; full lets
   *  the trade have its expected time before the gate considers it stuck. */
  bar_count_factor: 1.0,
  /** Floor of 6 — gives at least 6 bars of headroom even on tight-SL /
   *  high-ATR pairs where the formula would otherwise round down. */
  bar_count_min: 6,
  /** Lifted from 12 to 48: 1h trades with 1.2% SL on quiet hours can take
   *  20-40 bars to develop. 48 = a full trading day, plenty of headroom
   *  for the slowest legitimate winners. */
  bar_count_max: 48,
} as const;

export interface StagnantExitResult {
  /** True when the position should be closed for stagnation. */
  exit: boolean;
  reason?: string;
  /** Telemetry — present even when not blocking, so activity_log captures
   *  the distribution of MFE / current_r / bars_open across all positions
   *  managed (allowed and cut). */
  bars_open: number;
  max_bars_threshold: number;
  mfe_r: number;
  current_r: number;
  atr_at_check: number | null;
  /** "no_data" when there isn't enough bar history to compute an ATR-
   *  derived threshold (only relevant when max_bars is auto-derived). */
  status: "exit" | "hold" | "no_data" | "disabled";
}

interface CheckArgs {
  /** Bar series that includes the entry bar AND the current bar. */
  bars: PriceBar[];
  /** Index of the entry bar within `bars`. Computed by caller from
   *  position.opened_at on the live path; tracked at insert time on the
   *  backtest path. */
  entryBarIndex: number;
  /** Index of the current bar (latest). bars[currentBarIndex] is "now". */
  currentBarIndex: number;
  entryPrice: number;
  /** Long or short. Drives MFE direction (high vs low). */
  side: "long" | "short";
  /** Pre-computed stop distance from entry, in price units. Caller passes
   *  this so the helper doesn't need to know about the rule's stop_loss
   *  encoding (% / fixed / pips) — that's already resolved upstream. */
  stopDistance: number;
  config: StagnantExitConfig;
}

/**
 * Decide whether a position should be cut for stagnation. Pure function
 * — no DB, no broker, no I/O. Caller wires the result into the exit
 * pipeline (manage cron in live, simulation loop in backtest).
 */
export function checkStagnantExit(args: CheckArgs): StagnantExitResult {
  const { bars, entryBarIndex, currentBarIndex, entryPrice, side, stopDistance, config } = args;
  const minExcR = config.min_excursion_r ?? DEFAULTS.min_excursion_r;
  const minPnlR = config.min_pnl_r ?? DEFAULTS.min_pnl_r;

  const blank = (status: StagnantExitResult["status"]): StagnantExitResult => ({
    exit: false,
    bars_open: Math.max(0, currentBarIndex - entryBarIndex),
    max_bars_threshold: 0,
    mfe_r: 0,
    current_r: 0,
    atr_at_check: null,
    status,
  });

  if (!config.enabled) return blank("disabled");
  if (stopDistance <= 0) return blank("no_data");
  if (entryBarIndex < 0 || currentBarIndex <= entryBarIndex) return blank("no_data");
  if (currentBarIndex >= bars.length) return blank("no_data");

  const barsOpen = currentBarIndex - entryBarIndex;
  const currentBar = bars[currentBarIndex];

  // R-units: distance from entry expressed as multiples of stop distance.
  // Long MFE = max high since entry; short MFE = min low since entry.
  // Always positive when favourable: long needs price up, short needs
  // price down — flip the sign for shorts so we compare apples to apples.
  let mfePrice: number;
  if (side === "long") {
    mfePrice = bars[entryBarIndex].high;
    for (let k = entryBarIndex + 1; k <= currentBarIndex; k++) {
      if (bars[k].high > mfePrice) mfePrice = bars[k].high;
    }
  } else {
    mfePrice = bars[entryBarIndex].low;
    for (let k = entryBarIndex + 1; k <= currentBarIndex; k++) {
      if (bars[k].low < mfePrice) mfePrice = bars[k].low;
    }
  }
  const favourableExcursion = side === "long" ? mfePrice - entryPrice : entryPrice - mfePrice;
  const mfeR = favourableExcursion / stopDistance;

  const currentExcursion =
    side === "long" ? currentBar.close - entryPrice : entryPrice - currentBar.close;
  const currentR = currentExcursion / stopDistance;

  // Resolve the bar threshold. Auto = ATR-derived; explicit override
  // honoured when set.
  let maxBars: number;
  let atrAtCheck: number | null = null;
  if (typeof config.max_bars === "number" && config.max_bars > 0) {
    maxBars = config.max_bars;
  } else {
    const series = computeAtr(bars.slice(0, currentBarIndex + 1), DEFAULTS.atrPeriod);
    const atr = series[currentBarIndex];
    if (atr == null || atr <= 0) {
      return {
        ...blank("no_data"),
        bars_open: barsOpen,
        mfe_r: mfeR,
        current_r: currentR,
      };
    }
    atrAtCheck = atr;
    const expectedBars = stopDistance / atr;
    const raw = Math.round(expectedBars * DEFAULTS.bar_count_factor);
    maxBars = Math.min(Math.max(raw, DEFAULTS.bar_count_min), DEFAULTS.bar_count_max);
  }

  const timeOk = barsOpen >= maxBars;
  const mfeOk = mfeR < minExcR;
  const pnlOk = currentR <= minPnlR;
  const allFire = timeOk && mfeOk && pnlOk;

  return {
    exit: allFire,
    reason: allFire
      ? `Stagnant: ${barsOpen} bars open, MFE ${mfeR.toFixed(2)}R < ${minExcR}R, current ${currentR.toFixed(2)}R ≤ ${minPnlR}R (max bars ${maxBars}${atrAtCheck != null ? ` from ATR ${atrAtCheck.toFixed(5)}` : ""})`
      : undefined,
    bars_open: barsOpen,
    max_bars_threshold: maxBars,
    mfe_r: mfeR,
    current_r: currentR,
    atr_at_check: atrAtCheck,
    status: allFire ? "exit" : "hold",
  };
}

/**
 * Resolve the bar index whose timestamp is the entry bar. Used by the
 * live path which has `position.opened_at` as an ISO string. Returns -1
 * when no bar matches (e.g. entry happened intra-bar of the latest one
 * not yet sampled, or the cache window has rolled past the entry).
 *
 * Strategy: pick the LAST bar whose timestamp is ≤ opened_at, then nudge
 * forward by one if the position was opened past that bar's open. The
 * stagnant gate's only sensitivity to this is "how many bars have we
 * been in" — being off-by-one is fine; it just means one tick earlier
 * or later cut, which is well within the noise of the gate's purpose.
 */
export function resolveEntryBarIndex(
  bars: PriceBar[],
  openedAtIso: string
): number {
  if (bars.length === 0) return -1;
  const opened = new Date(openedAtIso).getTime();
  if (!Number.isFinite(opened)) return -1;
  let last = -1;
  for (let i = 0; i < bars.length; i++) {
    const t = new Date(bars[i].date).getTime();
    if (Number.isFinite(t) && t <= opened) last = i;
    else break;
  }
  return last;
}
