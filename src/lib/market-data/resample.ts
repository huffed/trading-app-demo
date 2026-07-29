/**
 * Resample an intraday bar series to a coarser timeframe. Used by the
 * backtest + scan engines to compute higher-timeframe context (daily_bias,
 * 4h liquidity sweeps from a 1h primary, etc.) without separate API
 * fetches — we already have the finer bars, the coarser view is a
 * deterministic aggregation.
 *
 * Date keying for "1d" uses the calendar day prefix `YYYY-MM-DD`, which is
 * correct for both daily bars (passes through) and intraday bars
 * regardless of timezone offset.
 *
 * For intraday targets ("4h", "1h", etc.) we bucket by floor(timestamp /
 * bucketSeconds). Source bars finer than the target are aggregated; source
 * bars coarser than or equal to the target pass through unchanged.
 *
 * D1 ANCHOR SEMANTICS (E2.19.b, resolved 2026-07-29). Two daily
 * conventions exist and they diverge on ~8% of bars (measured E2.25.b,
 * 6.2× concentrated at SMA crossings):
 *   - LIVE reads provider D1 (OANDA NY-17:00 session days, 5/wk) —
 *     single-source, unchanged.
 *   - `resampleToDaily` groups by UTC calendar day (~6 "days"/wk).
 * The decision: live stays on OANDA D1; every VERDICT-GRADE backtest
 * path (validate-algo, revalidate-candidates, e2.22 harness) passes
 * `dailyBarsOverride` built from the pinned session-D file via
 * `sessionDailyClose()` (close-instant-stamped NY session days), so
 * backtest daily_bias/regime/ADX match live exactly. This UTC resample
 * remains ONLY for diagnostic callers (dashboard backtest actions,
 * loser-analysis, walk-forward) where the ~8% boundary divergence is an
 * accepted approximation — do NOT add new verdict paths on it.
 */
import type { PriceBar } from "./types";

const TIMEFRAME_SECONDS: Record<string, number> = {
  "1min": 60,
  "5min": 5 * 60,
  "15min": 15 * 60,
  "30min": 30 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "1d": 24 * 60 * 60,
  "1day": 24 * 60 * 60,
  "15m": 15 * 60,
  "30m": 30 * 60,
  "5m": 5 * 60,
  "1m": 60,
};

function timeframeSeconds(tf: string): number {
  return TIMEFRAME_SECONDS[tf.toLowerCase()] ?? 60 * 60;
}

function aggregate(group: PriceBar[]): Omit<PriceBar, "date"> {
  let high = group[0].high;
  let low = group[0].low;
  let volume = 0;
  for (const b of group) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    volume += b.volume;
  }
  return { open: group[0].open, high, low, close: group[group.length - 1].close, volume };
}

export function resampleToDaily(bars: PriceBar[]): PriceBar[] {
  if (bars.length === 0) return bars;
  const byDay = new Map<string, PriceBar[]>();
  for (const b of bars) {
    const day = b.date.split(/[ T]/)[0];
    const list = byDay.get(day);
    if (list) list.push(b);
    else byDay.set(day, [b]);
  }
  const out: PriceBar[] = [];
  for (const [day, group] of byDay) {
    if (group.length === 0) continue;
    out.push({ date: day, ...aggregate(group) });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Resample to an arbitrary timeframe (e.g. "4h"). Bars are grouped into
 * buckets of `bucketSeconds` starting at unix epoch — so 4h buckets align
 * to 00/04/08/... UTC. The bucket's representative date is its start time
 * formatted "YYYY-MM-DD HH:MM:SS" (matches the engine's intraday format).
 *
 * For "1d" target this delegates to resampleToDaily for the canonical
 * date-only output format.
 */
export function resampleTo(bars: PriceBar[], targetTimeframe: string): PriceBar[] {
  const tf = targetTimeframe.toLowerCase();
  if (tf === "1d" || tf === "1day") return resampleToDaily(bars);
  if (bars.length === 0) return bars;

  const bucketSec = timeframeSeconds(tf);
  const buckets = new Map<number, PriceBar[]>();
  for (const b of bars) {
    const ms = new Date(b.date).getTime();
    if (Number.isNaN(ms)) continue;
    const bucketStart = Math.floor(ms / 1000 / bucketSec) * bucketSec;
    const list = buckets.get(bucketStart);
    if (list) list.push(b);
    else buckets.set(bucketStart, [b]);
  }

  const out: PriceBar[] = [];
  for (const [start, group] of buckets) {
    if (group.length === 0) continue;
    const date = new Date(start * 1000).toISOString().replace("T", " ").slice(0, 19);
    out.push({ date, ...aggregate(group) });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Find the index of the latest bar in `bars` whose date is at or before
 * `asOf`. Used by multi-timeframe routing to align a higher-timeframe
 * series to the current primary-timeframe bar during backtest replay.
 *
 * Returns -1 when no bar qualifies (asOf is before the first bar).
 */
/**
 * Find the index of the latest COMPLETED daily bar as of `asOf` — i.e. the
 * last bar whose calendar day is strictly before asOf's day.
 *
 * `resampleToDaily` stamps bars at day START but fills them with the day's
 * FINAL close, so a same-day bar contains data up to ~24h in the future
 * relative to an intraday `asOf`. Aligning with `alignBarIndex` (date <=
 * asOf) therefore leaks the rest of the current day into daily_bias /
 * regime / ADX decisions (E2.24.a). Live scans never see this bar at all —
 * the OANDA fetch drops the forming daily candle — so completed-day
 * alignment is also what matches live behaviour.
 */
export function alignCompletedDailyIndex(bars: PriceBar[], asOf: string): number {
  const day = asOf.split(/[ T]/)[0];
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].date.split(/[ T]/)[0] < day) return i;
  }
  return -1;
}

export function alignBarIndex(bars: PriceBar[], asOf: string): number {
  const asOfMs = new Date(asOf).getTime();
  if (Number.isNaN(asOfMs)) return bars.length - 1;
  for (let i = bars.length - 1; i >= 0; i--) {
    const m = new Date(bars[i].date).getTime();
    if (!Number.isNaN(m) && m <= asOfMs) return i;
  }
  return -1;
}
