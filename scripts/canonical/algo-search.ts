/**
 * Algorithm-search Layer A driver.
 *
 * Three modes via env:
 *   MODE=list  — enumerate + print + exit (no DB writes, no backtest)
 *   MODE=smoke — insert FIRST candidate as draft + invoke validate-algo
 *                on it ALONE + report (proves end-to-end wiring before
 *                committing to overnight sweep)
 *   MODE=full  — insert ALL candidates as draft + invoke validate-algo
 *                with ALGOS=<csv> + PERSIST=1 (~2-4h overnight wall clock)
 *
 * Default MODE=list (safe). Operator opts into smoke/full explicitly.
 *
 * Spec: scripts/canonical/algo-search.spec.md. The spec embodies the
 * meta-pre-registration commitment — any modification between sweeps
 * is git-visible. While a sweep is running it is treated as immutable.
 *
 * Why driver-then-invoke instead of in-driver-backtest: validate-algo.ts
 * is the canonical Phase B-fidelity-gated validator. Re-implementing its
 * statistical pipeline would create a second source of truth + every
 * future B.* fix would have to ship twice. Driver thinly wraps + invokes.
 *
 * Why insert-then-invoke instead of in-memory specs: validate-algo loads
 * algos from DB. Inserts use `status='draft'` so the rows are visible to
 * validate-algo but invisible to the scan engine. After Layer A sweep,
 * survivors transition to `draft → active` at the operator-stamp deploy
 * gate; non-survivor drafts can be swept via the SQL block in the spec.
 */
import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/lib/supabase/database.types";
import {
  CANDIDATE_NAME_PREFIX,
  enumerateLayerACandidates,
  type SearchCandidate,
} from "../../src/lib/algo-search/enumerate";
import {
  enumerateLayerBVariants,
  LAYER_B_NAME_PREFIX,
  layerBCardinality,
  type LayerBVariant,
} from "../../src/lib/algo-search/layer-b-enumerate";
import type { AlgorithmRules } from "../../src/types/algorithm";

// .env.local loader (mirrors validate-algo)
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

type Mode = "list" | "smoke" | "full" | "layer-b";
const MODE: Mode = ((): Mode => {
  const raw = (process.env.MODE ?? "list").toLowerCase();
  if (raw === "list" || raw === "smoke" || raw === "full" || raw === "layer-b") return raw;
  throw new Error(`Unknown MODE='${raw}'. Use 'list', 'smoke', 'full', or 'layer-b'.`);
})();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function requireEnv(): { url: string; key: string } {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error(
      "algo-search driver requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (preferred) " +
      "or NEXT_PUBLIC_SUPABASE_ANON_KEY (fallback) in .env.local."
    );
  }
  return { url: SUPABASE_URL, key: SUPABASE_SERVICE_KEY };
}

/** Resolve operator user_id from an existing algorithms row. Single-
 *  operator system; any existing row's user_id is THE user_id. Fails
 *  loudly if 0 rows exist (operator hasn't onboarded — the search pre-
 *  supposes an existing account). */
async function resolveOperatorId(supabase: SupabaseClient<Database>): Promise<string> {
  const { data, error } = await supabase
    .from("algorithms")
    .select("user_id")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to resolve user_id: ${error.message}`);
  if (!data) throw new Error("No existing algorithms rows; cannot infer operator user_id. Onboard first.");
  return data.user_id;
}

/** Generic interface satisfied by both Layer A SearchCandidate and Layer B
 *  LayerBVariant — the minimum surface insertCandidates + attachWatchlist
 *  need. Lets the helpers handle both namespaces. */
interface InsertableCandidate {
  name: string;
  ticker: string;
  capital: number;
  rules: AlgorithmRules;
}

async function loadExistingNamesByPrefix(
  supabase: SupabaseClient<Database>,
  prefix: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("algorithms")
    .select("name")
    .like("name", `${prefix}%`);
  if (error) throw new Error(`Failed to load existing ${prefix} rows: ${error.message}`);
  return new Set((data ?? []).map((r) => r.name));
}

async function insertCandidates(
  supabase: SupabaseClient<Database>,
  user_id: string,
  candidates: InsertableCandidate[],
  prefix: string,
): Promise<{ inserted: number; skipped: number }> {
  const existing = await loadExistingNamesByPrefix(supabase, prefix);
  const fresh = candidates.filter((c) => !existing.has(c.name));
  if (fresh.length === 0) return { inserted: 0, skipped: candidates.length };
  // Chunk to stay under Supabase row-payload size + RLS write limits.
  const CHUNK = 50;
  let inserted = 0;
  for (let i = 0; i < fresh.length; i += CHUNK) {
    const slice = fresh.slice(i, i + CHUNK);
    const rows = slice.map((c) => ({
      user_id,
      name: c.name,
      // RiskLevel is enum'd in DB. "moderate" is a safe neutral default;
      // doesn't affect scan or validate-algo (informational only).
      risk_level: "moderate" as const,
      asset_class: c.rules.asset_class as "commodity" | "forex",
      capital: c.capital,
      leverage: c.rules.leverage,
      status: "draft" as const,
      live_trading_enabled: false,
      broker_connection_id: null,
      rules: c.rules as unknown as Database["public"]["Tables"]["algorithms"]["Insert"]["rules"],
    }));
    const { error } = await supabase.from("algorithms").insert(rows);
    if (error) {
      throw new Error(
        `Failed to insert candidate chunk ${i}–${i + slice.length}: ${error.message}` +
        (error.details ? ` (details: ${error.details})` : "")
      );
    }
    inserted += slice.length;
  }
  return { inserted, skipped: existing.size };
}

async function attachWatchlist(
  supabase: SupabaseClient<Database>,
  user_id: string,
  candidates: InsertableCandidate[],
  prefix: string,
): Promise<number> {
  // validate-algo's loadAlgos does:
  //   const wl = await supabase.from("algorithm_watchlist").select("ticker").eq("algorithm_id", a.id).limit(1)
  //   algo.ticker = wl.data[0]?.ticker
  // → without a watchlist row, ticker is undefined → algo is EXCLUDED.
  // We attach exactly one row per candidate using the candidate's ticker.
  // Required NOT-NULL columns per schema: id (auto), user_id, algorithm_id,
  // ticker, name, added_by, created_at (auto), updated_at (auto), auto_paused
  // (default false).
  const { data: rows, error } = await supabase
    .from("algorithms")
    .select("id, name")
    .like("name", `${prefix}%`);
  if (error) throw new Error(`Failed to read inserted algos for watchlist attach: ${error.message}`);
  const idByName = new Map((rows ?? []).map((r) => [r.name, r.id] as const));
  type WlInsert = { user_id: string; algorithm_id: string; ticker: string; name: string; added_by: string };
  const wlRows: WlInsert[] = [];
  for (const c of candidates) {
    const id = idByName.get(c.name);
    if (!id) continue;
    wlRows.push({
      user_id,
      algorithm_id: id,
      ticker: c.ticker,
      // Per existing seeded rows, `name` mirrors the ticker (display label).
      name: c.ticker,
      // DB constraint: added_by ∈ {'user','ai','csv'}. Search candidates
      // are programmatically generated → 'ai' is the closest semantic.
      added_by: "ai",
    });
  }
  if (wlRows.length === 0) return 0;
  // Read existing watchlist to dedup (re-runs shouldn't create duplicates).
  const ids = wlRows.map((r) => r.algorithm_id);
  const { data: existing, error: e2 } = await supabase
    .from("algorithm_watchlist")
    .select("algorithm_id")
    .in("algorithm_id", ids);
  if (e2) throw new Error(`Failed to dedup watchlist: ${e2.message}`);
  const seen = new Set((existing ?? []).map((r) => r.algorithm_id));
  const fresh = wlRows.filter((r) => !seen.has(r.algorithm_id));
  if (fresh.length === 0) return 0;
  const CHUNK = 50;
  let inserted = 0;
  for (let i = 0; i < fresh.length; i += CHUNK) {
    const slice = fresh.slice(i, i + CHUNK);
    const { error: e3 } = await supabase.from("algorithm_watchlist").insert(slice);
    if (e3) throw new Error(`Failed to insert watchlist chunk: ${e3.message}`);
    inserted += slice.length;
  }
  return inserted;
}

/** validate-algo's loadAlgos uses Supabase `.in("name", [...])` which becomes
 *  a URL query parameter. Supabase's HTTP layer caps headers at ~16KB → with
 *  the long algo names we use here (~50 chars), the safe ceiling is ~150
 *  names per request. 100 leaves a comfortable margin and keeps per-batch
 *  wall clock manageable. */
const VALIDATE_ALGO_BATCH_SIZE = 100;

function runValidateAlgoBatch(opts: { algos: string[]; persist: boolean }): void {
  const algoCsv = opts.algos.join(",");
  // Spread process.env directly so Node's required ProcessEnv fields
  // (e.g. NODE_ENV) flow through. Overrides clobber any prior values.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ALGOS: algoCsv,
    PERSIST: opts.persist ? "1" : "0",
    // Force the canonical Phase B fidelity stack ON (defaults but explicit).
    SIBLINGS: "1",
    SPREAD_GATE: "1",
    RISK_POOL: "1",
    FTMO_TERMINATION: "1",
    RE_ENTRY_COOLDOWN: "1",
    PORTFOLIO_HALT: "1",
    BLOCK_BOOTSTRAP: "1",
    // Family α / N stays at validate-algo's defaults (α=0.05, N derived
    // from ALGOS_CSV cardinality). Under v2 spec, Bonferroni is informational
    // only (not a hard criterion), so per-batch N is acceptable.
  };
  const cmd = "pnpm dlx tsx scripts/canonical/validate-algo.ts";
  console.log(`\n>>> ${cmd} (ALGOS=${opts.algos.length} entries, PERSIST=${opts.persist ? "1" : "0"})\n`);
  execSync(cmd, { stdio: "inherit", env });
}

/** Public entrypoint: auto-batches into VALIDATE_ALGO_BATCH_SIZE chunks so
 *  Supabase's `.in()` URL stays under the ~16KB header limit. Callers don't
 *  need to know about the limit. Each batch is a separate validate-algo
 *  subprocess invocation. */
function runValidateAlgo(opts: { algos: string[]; persist: boolean }): void {
  if (opts.algos.length <= VALIDATE_ALGO_BATCH_SIZE) {
    runValidateAlgoBatch(opts);
    return;
  }
  const batches = Math.ceil(opts.algos.length / VALIDATE_ALGO_BATCH_SIZE);
  console.log(
    `\nALGOS=${opts.algos.length} exceeds per-batch ceiling (${VALIDATE_ALGO_BATCH_SIZE}); ` +
      `splitting into ${batches} batches to stay under Supabase URL header limit.`,
  );
  for (let i = 0; i < opts.algos.length; i += VALIDATE_ALGO_BATCH_SIZE) {
    const slice = opts.algos.slice(i, i + VALIDATE_ALGO_BATCH_SIZE);
    const batchNum = Math.floor(i / VALIDATE_ALGO_BATCH_SIZE) + 1;
    console.log(`\n--- Batch ${batchNum}/${batches} (${slice.length} algos) ---`);
    runValidateAlgoBatch({ algos: slice, persist: opts.persist });
  }
}

async function modeList(): Promise<void> {
  const candidates = enumerateLayerACandidates();
  console.log(`\n===== algo-search Layer A enumeration @ ${new Date().toISOString().slice(0, 16)} =====`);
  console.log(`Total candidates: ${candidates.length}`);
  console.log(`Bonferroni denominator (family N): ${candidates.length}`);
  console.log(`Per-test α at family α=0.05: ${(0.05 / candidates.length).toExponential(3)}`);

  // Tally by axis for quick sanity check.
  const byInst = new Map<string, number>();
  const byTf = new Map<string, number>();
  const byPattern = new Map<string, number>();
  const bySide = new Map<string, number>();
  for (const c of candidates) {
    byInst.set(c.ticker, (byInst.get(c.ticker) ?? 0) + 1);
    byTf.set(c.timeframe, (byTf.get(c.timeframe) ?? 0) + 1);
    byPattern.set(c.pattern, (byPattern.get(c.pattern) ?? 0) + 1);
    bySide.set(c.side, (bySide.get(c.side) ?? 0) + 1);
  }
  const fmt = (m: Map<string, number>): string =>
    [...m.entries()].sort().map(([k, v]) => `${k}=${v}`).join(", ");
  console.log(`\nBy instrument: ${fmt(byInst)}`);
  console.log(`By timeframe:  ${fmt(byTf)}`);
  console.log(`By side:       ${fmt(bySide)}`);
  console.log(`By pattern:\n${[...byPattern.entries()].sort().map(([k, v]) => `  ${k.padEnd(28)} ${v}`).join("\n")}`);

  console.log(`\nFirst 5 candidates:`);
  for (const c of candidates.slice(0, 5)) console.log(`  ${c.name}`);
  console.log(`Last 5 candidates:`);
  for (const c of candidates.slice(-5)) console.log(`  ${c.name}`);

  console.log(`\nNext: MODE=smoke pnpm dlx tsx scripts/canonical/algo-search.ts`);
  console.log(`(Inserts FIRST candidate as draft, invokes validate-algo, reports.)`);
}

async function modeSmoke(): Promise<void> {
  const { url, key } = requireEnv();
  const supabase = createClient<Database>(url, key);
  const candidates = enumerateLayerACandidates();
  const smoke = candidates[0];
  if (!smoke) throw new Error("Enumeration produced 0 candidates — investigate enumerate.ts.");

  console.log(`\n===== algo-search SMOKE @ ${new Date().toISOString().slice(0, 16)} =====`);
  console.log(`Smoke candidate: ${smoke.name}`);
  console.log(`  ticker=${smoke.ticker} tf=${smoke.timeframe} pattern=${smoke.pattern} side=${smoke.side}`);

  const user_id = await resolveOperatorId(supabase);
  console.log(`Resolved operator user_id: ${user_id}`);

  const { inserted, skipped } = await insertCandidates(supabase, user_id, [smoke], CANDIDATE_NAME_PREFIX);
  console.log(`Insert: ${inserted} new, ${skipped} skipped (already exist)`);

  const wlInserted = await attachWatchlist(supabase, user_id, [smoke], CANDIDATE_NAME_PREFIX);
  console.log(`Watchlist attach: ${wlInserted} new`);

  // Now invoke validate-algo on JUST this candidate.
  runValidateAlgo({ algos: [smoke.name], persist: false });

  const { data: row, error } = await supabase
    .from("algorithms")
    .select("id, status, rules")
    .eq("name", smoke.name)
    .maybeSingle();
  if (error) throw new Error(`Smoke read-back failed: ${error.message}`);
  if (!row) throw new Error(`Smoke row missing after insert — investigate.`);
  console.log(`\nSmoke row state: id=${row.id} status=${row.status}`);
  console.log(`\nSmoke complete. If validate-algo reported a verdict above, the wiring is live.`);
  console.log(`Next: MODE=full pnpm dlx tsx scripts/canonical/algo-search.ts (overnight Layer A sweep)`);
}

async function modeFull(): Promise<void> {
  const { url, key } = requireEnv();
  const supabase = createClient<Database>(url, key);
  const candidates = enumerateLayerACandidates();
  console.log(`\n===== algo-search FULL Layer A @ ${new Date().toISOString().slice(0, 16)} =====`);
  console.log(`Total candidates: ${candidates.length}`);

  const user_id = await resolveOperatorId(supabase);
  console.log(`Resolved operator user_id: ${user_id}`);

  const { inserted, skipped } = await insertCandidates(supabase, user_id, candidates, CANDIDATE_NAME_PREFIX);
  console.log(`Insert: ${inserted} new, ${skipped} skipped (already exist)`);

  const wlInserted = await attachWatchlist(supabase, user_id, candidates, CANDIDATE_NAME_PREFIX);
  console.log(`Watchlist attach: ${wlInserted} new`);

  // Invoke validate-algo on the full search set with PERSIST=1.
  // ALGOS=csv keeps the Bonferroni denominator honest (= cardinality of the search).
  runValidateAlgo({ algos: candidates.map((c) => c.name), persist: true });

  console.log(`\nFull Layer A sweep complete. Survivors visible via algorithms.backtest_results.promotion_eligible=true.`);
  console.log(`Next: build Layer B geometry sweep on survivors.`);
}

async function modeLayerB(): Promise<void> {
  const { url, key } = requireEnv();
  const supabase = createClient<Database>(url, key);

  // Input: BASE_NAMES env CSV of Layer A candidate names to sweep.
  const baseNames = (process.env.BASE_NAMES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (baseNames.length === 0) {
    throw new Error(
      "MODE=layer-b requires BASE_NAMES env CSV. Example: " +
      `BASE_NAMES="Search: XAU/USD BOS-Long 4h,Search: XAU/USD Sweep-Long 4h"`,
    );
  }
  const limit = Number(process.env.LIMIT ?? 0); // 0 = no limit; used for smoke runs.

  console.log(`\n===== algo-search Layer B @ ${new Date().toISOString().slice(0, 16)} =====`);
  console.log(`Base candidates requested: ${baseNames.length}`);

  // Fetch base candidates from DB (need rules + capital).
  const { data: baseRows, error } = await supabase
    .from("algorithms")
    .select("id, name, rules, capital")
    .in("name", baseNames);
  if (error) throw new Error(`Failed to fetch base candidates: ${error.message}`);
  if (!baseRows || baseRows.length === 0) {
    throw new Error(`No base candidates found in DB matching: ${baseNames.join(", ")}`);
  }
  if (baseRows.length !== baseNames.length) {
    const found = new Set(baseRows.map((r) => r.name));
    const missing = baseNames.filter((n) => !found.has(n));
    console.warn(`Missing in DB (skipped): ${missing.join(", ")}`);
  }

  // Each base's ticker comes from algorithm_watchlist (validate-algo source-of-truth).
  const baseIds = baseRows.map((b) => b.id);
  const { data: wls, error: wlErr } = await supabase
    .from("algorithm_watchlist")
    .select("algorithm_id, ticker")
    .in("algorithm_id", baseIds);
  if (wlErr) throw new Error(`Failed to fetch watchlists: ${wlErr.message}`);
  const tickerByAlgo = new Map((wls ?? []).map((w) => [w.algorithm_id, w.ticker]));

  // Enumerate variants per base (96 each per spec §2).
  const allVariants: LayerBVariant[] = [];
  for (const baseRow of baseRows) {
    const ticker = tickerByAlgo.get(baseRow.id);
    if (!ticker) {
      console.warn(`Base ${baseRow.name} has no watchlist entry — skipping all variants`);
      continue;
    }
    const variants = enumerateLayerBVariants({
      name: baseRow.name,
      ticker,
      capital: Number(baseRow.capital),
      rules: baseRow.rules as unknown as AlgorithmRules,
    });
    allVariants.push(...variants);
  }

  console.log(
    `Enumerated ${allVariants.length} variants (${baseRows.length} bases × ${layerBCardinality()} per spec §2).`,
  );

  let toInsert = allVariants;
  if (limit > 0) {
    toInsert = allVariants.slice(0, limit);
    console.log(`LIMIT=${limit} → smoke-mode: capping to first ${limit} variants.`);
  }

  const user_id = await resolveOperatorId(supabase);
  console.log(`Resolved operator user_id: ${user_id}`);

  const { inserted, skipped } = await insertCandidates(supabase, user_id, toInsert, LAYER_B_NAME_PREFIX);
  console.log(`Insert: ${inserted} new, ${skipped} skipped (already exist)`);

  const wlInserted = await attachWatchlist(supabase, user_id, toInsert, LAYER_B_NAME_PREFIX);
  console.log(`Watchlist attach: ${wlInserted} new`);

  // Invoke validate-algo on the variant set with PERSIST=1.
  // ALGOS=csv keeps validate-algo's Bonferroni denominator scoped to THIS
  // batch — under v2 spec, Bonferroni is informational anyway (the v2
  // criteria don't include it as a hard gate).
  runValidateAlgo({ algos: toInsert.map((v) => v.name), persist: true });

  console.log(
    `\nLayer B sweep complete. Inspect via: ` +
      `SELECT name, (backtest_results->'step2'->>'total_return')::numeric AS ret, ` +
      `(backtest_results->'statistical_rigor'->'mean_r_ci'->>'lower')::numeric AS r_lo ` +
      `FROM algorithms WHERE name LIKE '${LAYER_B_NAME_PREFIX}%' ORDER BY ret DESC LIMIT 20;`,
  );
}

async function main(): Promise<void> {
  console.log(`algo-search driver — MODE=${MODE}`);
  // Sanity-check spec exists (immutability lives in git but visibility helps).
  const specPath = "scripts/canonical/algo-search.spec.md";
  if (!existsSync(specPath)) {
    throw new Error(`Spec file ${specPath} missing — meta-pre-registration broken. ABORT.`);
  }
  if (MODE === "list") await modeList();
  else if (MODE === "smoke") await modeSmoke();
  else if (MODE === "layer-b") await modeLayerB();
  else await modeFull();
}

main().catch((e) => {
  console.error(`algo-search driver FAILED: ${e instanceof Error ? e.message : String(e)}`);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
