/**
 * E2.23 — Layer A sweep of the 30m + 1h gold cells on PINNED data.
 *
 * The last unsearched gold frontier: these cells were pre-registered in the
 * Phase E universe but their only prior evaluation ran on the corrupted
 * merge-built cache (E2.19). This is their first verdict-grade pass.
 *
 * Method (locked): every `Search: XAU/USD *-<dir> <tf>` row + daily_bias
 * (bullish for Long / bearish for Short), evaluated solo (fidelity gates
 * OFF, Layer-A-comparable) at RISK=0.66% (current deployment risk — the
 * CHOCH-Long lesson: evaluate at the risk you would deploy). Operator bar:
 * n≥30, WR≥37, static DD≤10, daily DD≤5, pnl>0. Doji excluded by spec.
 * Passers feed Layer B (e2.22 harness with TF param) → sibling-aware
 * portfolio test vs the live 4-algo before any deploy decision.
 *
 * Usage:
 *   TF=1h  DIRECTION=Long  pnpm dlx tsx scripts/canonical/e2.23-intraday-layer-a.ts
 *   TF=30m DIRECTION=Short pnpm dlx tsx scripts/canonical/e2.23-intraday-layer-a.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { runPortfolioBacktest } from "../../src/lib/market-data/portfolio-backtest";
import type { Database } from "../../src/lib/supabase/database.types";
import type { AlgorithmRules, EntryCondition } from "../../src/types/algorithm";
import { loadPinnedBars, POOL_CAPITAL, soloStats, type SoloStats } from "./lib/pinned-eval";

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

const TF = process.env.TF ?? "1h";
const DIRECTION = (process.env.DIRECTION ?? "Long") as "Long" | "Short";
const RISK = Number(process.env.RISK ?? "0.66");
const GRAN_BY_TF: Record<string, string> = { "1h": "h1", "30m": "m30" };

async function main(): Promise<void> {
  const gran = GRAN_BY_TF[TF];
  if (!gran) throw new Error(`TF must be 1h or 30m, got ${TF}`);
  const { bars, sha256 } = loadPinnedBars("XAU/USD", gran);
  console.log(`E2.23 Layer A — ${TF} ${DIRECTION} @${RISK}% on pinned ${bars.length} bars (sha ${sha256.slice(0, 12)}… VERIFIED)`);
  const priceMap = new Map([["XAU/USD", bars]]);

  const sb = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: rows } = await sb
    .from("algorithms")
    .select("id, name, rules")
    .like("name", `Search: XAU/USD %-${DIRECTION} ${TF}`);
  if (!rows || rows.length === 0) throw new Error(`no Search rows for ${DIRECTION} ${TF}`);

  const results: Array<{ id: string; label: string; excluded: boolean; stats: SoloStats }> = [];
  for (const row of rows.sort((a, b) => a.name.localeCompare(b.name))) {
    const m = row.name.match(/^Search: XAU\/USD (.+?)-(Long|Short) /);
    if (!m) continue;
    const pattern = m[1];
    const base = row.rules as unknown as AlgorithmRules;
    const hasBias = base.entry_conditions.some((c) => (c as { pattern?: string }).pattern === "daily_bias");
    const rules: AlgorithmRules = {
      ...base,
      entry_conditions: hasBias
        ? base.entry_conditions
        : [
            ...base.entry_conditions,
            {
              type: "pattern",
              pattern: "daily_bias",
              direction: DIRECTION === "Long" ? "bullish" : "bearish",
              ma_period: 20,
              timeframe: "1d",
            } as EntryCondition,
          ],
      entry_logic: "all",
      position_sizing: { ...base.position_sizing, type: "risk_per_trade", value: RISK },
    };
    const res = runPortfolioBacktest(rules, priceMap, POOL_CAPITAL);
    const stats = soloStats(res.trades ?? []);
    const excluded = pattern === "Doji";
    results.push({ id: row.id, label: `${pattern}-${DIRECTION} ${TF}`, excluded, stats });
    const flag = excluded ? "excl" : stats.passes_operator_bar ? "✓ PASS" : "✗";
    console.log(
      `  ${`${pattern}-${DIRECTION}`.padEnd(24)} n=${String(stats.trades).padStart(4)} WR=${stats.wr.toFixed(1).padStart(5)}% ` +
        `DD=${stats.static_dd_pct.toFixed(2).padStart(5)}% dDD=${stats.daily_dd_pct.toFixed(2).padStart(4)}% ` +
        `pnl=$${stats.total_pnl.toFixed(0).padStart(6)} mo=${stats.monthly_pct.toFixed(2).padStart(5)}% ${flag}`
    );
  }
  const passers = results.filter((r) => !r.excluded && r.stats.passes_operator_bar);
  console.log(`\nPassers: ${passers.length}/${results.filter((r) => !r.excluded).length} → ${passers.map((p) => p.label).join(" | ") || "(none)"}`);
  const out = resolve(process.cwd(), `scripts/canonical/e2-results/e2.23-layera-${TF}-${DIRECTION.toLowerCase()}-2026-07-11.json`);
  writeFileSync(out, JSON.stringify({ tf: TF, direction: DIRECTION, risk: RISK, pinned_sha256: sha256, computed_at: new Date().toISOString(), results }, null, 1));
  console.log(`→ ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
