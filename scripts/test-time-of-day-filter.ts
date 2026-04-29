/**
 * Functional smoke test for the data-driven time-of-day filter.
 *
 * Walks per-hour stats for an algorithm, then runs `checkTimeOfDayFilter`
 * for each hour 0-23 to confirm the gate decisions match expectations:
 *   - Hours with samples < min_samples → status "no_data" → allow
 *   - Hours with samples ≥ min_samples AND WR < min_wr_pct → "blocked"
 *   - Hours with samples ≥ min_samples AND WR ≥ min_wr_pct → "allowed"
 *
 * Run: npx tsx scripts/test-time-of-day-filter.ts <algorithm_id>
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { checkTimeOfDayFilter } from "../src/lib/algorithm/time-of-day-filter";
import { getPerHourStats } from "../src/lib/scan/per-hour-stats";

// Minimal env loader
{
  try {
    const raw = readFileSync(".env.local", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.replace(/^['"]|['"]$/g, "");
    }
  } catch {
    /* ignore */
  }
}

const algoId = process.argv[2];
if (!algoId) {
  console.error("Usage: npx tsx scripts/test-time-of-day-filter.ts <algorithm_id>");
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

async function main() {
  console.log(`\n=== Per-hour stats (default min_samples=5) ===`);
  const defaultStats = await getPerHourStats(supabase, algoId);
  for (let h = 0; h < 24; h++) {
    const b = defaultStats.get(h)!;
    const tag = b.informative ? "INFORMATIVE" : "no-data    ";
    console.log(
      `  ${String(h).padStart(2, "0")}:00  samples=${String(b.samples).padStart(3)}  WR=${b.wr_pct.toFixed(1).padStart(5)}%  ${tag}`
    );
  }

  console.log(`\n=== Filter decisions at default config (min_wr_pct=45, min_samples=5) ===`);
  const config = { enabled: true };
  for (let h = 0; h < 24; h++) {
    const r = checkTimeOfDayFilter(config, defaultStats.get(h));
    if (r.status === "no_data") continue; // skip the noisy no-data ones
    console.log(`  ${String(h).padStart(2, "0")}:00  status=${r.status.padEnd(8)}  WR=${r.hour_wr_pct}%  ${r.reason ?? ""}`);
  }

  console.log(`\n=== Filter decisions at relaxed config (min_samples=1) ===`);
  const relaxedStats = await getPerHourStats(supabase, algoId, { min_samples: 1 });
  const relaxedConfig = { enabled: true, min_samples: 1, min_wr_pct: 45 };
  for (let h = 0; h < 24; h++) {
    const r = checkTimeOfDayFilter(relaxedConfig, relaxedStats.get(h));
    if (r.status === "no_data") continue;
    console.log(`  ${String(h).padStart(2, "0")}:00  status=${r.status.padEnd(8)}  WR=${r.hour_wr_pct}%  samples=${r.hour_samples}  ${r.reason ?? ""}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
