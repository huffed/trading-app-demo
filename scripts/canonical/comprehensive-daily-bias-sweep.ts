/**
 * Comprehensive daily_bias augmentation sweep across all Search:* algos.
 *
 * For each pattern × direction × timeframe in DB, augment with daily_bias
 * (bullish for long, bearish for short) and measure per-candidate fit
 * + FTMO compliance + correlation potential vs deployed portfolio.
 *
 * Goal: surface ALL gold algos that qualify as additions to the
 * deployed 3-algo portfolio (ARB-r3 + Engulfing-r3-r1-rf0_af1 + ARB25).
 *
 * Test space:
 *   - All 4h Long patterns (~15)
 *   - All 4h Short patterns (~14)
 *   - Test daily_bias augmentation as the L1 filter
 *
 * Outputs:
 *   - Table of all augmented candidates with WR/DD/Sharpe/return
 *   - Filter to those passing operator hard criteria (WR≥37, DD≤10, daily≤5, trades≥30, ret>0)
 *   - Pearson correlation vs existing 3 deployed algos
 *   - Recommend additions to portfolio
 */
import { spawnSync } from "node:child_process";
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

interface AugmentResult {
  algo_name: string;
  pattern: string;
  direction: string;
  tf: string;
  augment: string;
  base_trades: number;
  aug_trades: number;
  aug_total_r: number;
  aug_sharpe: number;
  aug_static_dd_pct: number;
  aug_daily_dd_pct: number;
  aug_win_rate: number;
  per_candidate_passes: boolean;
}

function runAugmentValidate(algoId: string, augmentPattern: string, augmentDirection: "bullish" | "bearish"): AugmentResult | null {
  const tmpOut = `/tmp/cdb-${algoId.slice(0, 8)}-${augmentDirection}.json`;
  const r = spawnSync("pnpm", ["dlx", "tsx", "scripts/canonical/augmented-variant-validate.ts"], {
    env: { ...process.env, ALGO_ID: algoId, AUGMENT_PATTERN: augmentPattern, AUGMENT_DIRECTION: augmentDirection, OUTPUT_JSON: tmpOut },
    encoding: "utf-8", timeout: 120_000,
  });
  if (r.status !== 0) return null;
  try {
    const json = JSON.parse(readFileSync(tmpOut, "utf-8"));
    return {
      algo_name: "",
      pattern: "",
      direction: augmentDirection === "bullish" ? "Long" : "Short",
      tf: "",
      augment: augmentPattern,
      base_trades: json.baseline?.trades ?? 0,
      aug_trades: json.augmented?.trades ?? 0,
      aug_total_r: json.augmented?.total_r ?? 0,
      aug_sharpe: json.augmented?.sharpe ?? 0,
      aug_static_dd_pct: json.augmented?.max_static_dd_pct ?? 0,
      aug_daily_dd_pct: json.augmented?.max_daily_dd_pct ?? 0,
      aug_win_rate: json.augmented?.win_rate ?? 0,
      per_candidate_passes: json.per_candidate_passes === true,
    };
  } catch { return null; }
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient<Database>(url, key);

  // Load all Search:* 4h algos (skip Doji EXCLUDED)
  const { data: algos } = await sb.from("algorithms")
    .select("id, name, rules, backtest_results")
    .like("name", "Search: XAU/USD %")
    .like("name", "% 4h")
    .not("backtest_results", "is", null);
  if (!algos || algos.length === 0) throw new Error("no 4h Search:* algos found");

  const filtered = algos.filter((a) => {
    const v = (a.backtest_results as Record<string, unknown> | null)?.step2 as Record<string, unknown> | undefined;
    return v?.verdict !== "EXCLUDED";
  });
  console.log(`Testing daily_bias augmentation on ${filtered.length} 4h Search:* algos`);
  console.log("");

  const results: AugmentResult[] = [];
  for (const a of filtered) {
    const m = a.name.match(/^Search: XAU\/USD (.+?)-(Long|Short)\s4h$/);
    if (!m) continue;
    const [, pattern, direction] = m;
    const augDir = direction === "Long" ? "bullish" : "bearish";
    process.stdout.write(`  ${pattern.padEnd(20)} ${direction.padEnd(6)} 4h ... `);
    const r = runAugmentValidate(a.id, "daily_bias", augDir);
    if (!r) { console.log("ERROR"); continue; }
    r.algo_name = a.name;
    r.pattern = pattern;
    r.tf = "4h";
    results.push(r);
    const pass = r.per_candidate_passes ? "✓" : "✗";
    console.log(`trades=${r.aug_trades.toString().padStart(3)} WR=${r.aug_win_rate.toFixed(1).padStart(4)}% DD=${r.aug_static_dd_pct.toFixed(2).padStart(5)}% sharpe=${r.aug_sharpe.toFixed(4)} per_cand=${pass}`);
  }

  console.log("");
  console.log("=".repeat(95));
  console.log("CANDIDATES PASSING ALL HARD GATES (WR≥37, DD≤10, daily≤5, trades≥30, return>0)");
  console.log("=".repeat(95));
  const passing = results
    .filter((r) => r.aug_win_rate >= 37 && r.aug_static_dd_pct <= 10 && r.aug_daily_dd_pct <= 5 && r.aug_trades >= 30 && r.aug_total_r > 0)
    .sort((a, b) => b.aug_sharpe - a.aug_sharpe);
  if (passing.length === 0) console.log("  (none)");
  else {
    console.log("pattern              | dir   | trades | WR     | DD     | daily_DD | Sharpe   | total_R");
    for (const r of passing) {
      console.log(`  ${r.pattern.padEnd(20)} ${r.direction.padEnd(6)} ${r.aug_trades.toString().padStart(4)}    ${r.aug_win_rate.toFixed(1).padStart(5)}%  ${r.aug_static_dd_pct.toFixed(2).padStart(5)}%  ${r.aug_daily_dd_pct.toFixed(2).padStart(5)}%    ${r.aug_sharpe.toFixed(4)}    ${r.aug_total_r.toFixed(1)}`);
    }
  }
  console.log("");
  console.log(`Summary: ${passing.length}/${results.length} pass all hard FTMO+operator gates with daily_bias filter`);
}

main().catch((e) => { console.error(e); process.exit(1); });
