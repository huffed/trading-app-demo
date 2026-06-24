/**
 * H.0 — Price-cache backward extension via OANDA practice API.
 *
 * Extends the EXISTING price_cache row for a (ticker, interval) by
 * fetching bars older than the current earliest cached bar. Idempotent +
 * non-destructive — newer bars stay; only earlier bars are PREPENDED.
 *
 * Why this exists (operator-facing): H.4a empirical FAILed all 6 label
 * variants on the v3 survivor — diagnosis was information density (~14K
 * bars of XAU/USD 4h is insufficient for the 48-feature xgboost model to
 * surface regime-stable signal). H.0 doubles the in-sample span to
 * ≥10yr (target ~25K bars at 4h, ~52K at 1h) before re-running H.4a.
 *
 * Method:
 *   1. Read existing price_cache row for (ticker, output_size='full', interval).
 *   2. Find earliest existing bar timestamp.
 *   3. If target_start_date ≥ earliest: nothing to do (cache already covers).
 *   4. Fetch (target_start_date → earliest_existing) from OANDA in 5000-bar
 *      chunks via cursor pagination.
 *   5. Merge: prepend fetched bars to existing; dedupe by timestamp.
 *   6. Validate: monotonic ascending dates; no overlap with existing range.
 *   7. Upsert back to price_cache (overwrite bars + bar_count + fetched_at).
 *
 * Resumable: if the script dies mid-fetch, re-running picks up from the
 * NEW earliest existing bar (which is now wherever the partial fetch
 * landed). No state needed outside the DB row.
 *
 * Usage:
 *   # 10yr extension on XAU/USD 4h (~6000 new bars from existing 14K)
 *   pnpm dlx tsx scripts/extend-price-cache.ts
 *
 *   # 6yr extension on XAU/USD 1h
 *   CACHE_TICKER=XAU/USD CACHE_INTERVAL=1h OANDA_INSTRUMENT=XAU_USD \
 *     OANDA_GRANULARITY=H1 TARGET_FROM_DATE=2020-01-01 \
 *     pnpm dlx tsx scripts/extend-price-cache.ts
 *
 * Env:
 *   OANDA_API_KEY              — practice token (REQUIRED)
 *   NEXT_PUBLIC_SUPABASE_URL   — Supabase URL (REQUIRED)
 *   SUPABASE_SERVICE_ROLE_KEY  — service-role key (REQUIRED)
 *   CACHE_TICKER               default "XAU/USD"
 *   CACHE_INTERVAL             default "4h"
 *   OANDA_INSTRUMENT           default "XAU_USD"
 *   OANDA_GRANULARITY          default "H4"   (one of M1/M5/M15/M30/H1/H4/D)
 *   TARGET_FROM_DATE           default "2016-01-01" (10yr target for 4h)
 *   CHUNK_BARS                 default 5000   (OANDA per-request max)
 *   CHUNK_SLEEP_MS             default 200    (between chunks; be nice to API)
 *   DRY_RUN                    default 0      (set 1 to fetch + report but not write)
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";

function loadEnvLocal(): void {
  try {
    const envText = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
    for (const line of envText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch { /* operator exports envs themselves */ }
}
loadEnvLocal();

const TOKEN = process.env.OANDA_API_KEY;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CACHE_TICKER = process.env.CACHE_TICKER ?? "XAU/USD";
const CACHE_INTERVAL = process.env.CACHE_INTERVAL ?? "4h";
const OANDA_INSTRUMENT = process.env.OANDA_INSTRUMENT ?? "XAU_USD";
const OANDA_GRANULARITY = process.env.OANDA_GRANULARITY ?? "H4";
const TARGET_FROM_DATE = process.env.TARGET_FROM_DATE ?? "2016-01-01";
const CHUNK_BARS = Number(process.env.CHUNK_BARS ?? "5000");
const CHUNK_SLEEP_MS = Number(process.env.CHUNK_SLEEP_MS ?? "200");
const DRY_RUN = process.env.DRY_RUN === "1";

function fail(msg: string): never {
  console.error(`[extend-price-cache] ${msg}`);
  process.exit(1);
}

if (!TOKEN) fail("OANDA_API_KEY not set");
if (!SUPABASE_URL || !SERVICE_KEY) {
  fail("NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required");
}

interface OandaCandle {
  complete: boolean;
  volume: number;
  time: string;
  mid: { o: string; h: string; l: string; c: string };
}

interface PriceBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function oandaToBar(c: OandaCandle): PriceBar {
  // Match the existing cache format: "YYYY-MM-DD HH:MM:SS" (UTC; no Z suffix)
  return {
    date: c.time.slice(0, 19).replace("T", " "),
    open: parseFloat(c.mid.o),
    high: parseFloat(c.mid.h),
    low: parseFloat(c.mid.l),
    close: parseFloat(c.mid.c),
    volume: c.volume,
  };
}

async function fetchChunkForward(fromIso: string, count: number): Promise<OandaCandle[]> {
  const url =
    `https://api-fxpractice.oanda.com/v3/instruments/${OANDA_INSTRUMENT}/candles` +
    `?granularity=${OANDA_GRANULARITY}&from=${encodeURIComponent(fromIso)}&count=${count}&price=M`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) {
    throw new Error(`OANDA HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { candles: OandaCandle[] };
  return data.candles;
}

function parseBarDateMs(d: string): number {
  // Existing cache format: "YYYY-MM-DD HH:MM:SS" → coerce to UTC ISO
  if (d.includes("T")) return new Date(d).getTime();
  return new Date(d.replace(" ", "T") + "Z").getTime();
}

/** Normalise a bar date to the canonical "YYYY-MM-DD HH:MM:SS" (UTC) form
 *  the rest of the codebase reads. Existing cache rows have inconsistent
 *  formats (some "YYYY-MM-DD HH:MM:SS", some ISO with .000Z) — dedup keys
 *  must be normalised or 254+ duplicates survive. */
function normaliseBarDate(d: string): string {
  const ms = parseBarDateMs(d);
  const iso = new Date(ms).toISOString();
  // "2024-01-01T00:00:00.000Z" → "2024-01-01 00:00:00"
  return iso.slice(0, 19).replace("T", " ");
}

function normaliseBar(b: PriceBar): PriceBar {
  return { ...b, date: normaliseBarDate(b.date) };
}

function isMonotonicAscending(bars: PriceBar[]): boolean {
  return findMonotonicViolation(bars) === null;
}

function findMonotonicViolation(bars: PriceBar[]): { idx: number; prev: PriceBar; cur: PriceBar } | null {
  for (let i = 1; i < bars.length; i++) {
    if (parseBarDateMs(bars[i].date) <= parseBarDateMs(bars[i - 1].date)) {
      return { idx: i, prev: bars[i - 1], cur: bars[i] };
    }
  }
  return null;
}

async function main(): Promise<void> {
  console.log(`[extend-price-cache] H.0 backward extension`);
  console.log(`  cache key  : ticker='${CACHE_TICKER}' interval='${CACHE_INTERVAL}'`);
  console.log(`  oanda      : ${OANDA_INSTRUMENT} ${OANDA_GRANULARITY}`);
  console.log(`  target     : ${TARGET_FROM_DATE} onward (backward extension)`);
  console.log(`  chunk size : ${CHUNK_BARS} bars`);
  console.log(`  dry run    : ${DRY_RUN}`);
  console.log("");

  const supabase = createClient(SUPABASE_URL as string, SERVICE_KEY as string, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Load existing cache row
  const { data: existing, error: readErr } = await supabase
    .from("price_cache")
    .select("bars, bar_count, fetched_at")
    .eq("ticker", CACHE_TICKER)
    .eq("output_size", "full")
    .eq("interval", CACHE_INTERVAL)
    .maybeSingle();
  if (readErr) fail(`Failed to load price_cache: ${readErr.message}`);

  const existingBars = (existing?.bars ?? []) as PriceBar[];
  console.log(`Existing cache: ${existingBars.length} bars`);
  if (existingBars.length > 0) {
    console.log(`  earliest : ${existingBars[0]?.date}`);
    console.log(`  latest   : ${existingBars[existingBars.length - 1]?.date}`);
  } else {
    console.log(`  (no existing cache — will create fresh)`);
  }

  // 2. Determine fetch range
  const targetFromMs = new Date(`${TARGET_FROM_DATE}T00:00:00Z`).getTime();
  const earliestExistingMs =
    existingBars.length > 0 ? parseBarDateMs(existingBars[0].date) : Number.POSITIVE_INFINITY;
  if (earliestExistingMs <= targetFromMs) {
    console.log("");
    console.log(`Cache already covers target start date (earliest=${existingBars[0]?.date} ≤ ${TARGET_FROM_DATE}).`);
    console.log(`No extension needed.`);
    return;
  }

  console.log("");
  console.log(`Fetching from ${TARGET_FROM_DATE} → ${existingBars[0]?.date ?? "(end)"} ...`);

  // 3. Cursor-paginated fetch FORWARD from target_from_date until we cross
  //    the earliest existing bar (then trim the overlap).
  const fetched: PriceBar[] = [];
  const seenTimes = new Set<string>();
  let cursorIso = `${TARGET_FROM_DATE}T00:00:00Z`;
  let chunkNum = 0;
  while (true) {
    chunkNum++;
    process.stdout.write(`  chunk ${chunkNum} from ${cursorIso} ... `);
    let candles: OandaCandle[];
    try {
      candles = await fetchChunkForward(cursorIso, CHUNK_BARS);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`error: ${msg}`);
      if (chunkNum === 1) fail(`first chunk failed; check API key + instrument: ${msg}`);
      console.log(`  (giving up at chunk ${chunkNum}; will write what we have)`);
      break;
    }
    if (candles.length === 0) {
      console.log(`empty (end of OANDA history)`);
      break;
    }
    let added = 0;
    let lastTimeMs = 0;
    let hitExistingRange = false;
    for (const c of candles) {
      if (!c.complete) continue;
      const tMs = new Date(c.time).getTime();
      if (tMs >= earliestExistingMs) {
        // Reached the overlap with existing cache — stop fetching
        hitExistingRange = true;
        break;
      }
      if (seenTimes.has(c.time)) continue;
      seenTimes.add(c.time);
      fetched.push(oandaToBar(c));
      added++;
      lastTimeMs = tMs;
    }
    console.log(`${candles.length} candles, ${added} new`);
    if (hitExistingRange) {
      console.log(`  reached existing-cache range — fetch complete`);
      break;
    }
    if (added === 0) {
      console.log(`  no progress — stopping`);
      break;
    }
    cursorIso = new Date(lastTimeMs + 1000).toISOString();
    await new Promise((r) => setTimeout(r, CHUNK_SLEEP_MS));
  }

  console.log("");
  console.log(`Fetched ${fetched.length} new bars`);
  if (fetched.length === 0) {
    console.log("Nothing to merge; exiting.");
    return;
  }
  console.log(`  earliest fetched : ${fetched[0].date}`);
  console.log(`  latest fetched   : ${fetched[fetched.length - 1].date}`);

  // 4. Merge: normalise all dates to canonical form first; THEN dedup +
  //    sort. Existing cache has mixed date formats (some ISO with .000Z,
  //    some "YYYY-MM-DD HH:MM:SS"); without normalisation the same
  //    timestamp appears as two distinct dedup keys and survives → 254+
  //    monotonic violations on real production cache.
  const allNormalised = [...fetched.map(normaliseBar), ...existingBars.map(normaliseBar)];
  const seen = new Set<string>();
  const deduped: PriceBar[] = [];
  let duplicatesDropped = 0;
  for (const b of allNormalised) {
    if (seen.has(b.date)) {
      duplicatesDropped++;
      continue;
    }
    seen.add(b.date);
    deduped.push(b);
  }
  if (duplicatesDropped > 0) {
    console.log(`  normalised ${duplicatesDropped} duplicate rows (mixed-format date strings collapsed)`);
  }
  // Re-sort to ensure ascending order (existing bars start where fetched ends)
  deduped.sort((a, b) => parseBarDateMs(a.date) - parseBarDateMs(b.date));

  console.log("");
  console.log(`Merged total: ${deduped.length} bars`);
  console.log(`  earliest : ${deduped[0].date}`);
  console.log(`  latest   : ${deduped[deduped.length - 1].date}`);

  // 5. Validate
  const violation = findMonotonicViolation(deduped);
  if (violation) {
    console.log("");
    console.log(`[diag] first monotonic violation at idx ${violation.idx}:`);
    console.log(`  prev: ${JSON.stringify(violation.prev)}`);
    console.log(`  cur : ${JSON.stringify(violation.cur)}`);
    // Count how many violations total
    let violations = 0;
    for (let i = 1; i < deduped.length; i++) {
      if (parseBarDateMs(deduped[i].date) <= parseBarDateMs(deduped[i - 1].date)) violations++;
    }
    console.log(`  total monotonic violations: ${violations}`);
    fail("MERGED BARS NOT MONOTONIC — refusing to write; investigate manually");
  }

  if (DRY_RUN) {
    console.log("");
    console.log(`DRY_RUN=1 — not writing to Supabase`);
    return;
  }

  // 6. Upsert
  const { error: writeErr } = await supabase.from("price_cache").upsert(
    {
      ticker: CACHE_TICKER,
      interval: CACHE_INTERVAL,
      output_size: "full",
      bars: deduped,
      bar_count: deduped.length,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "ticker,output_size,interval" },
  );
  if (writeErr) fail(`Supabase upsert failed: ${writeErr.message}`);

  console.log("");
  console.log(`✓ Wrote ${deduped.length} bars to price_cache (${CACHE_TICKER} ${CACHE_INTERVAL})`);
  const spanYears = (parseBarDateMs(deduped[deduped.length - 1].date) - parseBarDateMs(deduped[0].date)) / (365 * 86_400_000);
  console.log(`  span: ${spanYears.toFixed(2)} years`);
  // H.0 gates per ROADMAP: 4h ≥10yr; 1h ≥6yr; other intervals informational.
  if (CACHE_INTERVAL === "4h") {
    console.log(`  H.0 gate (4h ≥10yr): ${spanYears >= 10 ? "✓" : "⚠"}`);
  } else if (CACHE_INTERVAL === "1h") {
    console.log(`  H.0 gate (1h ≥6yr): ${spanYears >= 6 ? "✓" : "⚠"}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
