/**
 * Time-of-day / day-of-week features. All in UTC (bar.date is UTC ISO
 * per project convention). Session boundaries are operator-facing
 * approximations of the major FX sessions, not exact exchange clocks.
 */
import type { Feature } from "./types";

function utcDate(bars: Parameters<Feature["compute"]>[0], idx: number): Date | null {
  const s = bars[idx]?.date;
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

const f_hour_of_day_utc: Feature = {
  name: "hour_of_day_utc",
  category: "time",
  description: "UTC hour of bar timestamp (0..23)",
  compute: (bars, idx) => {
    const d = utcDate(bars, idx);
    return d ? d.getUTCHours() : null;
  },
};

const f_day_of_week: Feature = {
  name: "day_of_week",
  category: "time",
  description: "UTC day of week (0=Sun, 1=Mon, ..., 6=Sat)",
  compute: (bars, idx) => {
    const d = utcDate(bars, idx);
    return d ? d.getUTCDay() : null;
  },
};

/** Asian session UTC approx: 00:00–08:00 (Tokyo open–London open). */
const f_is_asian_session: Feature = {
  name: "is_asian_session",
  category: "time",
  description: "1 if bar hour UTC is in Asian session (00:00–08:00), else 0",
  compute: (bars, idx) => {
    const d = utcDate(bars, idx);
    if (!d) return null;
    const h = d.getUTCHours();
    return h >= 0 && h < 8 ? 1 : 0;
  },
};

/** US session UTC approx: 13:30–20:00 (NY open–NY close, post-DST). */
const f_is_us_session: Feature = {
  name: "is_us_session",
  category: "time",
  description: "1 if bar hour UTC is in US session (13:30–20:00 approx), else 0",
  compute: (bars, idx) => {
    const d = utcDate(bars, idx);
    if (!d) return null;
    const h = d.getUTCHours();
    const m = d.getUTCMinutes();
    const minutesFromMidnight = h * 60 + m;
    return minutesFromMidnight >= 13 * 60 + 30 && minutesFromMidnight < 20 * 60 ? 1 : 0;
  },
};

export const TIME_FEATURES: readonly Feature[] = [
  f_hour_of_day_utc,
  f_day_of_week,
  f_is_asian_session,
  f_is_us_session,
];
