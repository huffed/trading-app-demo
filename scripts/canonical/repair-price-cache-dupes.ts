/**
 * One-shot repair for duplicate-instant bars in price_cache (DQ.2, 2026-07-09).
 *
 * Root cause: pre-fix `normalizeBarDate` passed any `T…Z` string through
 * untouched, so OANDA nanosecond ISO ("…T21:00:00.000000000Z") and
 * Twelve Data normalised ISO ("…T21:00:00Z") never collided in
 * savePricesToCache's dedupe Map. Measured damage (2026-07-09):
 *   - XAU/USD 4h full: 11,169 bars / 8,838 distinct instants (62 dupes in
 *     the live 200-bar evaluation window)
 *   - XAU/USD 1day full: 15,032 bars over ~19.6yr (~2.9× true count)
 *
 * This script rewrites EVERY price_cache row: canonicalise all bar dates
 * (same logic as the fixed src/lib/market-data/price-cache.ts), dedupe by
 * canonical instant — preferring the OANDA-format payload on conflict
 * (OANDA is the provider-chain head, so its OHLC matches what live fetches
 * return) — and sort ascending. `fetched_at` is left untouched (data is
 * not fresher, just cleaner).
 *
 * Usage:
 *   pnpm dlx tsx scripts/canonical/repair-price-cache-dupes.ts            # dry-run
 *   APPLY=1 pnpm dlx tsx scripts/canonical/repair-price-cache-dupes.ts   # write
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/lib/supabase/database.types";

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
  } catch {}
}
loadEnvLocal();

interface Bar {
  date: string;
  [k: string]: unknown;
}

/** Inlined copy of src/lib/market-data/price-cache.ts#normalizeBarDate
 *  (post-DQ.2 version) — inlined so this repair script has zero path-alias
 *  dependencies. Keep in sync if the canonical format ever changes. */
function normalizeBarDate(dateStr: string): string {
  let iso = dateStr;
  if (!iso.includes("T")) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      iso = iso + "T00:00:00Z";
    } else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(iso)) {
      iso = iso.replace(" ", "T") + "Z";
    } else {
      return dateStr;
    }
  } else if (!(iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso))) {
    iso = iso + "Z";
  }
  const ms = Date.parse(iso.replace(/\.(\d{3})\d+(?=Z|[+-])/, ".$1"));
  if (!Number.isFinite(ms)) return dateStr;
  return new Date(ms).toISOString();
}

const isOandaFormat = (d: string): boolean => /\.\d{4,}Z$/.test(d);

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const apply = process.env.APPLY === "1";
  const sb = createClient<Database>(url, key);

  const { data: rows, error } = await sb
    .from("price_cache")
    .select("id, ticker, interval, output_size, bars");
  if (error || !rows) throw new Error(`read failed: ${error?.message}`);

  console.log(`${apply ? "APPLY" : "DRY-RUN"} — ${rows.length} price_cache rows\n`);
  let touched = 0;
  for (const row of rows) {
    const bars = row.bars as unknown as Bar[];
    if (!Array.isArray(bars) || bars.length === 0) continue;

    const byInstant = new Map<string, Bar>();
    let conflicts = 0;
    for (const b of bars) {
      const canonical = normalizeBarDate(b.date);
      const existing = byInstant.get(canonical);
      if (existing) {
        conflicts++;
        // Prefer the OANDA-format payload (provider-chain head) on conflict;
        // otherwise later occurrence wins (matches merge "newer wins").
        if (isOandaFormat(existing.date) && !isOandaFormat(b.date)) continue;
      }
      byInstant.set(canonical, { ...b, date: canonical });
    }
    const repaired = Array.from(byInstant.values()).sort((a, b) =>
      a.date.localeCompare(b.date)
    );

    const changed = repaired.length !== bars.length || conflicts > 0 ||
      bars.some((b, i) => repaired[i]?.date !== b.date);
    const label = `${row.ticker} ${row.interval} ${row.output_size}`.padEnd(30);
    console.log(
      `  ${label} ${String(bars.length).padStart(6)} → ${String(repaired.length).padStart(6)} bars` +
      `  (dupes removed: ${bars.length - repaired.length}, changed: ${changed})`
    );
    if (!changed || !apply) continue;

    const { error: upErr } = await sb
      .from("price_cache")
      .update({
        bars: repaired as never,
        bar_count: repaired.length,
      })
      .eq("id", row.id);
    if (upErr) throw new Error(`update ${label} failed: ${upErr.message}`);
    touched++;
  }
  console.log(`\n${apply ? `Rewrote ${touched} rows.` : "Dry-run only — re-run with APPLY=1 to write."}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
