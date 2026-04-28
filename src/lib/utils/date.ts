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
