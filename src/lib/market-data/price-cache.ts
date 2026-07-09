import { createAdminClient } from "@/lib/supabase/admin";
import { toJson } from "@/lib/supabase/row-mappers";
import { intervalMinutes, type BarInterval } from "./interval";
import type { PriceBar } from "./types";

/** DQ.1 fix (2026-06-19 EVE) + DQ.2 fix (2026-07-09): canonical bar.date
 *  format is fixed-width ISO 8601 UTC — exactly `Date.prototype.toISOString`
 *  output (`YYYY-MM-DDTHH:MM:SS.sssZ`). Providers emit a mix of:
 *   - OANDA: `YYYY-MM-DDTHH:MM:SS.000000000Z` (nanosecond ISO + Z)
 *   - Twelve Data: `YYYY-MM-DD HH:MM:SS` (space, UTC implied)
 *   - Yahoo daily: `YYYY-MM-DD` (date-only)
 *   - Yahoo intraday: full ISO + Z
 *   - Alpha Vantage: `YYYY-MM-DD` (date-only)
 *
 *  Space-separated dates parse as LOCAL TIME in V8, causing cross-format
 *  subtraction to drift by the host UTC offset (caught by the
 *  `hasReEntryCooldownActive` throw 2026-06-19 EVE).
 *
 *  DQ.2: the DQ.1 version passed ANY `T…Z` string through untouched, so
 *  OANDA's nanosecond format and Twelve Data's normalised `…T21:00:00Z`
 *  never collided in savePricesToCache's dedupe Map — the row accumulated
 *  one bar per provider format per instant (2026-07-09 forensics: XAU/USD
 *  4h full row held 11,169 bars across only 8,838 distinct instants, with
 *  62 duplicates inside the live 200-bar evaluation window; the 1d row was
 *  ~2.9× its true bar count). Every recognised format is now funnelled
 *  through parse → re-emit so one instant maps to exactly one string. */
export function normalizeBarDate(dateStr: string): string {
  let iso = dateStr;
  if (!iso.includes("T")) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      // Date-only (YYYY-MM-DD) — daily bars from Yahoo / Alpha Vantage.
      iso = iso + "T00:00:00Z";
    } else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(iso)) {
      // Space-separated → ISO + Z (Twelve Data, OANDA legacy). All providers
      // that emit this format treat it as UTC (verified per source).
      iso = iso.replace(" ", "T") + "Z";
    } else {
      // Unrecognised — return as-is. Downstream Date parsing will surface
      // the issue rather than silently producing wrong arithmetic.
      return dateStr;
    }
  } else if (!(iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso))) {
    // ISO but missing TZ marker → append Z (assume UTC, documented contract).
    iso = iso + "Z";
  }
  // Canonicalise: truncate sub-millisecond fractions (spec-shaped input for
  // Date.parse), then re-emit fixed-width. Explicit-offset inputs collapse
  // to their UTC instant, which also makes lexicographic sort == time sort.
  const ms = Date.parse(iso.replace(/\.(\d{3})\d+(?=Z|[+-])/, ".$1"));
  if (!Number.isFinite(ms)) return dateStr;
  return new Date(ms).toISOString();
}

/** DQ.3 (2026-07-09): median spacing between consecutive bars, in minutes.
 *  Median (not mean) is robust to weekend/session gaps: a legitimate 4h
 *  series medians 240min even across weekend gaps; hourly pollution
 *  medians 60min. Null when fewer than 3 bars (nothing to measure). */
export function medianSpacingMinutes(bars: PriceBar[]): number | null {
  if (bars.length < 3) return null;
  const gaps: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const a = Date.parse(bars[i - 1].date);
    const b = Date.parse(bars[i].date);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) gaps.push((b - a) / 60_000);
  }
  if (gaps.length === 0) return null;
  gaps.sort((x, y) => x - y);
  return gaps[Math.floor(gaps.length / 2)];
}

function normalizeBars(bars: PriceBar[]): PriceBar[] {
  let needsCopy = false;
  for (const b of bars) {
    if (normalizeBarDate(b.date) !== b.date) {
      needsCopy = true;
      break;
    }
  }
  if (!needsCopy) return bars;
  return bars.map((b) => ({ ...b, date: normalizeBarDate(b.date) }));
}

// Daily bars refresh once per market day, intraday bars far more often.
// Tighter TTL on intraday so live signals don't act on stale data.
//
// Daily TTL extended 2026-05-04 from 23h → 7d. Rationale: 23h forced
// a re-fetch every weekend (cache invalid after Friday close + weekend),
// and when fetch fails (rate limit / API hiccup) the engine falls back
// to resampleToDaily(timeframe_bars) which produces <21 daily bars on
// 30m algos, breaking regime detection. 7-day TTL means slightly stale
// daily structure (acceptable for 14-bar regime calc) but cache always
// hits, eliminating the weekly cache-miss + fetch-fail cascade. Real
// fix is incremental cache refresh (only fetch the new daily bars and
// append) — queued as follow-up.
const DAILY_TTL_HOURS = 24 * 7;
const INTRADAY_TTL_HOURS = 1;

/** Hard cap on bars kept per (ticker, output_size, interval) row. Live
 *  fetches are 5000 bars; OANDA backfills run to ~28K on 30m / multi-year.
 *  100K is generous headroom (~50yr of 4h, ~6yr of 30m, ~2yr of 15m) and
 *  keeps the JSONB row under ~10MB. On overflow, oldest bars are dropped
 *  — recent history is what live trading and recent-window backtests
 *  actually read; multi-year backtests can re-run the OANDA backfill if
 *  they need older bars. */
const MAX_BARS_PER_ROW = 100_000;

export async function getCachedPrices(
  ticker: string,
  outputSize: string,
  interval: BarInterval = "1day"
): Promise<PriceBar[] | null> {
  // Use the admin client for reads too — the cache is global, and the
  // cron HTTP path has no auth session (would hit the RLS deny branch
  // on every tick). The "read-for-authenticated" RLS policy is kept as
  // defense-in-depth for any future call site that opts back into the
  // user-scoped server client.
  const supabase = createAdminClient();
  const ttlHours = interval === "1day" ? DAILY_TTL_HOURS : INTRADAY_TTL_HOURS;
  const cutoff = new Date(Date.now() - ttlHours * 60 * 60 * 1000).toISOString();

  const { data } = await supabase
    .from("price_cache")
    .select("bars")
    .eq("ticker", ticker.toUpperCase())
    .eq("output_size", outputSize)
    .eq("interval", interval)
    .gte("fetched_at", cutoff)
    .limit(1)
    .single();

  const row = data as { bars: PriceBar[] } | null;
  if (!row) return null;
  // DQ.1: normalise on read so legacy rows (stored in mixed formats
  // before the 2026-06-19 EVE fix) appear canonical to consumers.
  return normalizeBars(row.bars);
}

/**
 * Merge `newBars` into the existing cached row by date — newer wins on
 * overlap, oldest dropped on overflow.
 *
 * Why: the unique key `(ticker, output_size, interval)` is shared across
 * the OANDA deep-history backfill (~28K bars on 30m) and the live cron's
 * Twelve Data fetch (5000 bars). A naive overwrite-upsert truncated the
 * deep tail every time the cron rehydrated the cache, silently destroying
 * the multi-year corpus the validation harnesses depend on. Merge-on-write
 * makes the cache append-only at the tail while still letting live writes
 * refresh the head.
 *
 * Writes go through the service-role admin client so the cron path
 * (which has no auth session) can refresh the cache. Reads stay on the
 * authenticated server client so the operator's UI flows hit the same
 * RLS-gated read policy as everywhere else. Two round-trips per write —
 * fine because every caller fires this off the hot path
 * (`.catch(() => {})` after returning a response).
 */
export async function savePricesToCache(
  ticker: string,
  outputSize: string,
  bars: PriceBar[],
  interval: BarInterval = "1day"
): Promise<void> {
  // CB.H3.b (2026-06-20): DB types ARE generated now (CB.C3); the prior
  // "doesn't generate DB types yet" comment was stale. Use the typed
  // admin client directly.
  const supabase = createAdminClient();
  const tickerUpper = ticker.toUpperCase();

  // Read the existing JSONB so we can merge against it. Skip the
  // fetched_at filter — even an "expired" row's bars are valid data we
  // want to retain. The TTL is for getCachedPrices' staleness check,
  // not for write-side correctness.
  const { data: existing } = await supabase
    .from("price_cache")
    .select("bars")
    .eq("ticker", tickerUpper)
    .eq("output_size", outputSize)
    .eq("interval", interval)
    .maybeSingle();

  const existingRow = existing as { bars: PriceBar[] } | null;
  const existingBars = existingRow?.bars ?? [];

  // Dedupe by date string. Map insertion order is preserved, so we seed
  // with the existing bars (oldest → newest) and overlay the new ones —
  // any matching date keeps the newer payload (in case the API revised
  // a recently-printed bar).
  //
  // DQ.1: normalise BOTH sides before dedup so a legacy space-format
  // date and a new ISO+Z date for the same bar instant collapse to one
  // entry (otherwise dedup would miss the match and the cache would
  // grow unbounded as duplicates pile up).
  const existingNorm = normalizeBars(existingBars);
  const incomingNorm = normalizeBars(bars);

  // DQ.3 (2026-07-09): reject cross-granularity pollution. The provider
  // fallback chain can serve finer-grained bars under a coarser interval
  // request (observed 2026-07-07/08: hourly bars merged into the XAU/USD
  // 4h full row, plus a fetch-time partial bar at T14:31:23Z — live "4h"
  // pattern evaluation ran over 1h candles for two days). A polluted merge
  // is silent and self-compounding; a rejected write only costs one
  // refresh cycle and the staleness gate handles the fallout downstream.
  const medianMin = medianSpacingMinutes(incomingNorm);
  const expectedMin = intervalMinutes(interval);
  if (medianMin !== null && medianMin < 0.75 * expectedMin) {
    console.warn(
      `[price-cache] REJECTED ${tickerUpper} ${interval} cache write: incoming ` +
        `median bar spacing ${medianMin}min < 0.75× expected ${expectedMin}min — ` +
        `cross-granularity pollution (provider served finer bars than requested)`
    );
    return;
  }

  const byDate = new Map<string, PriceBar>();
  for (const b of existingNorm) byDate.set(b.date, b);
  for (const b of incomingNorm) byDate.set(b.date, b);

  const merged = Array.from(byDate.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  // Cap. JSONB row stays bounded even on degenerate fetches (e.g. a
  // bug that calls saveToCache with a per-bar interval). Drop oldest
  // since callers + harness both read recent-tail-first.
  const capped =
    merged.length > MAX_BARS_PER_ROW
      ? merged.slice(merged.length - MAX_BARS_PER_ROW)
      : merged;

  await supabase.from("price_cache").upsert(
    {
      ticker: tickerUpper,
      output_size: outputSize,
      interval,
      // PriceBar isn't structurally Json (no string-index signature). Route
      // through the canonical toJson<T> bridge so the JSONB-domain mismatch
      // is centralised at row-mappers.ts. CB.H3.b 2026-06-20.
      bars: toJson(capped),
      bar_count: capped.length,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "ticker,output_size,interval" }
  );
}
