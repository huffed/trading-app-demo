/**
 * Phase E2 — list Layer B family representatives for per-candidate passers.
 *
 * Companion to e2-post-sweep.sh STEP 2. Reads per-candidate passer names
 * from stdin (one per line, "Search: ..." prefix), queries algorithms for
 * matching "LayerB: ..." rows, prints ONE representative LayerB row name
 * per family to stdout (revalidate-candidates auto-discovers the rest via
 * the " | " family pattern delimiter).
 *
 * Why a representative + auto-discovery (not all 96 rows per family):
 * revalidate-candidates already does the family-level walk + DSR pool
 * construction. Passing all 96 names would duplicate work.
 *
 * Naming convention (from layer-b-enumerate.ts geometryTag):
 *   Search:  "Search: <ticker> <pattern>-<dir> <tf>"
 *   LayerB:  "LayerB: <ticker> <pattern>-<dir> <tf> | <geometry-tag>"
 * Family-pattern split is the " | " delimiter; revalidate-candidates uses
 * the left-of-pipe portion to enumerate siblings.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

function loadEnvLocal(): void {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.replace(/^['"]|['"]$/g, "");
    }
  } catch { /* operator exports envs */ }
}
loadEnvLocal();

function searchToLayerBBase(searchName: string): string {
  // "Search: XAU/USD AsianRangeBreak-Long 4h" → "LayerB: XAU/USD AsianRangeBreak-Long 4h"
  return searchName.replace(/^Search:/, "LayerB:");
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required");
    process.exit(1);
  }
  const sb = createClient(url, key);

  const stdin = readFileSync(0, "utf8");
  const passers = stdin.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (passers.length === 0) {
    console.error("no passer names on stdin");
    process.exit(1);
  }

  const seenFamilies = new Set<string>();
  for (const passerName of passers) {
    const layerBBase = searchToLayerBBase(passerName);
    if (seenFamilies.has(layerBBase)) continue;
    seenFamilies.add(layerBBase);

    const { data, error } = await sb
      .from("algorithms")
      .select("name")
      .like("name", `${layerBBase} | %`)
      .limit(1);
    if (error) {
      console.error(`query failed for ${layerBBase}: ${error.message}`);
      continue;
    }
    if (!data || data.length === 0) {
      console.error(`no LayerB rows for family: ${layerBBase}`);
      continue;
    }
    process.stdout.write(`${data[0].name}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
