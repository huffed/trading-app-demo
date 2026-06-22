/**
 * Market-state features — leading indicators computed from price data
 * with NO lookahead, on the 4h frame.
 *
 * Origin: the 2026-06-11 market-state study (PR #188) confirmed the
 * operator's thesis that decay should be detected from the MARKET, not
 * from the algorithm starting to lose. Over 696 recorded entries:
 *   fast_div_bull   meanR 0.10 vs 0.57 overall (the D1-lag failure as a
 *                   measurable state — the Feb 2-6 bleed was this)
 *   usd_down        meanR 0.23
 *   mid vol         meanR 1.05 / compressed range 1.19 / fast_div_bear
 *                   0.96 (favourable states)
 *
 * This module is the SINGLE SOURCE for the feature math — the live
 * shadow logger AND scripts/market-state-study.ts both import from
 * here, so research and production can never drift (the SL-geometry
 * provenance incident class).
 *
 * SHADOW ONLY for now: states are logged on decisions and stamped onto
 * entry cohorts; nothing gates on them. Enforcement (downshift on
 * DOWNSHIFT_CANDIDATE states) requires live shadow evidence first, per
 * the gate-scoping lessons.
 */
import type { PriceBar } from "@/lib/market-data/types";

// CB.M4 (2026-06-19 EVE): state primitive types live in `src/types/market-state.ts`
// — types-as-leaf. Imported for local use AND re-exported so existing
// importers (entry.ts, portfolio-backtest.ts, market-state-gate.ts) keep
// working without touching their import paths.
import type {
  DxyState,
  MarketState,
  MtfState,
  RangeState,
  StructRegime,
  VolState,
} from "@/types/market-state";
export type { DxyState, MarketState, MtfState, RangeState, StructRegime, VolState };

/** States the study flagged as negative-expectancy at n ≥ 20. Shadow
 *  only — consult for logging/analysis, never for gating until live
 *  shadow evidence exists. */
export const DOWNSHIFT_CANDIDATE_STATES = {
  mtf: ["fast_div_bull"],
  dxy: ["usd_down"],
} as const;

/** Same structural read the backtest harness's daily-bias uses: the
 *  highest/lowest of the last 3 bars vs the 4 before them. */
export function swingRegime(bars: PriceBar[], endIdx: number): StructRegime | null {
  if (endIdx < 7 || endIdx >= bars.length) return null;
  const hi = (a: number, b: number): number => {
    let m = -Infinity;
    for (let i = a; i <= b; i++) m = Math.max(m, bars[i].high);
    return m;
  };
  const lo = (a: number, b: number): number => {
    let m = Infinity;
    for (let i = a; i <= b; i++) m = Math.min(m, bars[i].low);
    return m;
  };
  const last3High = hi(endIdx - 2, endIdx);
  const prev4High = hi(endIdx - 6, endIdx - 3);
  const last3Low = lo(endIdx - 2, endIdx);
  const prev4Low = lo(endIdx - 6, endIdx - 3);
  if (last3High > prev4High && last3Low > prev4Low) return "HH";
  if (last3High < prev4High && last3Low < prev4Low) return "LH";
  return "RANGING";
}

export function atr14(bars: PriceBar[], endIdx: number): number | null {
  if (endIdx < 15 || endIdx >= bars.length) return null;
  let s = 0;
  for (let i = endIdx - 13; i <= endIdx; i++) {
    s += Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
  }
  return s / 14;
}

/** Fraction of historical values strictly below x. Null when history is
 *  too thin to call a percentile honest. */
export function pctile(history: number[], x: number): number | null {
  if (history.length < 100) return null;
  let below = 0;
  for (const h of history) if (h < x) below++;
  return below / history.length;
}

/** Index of the last bar with date <= target (bars sorted by date).
 *
 *  DQ.1 caveat (2026-06-19 EVE): this is a STRING comparison, so all
 *  inputs MUST share the same date format for sort order to align with
 *  chronological order. `bars` is expected to come from `getCachedPrices`
 *  (which normalises to ISO+Z); `target` is also expected canonical.
 *  Mixed-format inputs would silently misorder (e.g. "2026-06-19
 *  10:00:00" sorts AFTER "2026-06-19T10:00:00Z" because space "Z" > "T"
 *  in ASCII). Don't bypass the cache normaliser. */
export function lastIdxAtOrBefore(bars: PriceBar[], target: string): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= target) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export interface MarketStateInputs {
  /** Primary 4h bars of the traded instrument. */
  bars4h: PriceBar[];
  /** 1h bars of the traded instrument (for the fast leg of mtf). */
  oneHourBars: PriceBar[];
  /** Daily bars of the traded instrument (for the D1 leg of mtf). */
  dailyBars: PriceBar[];
  /** EUR/USD 4h bars (USD-trend proxy). */
  eurusd4h: PriceBar[];
}

// Thresholds — must stay identical to the study's (PR #188).
const VOL_WINDOW = 1560; // ~1y of 4h bars
const RANGE_WINDOW = 500;
const LOW_P = 0.3;
const HIGH_P = 0.7;
const DXY_SLOPE_BARS = 20; // 4h bars ≈ 80h horizon
const DXY_FLIP_LOOKBACK = 6; // 4h bars ≈ 24h

/** Compute the four market-state features at `idx` of the 4h series.
 *  All inputs are used up-to-and-including their last bar at or before
 *  the 4h bar's date — no lookahead. Missing/thin inputs degrade the
 *  affected feature to "n/a", never throw. */
export function computeMarketState4h(inputs: MarketStateInputs, idx: number): MarketState {
  const { bars4h, oneHourBars, dailyBars, eurusd4h } = inputs;
  const out: MarketState = { mtf: "n/a", vol: "n/a", range: "n/a", dxy: "n/a" };
  if (idx < 0 || idx >= bars4h.length) return out;
  const atDate = bars4h[idx].date;

  // vol — ATR(14) percentile vs trailing window
  const atrNow = atr14(bars4h, idx);
  if (atrNow !== null) {
    const hist: number[] = [];
    for (let i = Math.max(15, idx - VOL_WINDOW); i < idx; i++) {
      const v = atr14(bars4h, i);
      if (v !== null) hist.push(v);
    }
    const p = pctile(hist, atrNow);
    if (p !== null) out.vol = p < LOW_P ? "low" : p > HIGH_P ? "high" : "mid";
  }

  // mtf — structure alignment across 1h / 4h / D1
  // DQ.1 regression fix (2026-06-19 EVE adversarial audit): hardcoded
  // space-format violated the canonical ISO+Z contract enforced at the
  // price-cache layer. With dailyBars now normalised to ISO+Z by
  // price-cache.getCachedPrices, the search target MUST also be ISO+Z
  // or string comparison silently misorders (space > "T" in ASCII).
  const d1Idx = lastIdxAtOrBefore(dailyBars, atDate.slice(0, 10) + "T00:00:00.000Z") - 1;
  const h1Idx = lastIdxAtOrBefore(oneHourBars, atDate);
  const d1 = d1Idx >= 7 ? swingRegime(dailyBars, d1Idx) : null;
  const h4 = swingRegime(bars4h, idx);
  const h1 = h1Idx >= 7 ? swingRegime(oneHourBars, h1Idx) : null;
  if (d1 && h4 && h1) {
    if (d1 === "HH" && h4 === "HH" && h1 === "HH") out.mtf = "aligned_HH";
    else if (d1 === "LH" && h4 === "LH" && h1 === "LH") out.mtf = "aligned_LH";
    else if (d1 === "RANGING" && h4 === "RANGING" && h1 === "RANGING") out.mtf = "ranging_all";
    else if (h1 === "HH" && d1 !== "HH") out.mtf = "fast_div_bull";
    else if (h1 === "LH" && d1 !== "LH") out.mtf = "fast_div_bear";
    else out.mtf = "mixed";
  }

  // range — 20-bar width percentile vs trailing window
  if (idx >= 20) {
    const width = (a: number): number | null => {
      if (a < 20) return null;
      let hi = -Infinity;
      let lo = Infinity;
      for (let j = a - 19; j <= a; j++) {
        hi = Math.max(hi, bars4h[j].high);
        lo = Math.min(lo, bars4h[j].low);
      }
      return (hi - lo) / bars4h[a].close;
    };
    const wNow = width(idx);
    if (wNow !== null) {
      const hist: number[] = [];
      for (let i = Math.max(20, idx - RANGE_WINDOW); i < idx; i++) {
        const v = width(i);
        if (v !== null) hist.push(v);
      }
      const p = pctile(hist, wNow);
      if (p !== null)
        {out.range = p < LOW_P ? "compressed" : p > HIGH_P ? "expanded" : "normal";}
    }
  }

  // dxy — EUR/USD 4h 20-bar slope; EUR up = USD down. Flip when the
  // slope's sign changed within the last 6 bars.
  const eIdx = lastIdxAtOrBefore(eurusd4h, atDate);
  if (eIdx >= DXY_SLOPE_BARS + DXY_FLIP_LOOKBACK) {
    const slope = (i: number): number => eurusd4h[i].close - eurusd4h[i - DXY_SLOPE_BARS].close;
    const now = slope(eIdx);
    let flipped = false;
    for (let k = 1; k <= DXY_FLIP_LOOKBACK; k++) {
      if (Math.sign(slope(eIdx - k)) !== Math.sign(now)) {
        flipped = true;
        break;
      }
    }
    out.dxy = flipped ? "usd_flip" : now > 0 ? "usd_down" : "usd_up";
  }

  return out;
}
