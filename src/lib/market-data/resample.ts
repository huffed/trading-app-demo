/**
 * Resample an intraday bar series to daily bars. Used by the backtest
 * engine to compute higher-timeframe context (daily-bias filter) without
 * a separate API fetch — we already have the 1h/4h bars, the D1 view is
 * a deterministic aggregation of them.
 *
 * Date keying uses the calendar day prefix `YYYY-MM-DD` of each bar's
 * timestamp, so it's correct for both daily bars (passes through) and
 * intraday bars regardless of timezone offset (we don't try to model
 * exchange-local trading days).
 */
import type { PriceBar } from "./types";

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
    let high = group[0].high;
    let low = group[0].low;
    let volume = 0;
    for (const b of group) {
      if (b.high > high) high = b.high;
      if (b.low < low) low = b.low;
      volume += b.volume;
    }
    out.push({
      date: day,
      open: group[0].open,
      high,
      low,
      close: group[group.length - 1].close,
      volume,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
