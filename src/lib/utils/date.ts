/**
 * Display-side date formatters. Centralised so we don't end up with five
 * different "Apr 28" formats across the app — the moment a designer tweaks
 * one, the rest drift.
 */

const SHORT_DATE_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

const LONG_DATE_FMT = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
});

const LONG_DATETIME_FMT = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const MONTH_YEAR_SHORT_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "2-digit",
});

/** Default locale's short date (e.g. "4/28/2026"). Used in tables and lists. */
export function formatDate(input: string | Date | null | undefined): string {
  if (!input) return "—";
  return new Date(input).toLocaleDateString();
}

/** "Apr 28" — chart axis labels and compact headers. */
export function formatShortDate(input: string | Date | null | undefined): string {
  if (!input) return "—";
  return SHORT_DATE_FMT.format(new Date(input));
}

/** "April 28, 2026" — page headers / detail views. */
export function formatLongDate(input: string | Date | null | undefined): string {
  if (!input) return "—";
  return LONG_DATE_FMT.format(new Date(input));
}

/** "Tuesday, April 28, 2026 at 3:30 PM" — journal entry headers. */
export function formatLongDateTime(input: string | Date | null | undefined): string {
  if (!input) return "—";
  return LONG_DATETIME_FMT.format(new Date(input));
}

/** "Apr 26" — chart axis labels grouped by year-month bucket. */
export function formatMonthYearShort(input: string | Date | null | undefined): string {
  if (!input) return "—";
  return MONTH_YEAR_SHORT_FMT.format(new Date(input));
}

export interface TodayAnchor {
  /** UTC midnight as ISO 8601 timestamp — for `closed_at >= ...` queries. */
  utcIso: string;
  /** UTC date as YYYY-MM-DD — for `String.startsWith()` filters on
   *  ISO timestamps (e.g. `exit_date.startsWith(today)`). */
  utcDate: string;
}

/**
 * Single source of truth for "today" semantics. Two callers had identical
 * `startOfTodayUtcIso()` copy-pastes (FTMO compliance + portfolio halt)
 * and a third re-derived a UTC date string inline — this consolidates
 * all three. UTC-anchored matches FTMO's day boundary; if user-local
 * "today" is ever needed, add a `localDate` field rather than swapping.
 */
export function getTodayAnchor(): TodayAnchor {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const utcIso = d.toISOString();
  return { utcIso, utcDate: utcIso.slice(0, 10) };
}
