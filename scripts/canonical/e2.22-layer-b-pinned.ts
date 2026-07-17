/**
 * E2.22 — Layer B geometry sweep on PINNED data for the E2.20 passers.
 *
 * Scope (pre-registered BEFORE first run):
 *   - Patterns: OutsideBar-Long (deployed 2026-07-11 at BASELINE geometry,
 *     zero live trades → geometry swap is free churn), BOS-Long +
 *     Engulfing-Long (rejected as additions on DD/correlation — geometry
 *     may move DD; correlation is expected pattern-structural).
 *   - The live trio's geometry is OUT OF SCOPE (swapping resets their G.7
 *     demo-evidence clocks; the pre-registered G.8 gate is their arbiter).
 *
 * Grid: the real Layer B enumerator (src/lib/algo-search/layer-b-enumerate):
 *   RR{2,2.5,3,5} × LB{3,4,6} × RISK{0.6,1.0} × RF{0,1} × AF{0,1} = 96,
 *   applied to (Search base rules + daily_bias bullish) — the deployable form.
 *
 * SELECTION RULES (locked):
 *   S1  Operator bar applies to the r06 leg of each geometry (deploy-adjacent
 *       risk): n≥30, WR≥37, DD≤10, dDD≤5, pnl>0.
 *   S1b Fragility screen (CHOCH-Long lesson): |WR(r06) − WR(r10)| < 2.5pp,
 *       else rejected regardless of S1.
 *   S2  OutsideBar upgrade: top-3 passers by monthly(r06) → exact 4-algo
 *       SIBLING-AWARE verify @0.66% uniform (variant replaces the deployed
 *       baseline). SWAP iff avgRet > 3.25%/challenge AND worstML ≤ 8.7%
 *       AND 0 breaches AND worstDL ≤ 5 (current exact: 3.25 / 8.45 / 0).
 *   S3  BOS/Engulfing addition: best passer per pattern with solo DD(r06) ≤ 8
 *       → exact 5-algo sibling-aware @0.60% uniform vs the post-S2 4-algo.
 *       ADD iff |ρ|max < 0.40 vs all four AND 0 breaches AND worstML ≤ 8.7%
 *       AND return beats the 4-algo at ML-matched risk.
 *   S4  Any live change goes through the zombie deploy protocol.
 *
 * Usage:
 *   MODE=grid PATTERN="OutsideBar-Long" pnpm dlx tsx scripts/canonical/e2.22-layer-b-pinned.ts
 *   MODE=verify pnpm dlx tsx scripts/canonical/e2.22-layer-b-pinned.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { enumerateLayerBVariants, type LayerBVariant } from "../../src/lib/algo-search/layer-b-enumerate";
import {
  runPortfolioBacktest,
  tradesAsSiblingWindows,
  type PortfolioHaltConfig,
  type RiskPoolConfig,
  type RunPortfolioBacktestOptions,
  type SiblingTradeWindow,
  type SpreadGateConfig,
} from "../../src/lib/market-data/portfolio-backtest";
import type { Database } from "../../src/lib/supabase/database.types";
import type { BacktestTrade, PriceBar } from "../../src/lib/market-data/types";
import type { AlgorithmRules, EntryCondition } from "../../src/types/algorithm";
import { dailySeries, loadPinnedBars, pearson, POOL_CAPITAL, soloStats, stressTest, type SoloStats, type StressResult } from "./lib/pinned-eval";

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

const PATTERN_IDS: Record<string, string> = {
  "OutsideBar-Long": "fb82095d-3e1a-4722-9fee-c216ea5a78b4",
  "BOS-Long": "4bf95df3-63fb-4893-89a9-53aecc6dbe1c",
  "Engulfing-Long": "02c1892f-a765-4ed8-8d5d-86329392d110",
};
/** E2.23 extension: TF env (default 4h). Non-4h base rows are looked up by
 *  name (`Search: XAU/USD <pattern> <tf>`); grid output files carry the TF. */
const TF = process.env.TF ?? "4h";
const GRAN_BY_TF: Record<string, string> = { "4h": "h4", "1h": "h1", "30m": "m30" };
const TRIO_IDS = [
  "069813f1-2a80-48e7-a086-5bf22c05e300", // ARB rr3_lb3
  "daff0052-824a-4cd4-a43c-7fd177fe8513", // Engulfing rr3_lb6
  "85d421e6-bcc9-40b5-9ee4-be1e7d6fea03", // ARB rr25_lb3
];
const DEPLOYED_OB_ID = "6cea13b6-86fb-41f6-9f2c-6bef47541a6a";
const RESULTS_DIR = "scripts/canonical/e2-results";
const gridPath = (pattern: string): string =>
  resolve(
    process.cwd(),
    TF === "4h"
      ? `${RESULTS_DIR}/e2.22-layerb-${pattern.toLowerCase()}-2026-07-11.json`
      : `${RESULTS_DIR}/e2.23-layerb-${pattern.toLowerCase()}-${TF}-2026-07-11.json`
  );

function withDailyBias(base: AlgorithmRules, direction: "bullish" | "bearish" = "bullish"): AlgorithmRules {
  const hasBias = base.entry_conditions.some((c) => (c as { pattern?: string }).pattern === "daily_bias");
  return {
    ...base,
    entry_conditions: hasBias
      ? base.entry_conditions
      : [
          ...base.entry_conditions,
          { type: "pattern", pattern: "daily_bias", direction, ma_period: 20, timeframe: "1d" } as EntryCondition,
        ],
    entry_logic: "all",
  };
}

interface GridRow {
  tag: string;
  risk: number;
  stats: SoloStats;
}

async function fetchRules(sb: SupabaseClient<Database>, id: string): Promise<AlgorithmRules> {
  const { data } = await sb.from("algorithms").select("rules").eq("id", id).maybeSingle();
  if (!data) throw new Error(`algo ${id} not found`);
  return data.rules as unknown as AlgorithmRules;
}

async function fetchRulesByName(sb: SupabaseClient<Database>, name: string): Promise<AlgorithmRules> {
  const { data } = await sb.from("algorithms").select("rules").eq("name", name).maybeSingle();
  if (!data) throw new Error(`algo "${name}" not found`);
  return data.rules as unknown as AlgorithmRules;
}

async function runGrid(sb: SupabaseClient<Database>, bars: PriceBar[], pattern: string): Promise<void> {
  const baseId = TF === "4h" ? PATTERN_IDS[pattern] : null;
  if (TF === "4h" && !baseId) throw new Error(`unknown pattern ${pattern}; expected one of ${Object.keys(PATTERN_IDS).join(", ")}`);
  const baseRaw = baseId
    ? await fetchRules(sb, baseId)
    : await fetchRulesByName(sb, `Search: XAU/USD ${pattern} ${TF}`);
  const isShort = /-Short$/.test(pattern);
  const base = withDailyBias(baseRaw, isShort ? "bearish" : "bullish");
  const variants: LayerBVariant[] = enumerateLayerBVariants({
    name: `Search: XAU/USD ${pattern} ${TF}`,
    ticker: "XAU/USD",
    capital: POOL_CAPITAL,
    rules: base,
  });
  console.log(`Grid: ${pattern} ${TF} + daily_bias — ${variants.length} variants on pinned data`);
  const priceMap = new Map([["XAU/USD", bars]]);
  const rows: GridRow[] = [];
  for (const v of variants) {
    const res = runPortfolioBacktest(v.rules, priceMap, POOL_CAPITAL);
    rows.push({ tag: v.variant_tag, risk: v.geometry.risk_per_trade_pct, stats: soloStats(res.trades ?? []) });
  }
  // Fragility pairing: same geometry, r06 vs r10 leg.
  const byGeom = new Map<string, { r06?: GridRow; r10?: GridRow }>();
  for (const r of rows) {
    const key = r.tag.replace(/_r(06|1)_/, "_r*_");
    const slot = byGeom.get(key) ?? {};
    if (r.risk === 0.6) slot.r06 = r;
    else slot.r10 = r;
    byGeom.set(key, slot);
  }
  const passers: Array<GridRow & { wr_delta: number }> = [];
  for (const { r06, r10 } of byGeom.values()) {
    if (!r06 || !r10) continue;
    const wrDelta = Math.abs(r06.stats.wr - r10.stats.wr);
    if (r06.stats.passes_operator_bar && wrDelta < 2.5) passers.push({ ...r06, wr_delta: wrDelta });
  }
  passers.sort((a, b) => b.stats.monthly_pct - a.stats.monthly_pct);
  console.log(`Passers (S1 bar @r06 + S1b fragility |ΔWR|<2.5pp): ${passers.length}/48 geometries`);
  for (const p of passers.slice(0, 10)) {
    console.log(
      `  ${p.tag.padEnd(24)} n=${String(p.stats.trades).padStart(3)} WR=${p.stats.wr.toFixed(1)}% ` +
      `DD=${p.stats.static_dd_pct.toFixed(2)}% dDD=${p.stats.daily_dd_pct.toFixed(2)}% ` +
      `pnl=$${p.stats.total_pnl.toFixed(0)} mo=${p.stats.monthly_pct.toFixed(2)}% ΔWR=${p.wr_delta.toFixed(1)}pp`
    );
  }
  writeFileSync(gridPath(pattern), JSON.stringify({ pattern, computed_at: new Date().toISOString(), rows, passers }, null, 1));
  console.log(`→ ${gridPath(pattern)}`);
}

interface Member {
  label: string;
  rules: AlgorithmRules;
}

async function runSiblingAware(members: Member[], bars: PriceBar[], uniformRisk: number): Promise<{ union: BacktestTrade[]; perMember: Array<{ label: string; solo: number; aware: number }>; soloTrades: Map<string, BacktestTrade[]> }> {
  const priceMap = new Map([["XAU/USD", bars]]);
  const riskDollars = POOL_CAPITAL * (uniformRisk / 100);
  const atRisk = (m: Member): AlgorithmRules => ({
    ...m.rules,
    position_sizing: { ...m.rules.position_sizing, type: "risk_per_trade", value: uniformRisk },
  });
  const soloTrades = new Map<string, BacktestTrade[]>();
  for (const m of members) {
    const res = runPortfolioBacktest(atRisk(m), priceMap, POOL_CAPITAL);
    soloTrades.set(m.label, res.trades ?? []);
  }
  const spreadGate: SpreadGateConfig = { enabled: true, threshold_multiplier: 2.5, atr_lookback_bars: 200 };
  const union: BacktestTrade[] = [];
  const perMember: Array<{ label: string; solo: number; aware: number }> = [];
  for (const m of members) {
    let sibWindows: SiblingTradeWindow[] = [];
    const sibDaily: Record<string, number> = {};
    for (const other of members) {
      if (other.label === m.label) continue;
      const ot = soloTrades.get(other.label)!;
      sibWindows = sibWindows.concat(tradesAsSiblingWindows(ot, riskDollars));
      for (const t of ot) {
        const day = t.exit_date.slice(0, 10);
        sibDaily[day] = (sibDaily[day] ?? 0) + t.pnl;
      }
    }
    const riskPool: RiskPoolConfig = { enabled: true, pool_cap_pct: 4, reference_capital: POOL_CAPITAL };
    const portfolioHalt: PortfolioHaltConfig = { enabled: true, daily_loss_limit_pct: 5, reference_capital: POOL_CAPITAL, sibling_daily_pnl: sibDaily };
    const opts: RunPortfolioBacktestOptions = {
      siblingBlockingTrades: sibWindows,
      riskPoolSiblings: sibWindows,
      riskPool,
      portfolioHalt,
      reEntryCooldown: { enabled: true },
      spreadGate,
    };
    const res = runPortfolioBacktest(atRisk(m), priceMap, POOL_CAPITAL, opts);
    const trades = res.trades ?? [];
    union.push(...trades);
    perMember.push({ label: m.label, solo: soloTrades.get(m.label)!.length, aware: trades.length });
  }
  return { union, perMember, soloTrades };
}

function loadGrid(pattern: string): { passers: Array<GridRow & { wr_delta: number }> } {
  return JSON.parse(readFileSync(gridPath(pattern), "utf-8")) as { passers: Array<GridRow & { wr_delta: number }> };
}

function fmt(name: string, s: StressResult): string {
  return `  ${name.padEnd(46)} windows=${s.windows} breach=${s.fail_ml + s.fail_dl} worstML=${s.worst_ml.toFixed(2)}% worstDL=${s.worst_dl.toFixed(2)}% avgRet=${s.avg_return_pct.toFixed(2)}% pass=${((s.pass / Math.max(1, s.windows)) * 100).toFixed(1)}%`;
}

async function runVerify(sb: SupabaseClient<Database>, bars: PriceBar[]): Promise<void> {
  const trio: Member[] = [];
  const labels = ["ARB rr3_lb3", "Engulfing rr3_lb6", "ARB rr25_lb3"];
  for (let i = 0; i < TRIO_IDS.length; i++) {
    trio.push({ label: labels[i], rules: withDailyBias(await fetchRules(sb, TRIO_IDS[i])) });
  }
  const deployedOb: Member = { label: "OutsideBar (deployed baseline)", rules: await fetchRules(sb, DEPLOYED_OB_ID) };
  const obBase = withDailyBias(await fetchRules(sb, PATTERN_IDS["OutsideBar-Long"]));

  console.log("=== BASELINE: current 4-algo @0.66 (exact, sibling-aware) ===");
  const baseRun = await runSiblingAware([...trio, deployedOb], bars, 0.66);
  const baseStress = stressTest(baseRun.union);
  console.log(fmt("trio + deployed OutsideBar", baseStress));

  console.log("\n=== S2: OutsideBar geometry candidates (top-3 by monthly @r06) ===");
  const obPassers = loadGrid("OutsideBar-Long").passers.slice(0, 3);
  const obVariants: LayerBVariant[] = enumerateLayerBVariants({ name: "Search: XAU/USD OutsideBar-Long 4h", ticker: "XAU/USD", capital: POOL_CAPITAL, rules: obBase });
  let bestSwap: { tag: string; stress: StressResult } | null = null;
  for (const p of obPassers) {
    const variant = obVariants.find((v) => v.variant_tag === p.tag);
    if (!variant) continue;
    const run = await runSiblingAware([...trio, { label: `OB ${p.tag}`, rules: variant.rules }], bars, 0.66);
    const s = stressTest(run.union);
    console.log(fmt(`trio + OB ${p.tag}`, s));
    const passesS2 = s.fail_ml + s.fail_dl === 0 && s.worst_ml <= 8.7 && s.worst_dl <= 5 && s.avg_return_pct > baseStress.avg_return_pct;
    if (passesS2 && (!bestSwap || s.avg_return_pct > bestSwap.stress.avg_return_pct)) bestSwap = { tag: p.tag, stress: s };
  }
  console.log(bestSwap
    ? `S2 VERDICT: SWAP deployed OutsideBar → ${bestSwap.tag} (avgRet ${bestSwap.stress.avg_return_pct.toFixed(2)} vs ${baseStress.avg_return_pct.toFixed(2)}, worstML ${bestSwap.stress.worst_ml.toFixed(2)}%)`
    : `S2 VERDICT: KEEP deployed baseline (no candidate beats ${baseStress.avg_return_pct.toFixed(2)}%/ch within gates)`);

  console.log("\n=== S3: addition candidates (best DD≤8 passer per pattern) ===");
  const fourAlgo: Member[] = bestSwap
    ? [...trio, { label: `OB ${bestSwap.tag}`, rules: obVariants.find((v) => v.variant_tag === bestSwap!.tag)!.rules }]
    : [...trio, deployedOb];
  const fourStress = bestSwap ? bestSwap.stress : baseStress;
  for (const pattern of ["BOS-Long", "Engulfing-Long"] as const) {
    const cand = loadGrid(pattern).passers.filter((p) => p.stats.static_dd_pct <= 8)[0];
    if (!cand) {
      console.log(`  ${pattern}: no passer with solo DD ≤ 8 — no addition candidate`);
      continue;
    }
    const base = withDailyBias(await fetchRules(sb, PATTERN_IDS[pattern]));
    const cvs = enumerateLayerBVariants({ name: `Search: XAU/USD ${pattern} 4h`, ticker: "XAU/USD", capital: POOL_CAPITAL, rules: base });
    const variant = cvs.find((v) => v.variant_tag === cand.tag)!;
    const run = await runSiblingAware([...fourAlgo, { label: `${pattern} ${cand.tag}`, rules: variant.rules }], bars, 0.6);
    const s = stressTest(run.union);
    // Correlation gate vs all four members (daily solo pnl @0.60).
    let firstMs = Infinity, lastMs = -Infinity;
    for (const t of run.union) {
      const ms = Date.parse(t.exit_date);
      if (ms < firstMs) firstMs = ms;
      if (ms > lastMs) lastMs = ms;
    }
    const candSeries = dailySeries(run.soloTrades.get(`${pattern} ${cand.tag}`)!, firstMs, lastMs);
    let maxCorr = 0;
    for (const m of fourAlgo) {
      const c = Math.abs(pearson(candSeries, dailySeries(run.soloTrades.get(m.label)!, firstMs, lastMs)));
      if (c > maxCorr) maxCorr = c;
    }
    // ML-matched comparison: linearly rescale the 4-algo's return to the
    // candidate run's worstML (risk ∝ ML ∝ return under RPT sizing). The
    // 2026-07-11 as-run version also multiplied by (0.6/0.66) — a frame
    // mix-up; recomputed by hand both ways, the S3 verdicts were unchanged
    // (BOS: 3.77 vs 3.66 at ML 9.38 — 4-algo wins; Engulfing: ρ-blocked).
    const fourAtMatched = fourStress.worst_ml > 0 ? fourStress.avg_return_pct * (s.worst_ml / fourStress.worst_ml) : 0;
    console.log(fmt(`4-algo + ${pattern} ${cand.tag} @0.60`, s) + ` |ρ|max=${maxCorr.toFixed(3)}`);
    const add = s.fail_ml + s.fail_dl === 0 && s.worst_ml <= 8.7 && maxCorr < 0.4 && s.avg_return_pct > fourAtMatched;
    console.log(`  → ${add ? "ADD candidate PASSES S3" : "REJECT"} (5-algo ${s.avg_return_pct.toFixed(2)} vs 4-algo ML-matched ≈${fourAtMatched.toFixed(2)})`);
  }
}

async function main(): Promise<void> {
  const gran = GRAN_BY_TF[TF];
  if (!gran) throw new Error(`TF must be one of ${Object.keys(GRAN_BY_TF).join(", ")}`);
  const { bars, sha256 } = loadPinnedBars("XAU/USD", gran);
  console.log(`Pinned ${gran.toUpperCase()}: ${bars.length} bars (sha256 ${sha256.slice(0, 16)}… VERIFIED)\n`);
  const sb = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const mode = process.env.MODE ?? "grid";
  if (mode === "grid") await runGrid(sb, bars, process.env.PATTERN ?? "OutsideBar-Long");
  else if (mode === "verify") await runVerify(sb, bars);
  else throw new Error(`unknown MODE=${mode}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
