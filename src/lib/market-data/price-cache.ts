import { createAdminClient } from "@/lib/supabase/admin";
import { toJson } from "@/lib/supabase/row-mappers";
import type { BarInterval } from "./interval";
import type { PriceBar } from "./types";

/** DQ.1 fix (2026-06-19 EVE): canonical bar.date format is ISO 8601
 *  with Z suffix: `YYYY-MM-DDTHH:MM:SS[.sss]Z`. Providers emit a mix of:
 *   - OANDA (after legacy normalize): `YYYY-MM-DD HH:MM:SS` (space, no TZ)
 *   - Twelve Data: `YYYY-MM-DD HH:MM:SS` (space, UTC implied)
 *   - Yahoo daily: `YYYY-MM-DD` (date-only)
 *   - Yahoo intraday: full ISO + Z
 *   - Alpha Vantage: `YYYY-MM-DD` (date-only)
 *
 *  Space-separated dates parse as LOCAL TIME in V8, causing cross-format
 *  subtraction to drift by the host UTC offset (caught by the
 *  `hasReEntryCooldownActive` throw 2026-06-19 EVE). Normalising at the
 *  cache boundary (write + read for legacy rows) means every downstream
 *  consumer sees one canonical format and Date arithmetic is well-defined. */
export function normalizeBarDate(dateStr: string): string {
  // Already ISO with Z or explicit offset → leave alone.
  if (dateStr.includes("T") && (dateStr.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(dateStr))) {
    return dateStr;
  }
  // ISO but missing TZ marker → append Z (assume UTC, the documented contract).
  if (dateStr.includes("T")) {
    return dateStr + "Z";
  }
  // Date-only (YYYY-MM-DD) — daily bars from Yahoo / Alpha Vantage. Pad to
  // midnight UTC for consistency with intraday bars.
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr + "T00:00:00.000Z";
  }
  // Space-separated YYYY-MM-DD HH:MM:SS → ISO + Z (OANDA legacy, Twelve Data).
  // All providers that emit this format treat it as UTC (verified per source).
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(dateStr)) {
    return dateStr.replace(" ", "T") + "Z";
  }
  // Unrecognised — return as-is. Downstream Date parsing will surface the
  // issue rather than silently producing wrong arithmetic.
  return dateStr;
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
