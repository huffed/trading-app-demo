/**
 * Phase E2 — list per-candidate passers from algorithms table.
 *
 * Companion to e2-post-sweep.sh. Reads SEARCH_NAME_LIKE env (defaults
 * to gold-only filter), queries algorithms, applies passesPerCandidate
 * from criteria.ts, prints one name per line to stdout. Stderr never
 * mixes with stdout so the bash orchestrator can capture cleanly.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";
import { passesPerCandidate } from "../../src/lib/algo-search/criteria";

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

const SEARCH_NAME_LIKE = process.env.SEARCH_NAME_LIKE ?? "Search: XAU/USD %";

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required");
    process.exit(1);
  }
  const sb = createClient(url, key);
  const { data, error } = await sb
    .from("algorithms")
    .select("name, backtest_results")
    .like("name", SEARCH_NAME_LIKE)
    .not("backtest_results", "is", null);
  if (error || !data) {
    console.error(`query failed: ${error?.message}`);
    process.exit(1);
  }
  for (const r of data) {
    if (passesPerCandidate(r.backtest_results as Parameters<typeof passesPerCandidate>[0])) {
      process.stdout.write(`${r.name}\n`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
