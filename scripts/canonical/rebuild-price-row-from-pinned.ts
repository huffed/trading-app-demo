/**
 * Rebuild a live price_cache row from a pinned dataset file (E2.19, 2026-07-09).
 *
 * Why: the XAU/USD 4h full row was found polluted with hourly bars (a
 * fallback provider served 1h data under the 4h request on 2026-07-07/08)
 * plus a fetch-time partial bar at T14:31:23Z. Instant-level dedupe
 * (repair-price-cache-dupes.ts) cannot remove cross-granularity bars —
 * they are distinct instants. The clean rebuild source is the pinned
 * single-provider OANDA dataset (scripts/canonical/data/*-pinned.json).
 *
 * After rebuild, the DQ.3 median-spacing guard in
 * src/lib/market-data/price-cache.ts keeps future merges single-granularity.
 *
 * Usage:
 *   pnpm dlx tsx scripts/canonical/rebuild-price-row-from-pinned.ts                # XAU/USD 4h + 1day
 *   TICKER="XAU/USD" INTERVALS="4h,1day" pnpm dlx tsx scripts/canonical/rebuild-price-row-from-pinned.ts
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

const GRAN_BY_INTERVAL: Record<string, string> = { "4h": "h4", "1day": "d" };

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const ticker = process.env.TICKER ?? "XAU/USD";
  const intervals = (process.env.INTERVALS ?? "4h,1day").split(",").map((s) => s.trim());
  const sb = createClient<Database>(url, key);

  for (const interval of intervals) {
    const gran = GRAN_BY_INTERVAL[interval];
    if (!gran) throw new Error(`no pinned-file mapping for interval ${interval}`);
    const fname = `${ticker.replace("/", "-").toLowerCase()}-${gran}-pinned.json`;
    const path = resolve(process.cwd(), "scripts/canonical/data", fname);
    const { manifest, bars } = JSON.parse(readFileSync(path, "utf-8")) as {
      manifest: { bar_count: number; sha256: string; last_bar: string };
      bars: unknown[];
    };
    if (!Array.isArray(bars) || bars.length !== manifest.bar_count) {
      throw new Error(`${fname}: bar_count mismatch (${bars.length} vs manifest ${manifest.bar_count})`);
    }

    const { data: before } = await sb
      .from("price_cache")
      .select("id, bar_count")
      .eq("ticker", ticker.toUpperCase())
      .eq("interval", interval)
      .eq("output_size", "full")
      .maybeSingle();
    if (!before) throw new Error(`no price_cache row for ${ticker} ${interval} full`);

    const { error } = await sb
      .from("price_cache")
      .update({
        bars: bars as never,
        bar_count: bars.length,
        fetched_at: new Date().toISOString(),
      })
      .eq("id", before.id);
    if (error) throw new Error(`update failed: ${error.message}`);

    console.log(
      `✓ ${ticker} ${interval} full: ${before.bar_count} → ${bars.length} bars ` +
        `(pinned ${fname}, sha256 ${manifest.sha256.slice(0, 16)}…, last ${manifest.last_bar})`
    );
  }
  console.log("\nLive rows rebuilt from pinned single-provider data.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
