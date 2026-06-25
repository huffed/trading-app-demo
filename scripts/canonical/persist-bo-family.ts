/**
 * Persist a BO eval history JSON as an "BO+:" family in the algorithms
 * table — so the existing F2 robustness drivers (F2.1/F2.2/F2.3/F2.4) +
 * the F2.5 aggregate can run against the BO trial pool unchanged.
 *
 * Naming convention:
 *   Source:     "Search: XAU/USD AsianRangeBreak-Long 4h" (the BO base)
 *   Persisted:  "BO+: XAU/USD AsianRangeBreak-Long 4h | <variant_tag>"
 *
 *   The "BO+:" prefix is regex-compatible with the LayerB+ pattern in
 *   extractTicker (^(Search|LayerB\+?|BO\+?):) once drivers are patched.
 *
 * Each persisted row gets:
 *   - rules: base.rules + applyBoParams(bo_entry.params)
 *   - capital: from base
 *   - strategy_id: from base (preserves strategy linkage)
 *   - status: 'archived' (no scan, no live)
 *   - backtest_results: minimal struct with computed_at + per-trade Sharpe
 *
 * Idempotent: if BO+ rows for the family already exist, the script aborts
 * unless OVERWRITE=1 (which deletes the prior rows + reinserts).
 *
 * Usage:
 *   FAMILY_JSON=scripts/canonical/bo-results/Search_XAU_USD_AsianRangeBreak-Long_4h.json \
 *     pnpm dlx tsx scripts/canonical/persist-bo-family.ts
 *
 * Env:
 *   FAMILY_JSON   required — path to bo-search.ts output JSON
 *   OVERWRITE     default 0 — set 1 to drop + reinsert existing BO+ rows
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { applyBoParams } from "../../src/lib/algo-search/bayesian-optimization";
import type { Database } from "../../src/lib/supabase/database.types";
import type { AlgorithmRules } from "../../src/types/algorithm";

{
  try {
    const raw = readFileSync(".env.local", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.replace(/^['"]|['"]$/g, "");
    }
  } catch {}
}

interface BoEvalEntry {
  params: number[];
  objective: number;
  sharpe: number;
  variant_tag: string;
}
interface BoResultsFile {
  base_name: string;
  ticker: string;
  timeframe: string;
  bar_count: number;
  n_evals: number;
  eval_history: BoEvalEntry[];
}

async function main(): Promise<void> {
  const familyJson = process.env.FAMILY_JSON;
  if (!familyJson) throw new Error("FAMILY_JSON required (path to bo-results JSON)");
  const overwrite = process.env.OVERWRITE === "1";

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required");
  }
  const sb = createClient<Database>(url, key);

  const raw = readFileSync(familyJson, "utf8");
  const parsed = JSON.parse(raw) as BoResultsFile;
  const baseName = parsed.base_name;
  const familyBase = baseName.replace(/^Search:/, "BO+:");

  console.log(`Source: ${baseName}`);
  console.log(`Target family prefix: ${familyBase}`);
  console.log(`Variants in eval_history: ${parsed.eval_history.length}`);

  // Fetch base algo + watchlist (ticker lives on algorithm_watchlist)
  const { data: baseRow, error: baseErr } = await sb
    .from("algorithms")
    .select("id, name, rules, capital, strategy_id, user_id, asset_class, algorithm_watchlist(ticker)")
    .eq("name", baseName)
    .maybeSingle();
  if (baseErr || !baseRow) {
    throw new Error(`Base algo '${baseName}' not found: ${baseErr?.message ?? "row missing"}`);
  }
  const baseWatchlist = (baseRow.algorithm_watchlist ?? []) as { ticker: string }[];
  if (baseWatchlist.length === 0) {
    throw new Error(`Base algo has no watchlist ticker`);
  }
  const baseTicker = baseWatchlist[0].ticker;

  // Check for existing BO+ rows
  const { data: existing, error: exErr } = await sb
    .from("algorithms")
    .select("id, name")
    .like("name", `${familyBase} | %`);
  if (exErr) throw new Error(`Failed to query existing BO+ rows: ${exErr.message}`);
  if (existing && existing.length > 0) {
    if (!overwrite) {
      console.error(`${existing.length} BO+ rows already exist for '${familyBase}'. Set OVERWRITE=1 to replace.`);
      process.exit(1);
    }
    console.log(`Deleting ${existing.length} existing BO+ rows (OVERWRITE=1)...`);
    const ids = existing.map((r) => r.id);
    const { error: delErr } = await sb.from("algorithms").delete().in("id", ids);
    if (delErr) throw new Error(`Delete failed: ${delErr.message}`);
  }

  // Insert one row per BO eval — algorithm + watchlist (ticker lives there)
  const baseRules = baseRow.rules as unknown as AlgorithmRules;
  let inserted = 0;
  for (const entry of parsed.eval_history) {
    const rules = applyBoParams(baseRules, entry.params);
    const name = `${familyBase} | ${entry.variant_tag}`;
    const { data: insRow, error: insErr } = await sb
      .from("algorithms")
      .insert({
        user_id: baseRow.user_id,
        name,
        asset_class: baseRow.asset_class,
        strategy_id: baseRow.strategy_id,
        capital: baseRow.capital,
        status: "draft",
        rules: rules as unknown as Database["public"]["Tables"]["algorithms"]["Insert"]["rules"],
        backtest_results: {
          computed_at: new Date().toISOString(),
          source: "bo-search.ts",
          sharpe_per_trade_in_sample: entry.sharpe,
          bo_params: entry.params,
          bo_variant_tag: entry.variant_tag,
          bo_eval_objective: entry.objective,
        } as Database["public"]["Tables"]["algorithms"]["Insert"]["backtest_results"],
      })
      .select("id")
      .single();
    if (insErr || !insRow) {
      console.error(`Insert failed for ${entry.variant_tag}: ${insErr?.message}`);
      continue;
    }
    const { error: wlErr } = await sb
      .from("algorithm_watchlist")
      .insert({
        algorithm_id: insRow.id,
        user_id: baseRow.user_id,
        ticker: baseTicker,
        added_by: "ai",
      });
    if (wlErr) {
      console.error(`Watchlist insert failed for ${entry.variant_tag}: ${wlErr.message}`);
      continue;
    }
    inserted++;
  }
  console.log(`Persisted ${inserted}/${parsed.eval_history.length} BO+ rows`);

  // Identify + report the BO top variant by Sharpe (matches what F2 should target)
  const top = [...parsed.eval_history].sort((a, b) => b.sharpe - a.sharpe)[0];
  console.log("");
  console.log(`BO top variant by Sharpe:`);
  console.log(`  tag: ${top.variant_tag}`);
  console.log(`  sharpe: ${top.sharpe.toFixed(4)}`);
  console.log("");
  console.log(`Run F2 audit with:`);
  console.log(`  FAMILY_PATTERN='${familyBase} | %' SURVIVOR_TAG='${top.variant_tag}' \\`);
  console.log(`    pnpm dlx tsx scripts/canonical/robustness-bootstrap-bars.ts`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
