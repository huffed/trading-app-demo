/**
 * One-shot deploy: patches Algo D's (XAU/USD 1h momentum) persisted
 * dxy_filter config to use mode=block_neutral_only with the sweep-
 * winning params (24h lookback × 30pip threshold).
 *
 * Why these params: the inspect-algo overlay sweep (see PR #100) showed
 * that on Algo D's long corpus:
 *  - Baseline (no filter): 67t · 37.3% WR · $22,505 · 8.78% DD
 *  - 24h × 30pip overlay : 52t · 40.4% WR · $23,971 · 5.56% DD
 *  Pareto-dominates baseline on every metric. The whole 24h-lookback
 *  band reduces DD without major return damage, so this isn't a
 *  cherry-picked combo.
 *
 * Idempotent: dry-runs by default, prints the diff, requires APPLY=1
 * to actually write. Re-running with APPLY=1 after the row already
 * matches is a no-op.
 *
 * Prerequisite: PR #100 (feat/dxy-filter-modes) must be merged before
 * running with APPLY=1, otherwise the validator will reject the new
 * `mode` field on subsequent reads.
 *
 * Usage:
 *   pnpm dlx tsx scripts/deploy-algo-d-dxy.ts          # dry-run
 *   APPLY=1 pnpm dlx tsx scripts/deploy-algo-d-dxy.ts  # apply
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import type { AlgorithmRules } from "../src/types/algorithm";

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

// Algo D — Gold 1h Momentum Continuation. Captured here so the script
// is self-contained and re-runnable.
const ALGO_D_ID = "52cc7bc7-2a29-4062-b610-e9c34548f8a2";

const NEW_DXY_FILTER: NonNullable<AlgorithmRules["dxy_filter"]> = {
  enabled: true,
  mode: "block_neutral_only",
  lookback_hours: 24,
  pip_threshold: 30,
};

async function main(): Promise<void> {
  const apply = process.env.APPLY === "1" || process.env.APPLY === "true";

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: row, error } = await supabase
    .from("algorithms")
    .select("id, name, status, live_trading_enabled, rules")
    .eq("id", ALGO_D_ID)
    .single();
  if (error || !row) {
    throw new Error(`Could not fetch algo: ${error?.message ?? "not found"}`);
  }
  const algo = row as {
    id: string;
    name: string;
    status: string;
    live_trading_enabled: boolean;
    rules: AlgorithmRules;
  };

  console.log(`Algo: ${algo.name}`);
  console.log(`  id    : ${algo.id}`);
  console.log(`  status: ${algo.status} · live_trading_enabled=${algo.live_trading_enabled}`);
  console.log("");

  const before = algo.rules.dxy_filter;
  console.log("dxy_filter BEFORE:");
  console.log(before ? JSON.stringify(before, null, 2) : "  (unset)");
  console.log("");
  console.log("dxy_filter AFTER:");
  console.log(JSON.stringify(NEW_DXY_FILTER, null, 2));
  console.log("");

  // Idempotency check — bail early if already matches.
  const matches =
    before?.enabled === NEW_DXY_FILTER.enabled &&
    before?.mode === NEW_DXY_FILTER.mode &&
    before?.lookback_hours === NEW_DXY_FILTER.lookback_hours &&
    before?.pip_threshold === NEW_DXY_FILTER.pip_threshold;
  if (matches) {
    console.log("No change needed — rules.dxy_filter already matches target.");
    return;
  }

  if (!apply) {
    console.log("DRY RUN — no changes written. Re-run with APPLY=1 to apply.");
    return;
  }

  const newRules: AlgorithmRules = {
    ...algo.rules,
    dxy_filter: NEW_DXY_FILTER,
  };

  const { error: updErr } = await supabase
    .from("algorithms")
    .update({ rules: newRules })
    .eq("id", ALGO_D_ID);
  if (updErr) {
    throw new Error(`Update failed: ${updErr.message}`);
  }

  console.log("Applied. Subsequent scan ticks will pick up the new filter on next read.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
