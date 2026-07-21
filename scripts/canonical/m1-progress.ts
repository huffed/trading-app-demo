/**
 * M1 progress CLI — terminal view of the G.8 gate comparator (shares
 * `src/lib/cohort/m1-evidence.ts` with the /reports M1 tab, same
 * CLI↔UI split as cohort-report).
 *
 * Usage: pnpm dlx tsx scripts/canonical/m1-progress.ts
 *
 * Reads with the service-role client (operator CLI, no session). The
 * gate: 30 closed paper trades with cumulative mean per-trade R within
 * ±30% of the pinned-corpus baseline (see m1-baseline.ts provenance).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { buildM1Evidence } from "../../src/lib/cohort/m1-evidence";

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

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const fmtR = (r: number | null): string =>
  r === null ? "—" : `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`;
const fmtPct = (v: number | null): string => (v === null ? "—" : `${v.toFixed(1)}%`);

async function main(): Promise<void> {
  const supabase = createClient(url!, serviceKey!, { auth: { persistSession: false } });
  const ev = await buildM1Evidence(supabase);

  console.log("=== M1 EVIDENCE — G.8 gate comparator ===\n");
  console.log(
    `Progress: ${ev.closed_trades}/${ev.gate.min_trades} closed trades` +
      ` (${ev.open_positions} open, ${ev.excluded_rows} excluded)` +
      `  |  clock start ${ev.clock_start.slice(0, 10)}`
  );
  console.log(
    `Realized mean R: ${fmtR(ev.realized_mean_r)} (WR ${fmtPct(ev.realized_win_rate_pct)})` +
      `  vs baseline ${fmtR(ev.baseline_mean_r)} (WR ${fmtPct(ev.baseline_wr_pct)})`
  );
  console.log(
    `PASS band: ${ev.band.lower_r.toFixed(4)}–${ev.band.upper_r.toFixed(4)}R` +
      (ev.tracking_ratio !== null
        ? `  |  tracking ${(ev.tracking_ratio * 100).toFixed(0)}% of baseline — ${ev.in_band ? "IN band" : "OUTSIDE band"}`
        : "")
  );
  console.log(`Status: ${ev.status.toUpperCase()}\n`);

  const pad = (s: string, n: number): string => s.padEnd(n);
  console.log(
    pad("algorithm", 44) + "closed".padStart(7) + "open".padStart(6) + "meanR".padStart(8) + "WR%".padStart(7) + "baseR".padStart(8)
  );
  console.log("-".repeat(80));
  for (const a of ev.per_algo) {
    console.log(
      pad(a.algorithm_name.replace(/^Deploy: /, "").slice(0, 43), 44) +
        String(a.closed_trades).padStart(7) +
        String(a.open_positions).padStart(6) +
        (a.mean_r === null ? "—" : a.mean_r.toFixed(2)).padStart(8) +
        (a.win_rate_pct === null ? "—" : a.win_rate_pct.toFixed(0)).padStart(7) +
        (a.baseline === null ? "—" : a.baseline.mean_r.toFixed(2)).padStart(8)
    );
  }

  if (ev.trades.length > 0) {
    console.log("\nRecent trades (newest first):");
    for (const t of ev.trades.slice(0, 15)) {
      console.log(
        `  ${t.opened_at.slice(0, 16).replace("T", " ")}  ${t.side.padEnd(5)} ` +
          `${(t.status === "open" ? "open" : fmtR(t.r_multiple)).padStart(7)}  ` +
          `risk ${t.risk_pct_at_entry === null ? "—" : t.risk_pct_at_entry.toFixed(2) + "%"}  ` +
          `${t.algorithm_name.replace(/^Deploy: /, "").slice(0, 34)}  ${t.exit_reason ?? ""}`
      );
    }
  } else {
    console.log("\nNo paper positions since the evidence clock started.");
  }
}

main().catch((err) => {
  console.error("m1-progress failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
