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
import { buildDailyPath, dailySeries, loadPinnedBars, mcChallenge, pearson, POOL_CAPITAL, runUntilTarget, sessionDailyClose, soloStats, stressTest, type DailyPathDay, type SoloStats, type StressResult } from "./lib/pinned-eval";

/** E2.25.b — XAU/USD NY-session daily bars, close-instant-stamped so the
 *  backtest daily_bias / regime / ADX boundary matches the live OANDA D1
 *  feed (fixes the ~7% UTC-day divergence). Loaded once + memoised. */
let _sessionDaily: import("../../src/lib/market-data/types").PriceBar[] | null = null;
function sessionDaily(): import("../../src/lib/market-data/types").PriceBar[] {
  if (!_sessionDaily) _sessionDaily = sessionDailyClose(loadPinnedBars("XAU/USD", "d").bars);
  return _sessionDaily;
}

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
    const res = runPortfolioBacktest(v.rules, priceMap, POOL_CAPITAL, { dailyBarsOverride: sessionDaily() });
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
    const res = runPortfolioBacktest(atRisk(m), priceMap, POOL_CAPITAL, { dailyBarsOverride: sessionDaily() });
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
      dailyBarsOverride: sessionDaily(),
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

/**
 * E2.24.d.vi — final re-derivation on the COMPLETE fidelity harness
 * (floating-equity ML + de-compounding + gap-fills + session-day daily).
 * 3-arm ML-equalized comparison: the deployed 4-algo vs +BOS rr25_lb3 vs
 * +Engulfing rr25_lb4, each rescaled to worst-window ML = 8.0 so return
 * is compared at EQUAL tail risk (the S3 "additions rejected" verdict was
 * a fixed-0.60%-risk-cap artifact — E2.25.j). Plus run-until-target
 * P(pass) + median months on the winning arm.
 */
async function runRederive(sb: SupabaseClient<Database>, bars: PriceBar[]): Promise<void> {
  const ML_TARGET = 8.0;
  const CH_PER_MONTH = 2; // 60-day challenge window ≈ 2 months
  const trio: Member[] = [];
  const labels = ["ARB rr3_lb3", "Engulfing rr3_lb6", "ARB rr25_lb3"];
  for (let i = 0; i < TRIO_IDS.length; i++) trio.push({ label: labels[i], rules: withDailyBias(await fetchRules(sb, TRIO_IDS[i])) });
  const deployedOb: Member = { label: "OutsideBar v2", rules: await fetchRules(sb, DEPLOYED_OB_ID) };
  const fourAlgo = [...trio, deployedOb];

  // Named addition candidates (E2.25.j), constructed directly.
  async function addition(pattern: "BOS-Long" | "Engulfing-Long", tag: string): Promise<Member> {
    const base = withDailyBias(await fetchRules(sb, PATTERN_IDS[pattern]));
    const v = enumerateLayerBVariants({ name: `Search: XAU/USD ${pattern} 4h`, ticker: "XAU/USD", capital: POOL_CAPITAL, rules: base }).find((x) => x.variant_tag === tag);
    if (!v) throw new Error(`${pattern} ${tag} not enumerated`);
    return { label: `${pattern} ${tag}`, rules: v.rules };
  }
  const bosAdd = await addition("BOS-Long", "rr25_lb3_r06_rf0_af0");
  const engAdd = await addition("Engulfing-Long", "rr25_lb4_r06_rf0_af0");

  const arms: Array<{ name: string; members: Member[]; risk: number }> = [
    { name: "4-algo (deployed)", members: fourAlgo, risk: 0.6 },
    { name: "5-algo +BOS rr25_lb3", members: [...fourAlgo, bosAdd], risk: 0.6 },
    { name: "5-algo +Engulfing rr25_lb4", members: [...fourAlgo, engAdd], risk: 0.6 },
  ];

  console.log("=== E2.24.d.vi — 3-arm ML-equalized (COMPLETE fidelity harness: floating ML + de-compound + gap + session-day) ===\n");
  const results: Array<{ name: string; s: StressResult; riskML8: number; monthlyML8: number; ch: ReturnType<typeof runUntilTarget> }> = [];
  for (const arm of arms) {
    const run = await runSiblingAware(arm.members, bars, arm.risk);
    const s = stressTest(run.union);
    const ch = runUntilTarget(run.union);
    // Linear ML-equalization to ML_TARGET (risk ∝ ML ∝ return under RPT).
    const scale = s.worst_ml > 0 ? ML_TARGET / s.worst_ml : 0;
    const riskML8 = arm.risk * scale;
    const monthlyML8 = (s.avg_return_pct * scale) / CH_PER_MONTH;
    results.push({ name: arm.name, s, riskML8, monthlyML8, ch });
    console.log(fmt(arm.name + ` @${arm.risk.toFixed(2)}%`, s));
    console.log(`  → at ML=${ML_TARGET}: risk≈${riskML8.toFixed(3)}%  return≈${monthlyML8.toFixed(2)}%/mo   | run-until-target: P(pass)=${ch.pass_rate_pct.toFixed(1)}% median=${ch.median_months.toFixed(1)}mo (resolved ${ch.resolved}/${ch.starts}, ML-fail ${ch.fails_ml}, DL-fail ${ch.fails_dl})\n`);
  }
  const winner = results.reduce((a, b) => (b.monthlyML8 > a.monthlyML8 ? b : a));
  console.log(`ML-EQUALIZED WINNER: ${winner.name} — ${winner.monthlyML8.toFixed(2)}%/mo at risk ${winner.riskML8.toFixed(3)}% (worst ML ${winner.s.worst_ml.toFixed(2)}% pre-rescale)`);
  console.log(`Deployed 4-algo final sizing to ML≤${ML_TARGET}: risk ${results[0].riskML8.toFixed(3)}% → ${results[0].monthlyML8.toFixed(2)}%/mo`);

  // ===== E2.27 — Monte Carlo sizing curve + probability-based decision =====
  // Two MC runs per arm on the day-block-resampled path:
  //   TAIL run (ML barrier 30, DL off) → UNCENSORED per-challenge worst-ML
  //     distribution → sizing rule: r* = base·8 / ml_p95  ⇔  P(ML_r* > 8%) = 5%.
  //   OUTCOME run at r* (real 10/5 barriers, day atoms scaled r*/base) →
  //     P(pass), months at the deployed sizing.
  console.log("\n=== E2.27 — MC challenge distributions (10k synthetic challenges, 21-day blocks, seed 42) ===\n");
  const scaleDays = (days: DailyPathDay[], s: number): DailyPathDay[] =>
    days.map((d) => ({ realizedRet: d.realizedRet * s, openMaeRet: d.openMaeRet * s }));
  interface McArm { name: string; rStar: number; monthlyAtStar: number; pPass: number; monthsP50: number; monthsP90: number; mlP95AtStar: number; pMlGt8: number }
  const mcArms: McArm[] = [];
  for (let a = 0; a < arms.length; a++) {
    const run = await runSiblingAware(arms[a].members, bars, arms[a].risk);
    const days = buildDailyPath(run.union);
    const tail = mcChallenge(days, 10_000, 21, 10, 30, Number.POSITIVE_INFINITY, 42);
    const rStar = (arms[a].risk * ML_TARGET) / tail.ml_p95;
    const s = rStar / arms[a].risk;
    const outcome = mcChallenge(scaleDays(days, s), 10_000, 21, 10, 10, 5, 43);
    const tailAtStar = mcChallenge(scaleDays(days, s), 10_000, 21, 10, 30, Number.POSITIVE_INFINITY, 44);
    const monthly = (results[a].s.avg_return_pct * s) / CH_PER_MONTH;
    mcArms.push({ name: arms[a].name, rStar, monthlyAtStar: monthly, pPass: outcome.pass_rate_pct, monthsP50: outcome.months_p50, monthsP90: outcome.months_p90, mlP95AtStar: tailAtStar.ml_p95, pMlGt8: tailAtStar.p_ml_gt(8) });
    console.log(`${arms[a].name}`);
    console.log(`  tail ML dist @${arms[a].risk}%: p50=${tail.ml_p50.toFixed(2)} p95=${tail.ml_p95.toFixed(2)} p99=${tail.ml_p99.toFixed(2)}  | P(ML>8)=${tail.p_ml_gt(8).toFixed(1)}% P(ML>10)=${tail.p_ml_gt(10).toFixed(1)}%`);
    console.log(`  → r* (P(ML>8)≤5%): ${rStar.toFixed(3)}%  → ~${monthly.toFixed(2)}%/mo | outcome@r*: P(pass)=${outcome.pass_rate_pct.toFixed(1)}% (ml ${outcome.fail_ml_pct.toFixed(1)}% dl ${outcome.fail_dl_pct.toFixed(1)}%) months p50=${outcome.months_p50.toFixed(1)} p90=${outcome.months_p90.toFixed(1)} | check P(ML>8)@r*=${tailAtStar.p_ml_gt(8).toFixed(1)}%\n`);
    // Block-length sensitivity on the base arm only (10/21/42 trading days).
    if (a === 0) {
      for (const b of [10, 42]) {
        const t = mcChallenge(days, 10_000, b, 10, 30, Number.POSITIVE_INFINITY, 42);
        console.log(`  [sensitivity] block=${b}d: ml_p95=${t.ml_p95.toFixed(2)} (vs 21d ${tail.ml_p95.toFixed(2)})`);
      }
      console.log("");
    }
  }
  // MtM-ρ gate for the 5-algo arms: candidate's daily floating-equity delta
  // vs each incumbent's (E2.24.f.v — exit-day Pearson understates; this is
  // the mark-to-market upgrade). Gate < 0.40.
  console.log("=== MtM-ρ gate (candidate vs incumbents, daily floating-equity deltas) ===");
  const floatDelta = (trades: BacktestTrade[]): number[] => {
    const days = buildDailyPath(trades);
    const out: number[] = [];
    let prev = 0, cum = 0;
    for (const d of days) {
      cum += d.realizedRet;
      const f = cum - d.openMaeRet;
      out.push(f - prev);
      prev = f;
    }
    return out;
  };
  for (const arm of arms.slice(1)) {
    const run = await runSiblingAware(arm.members, bars, 0.6);
    const cand = arm.members[arm.members.length - 1];
    const candSeries = floatDelta(run.soloTrades.get(cand.label)!);
    let maxR = 0, vs = "";
    for (const m of arm.members.slice(0, -1)) {
      const inc = floatDelta(run.soloTrades.get(m.label)!);
      const len = Math.min(candSeries.length, inc.length);
      const r = Math.abs(pearson(candSeries.slice(0, len), inc.slice(0, len)));
      if (r > maxR) { maxR = r; vs = m.label; }
    }
    console.log(`  ${arm.name}: |ρ|max(MtM) = ${maxR.toFixed(3)} (vs ${vs}) — ${maxR < 0.4 ? "PASSES <0.40 gate" : "FAILS ≥0.40 gate"}`);
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
  else if (mode === "rederive") await runRederive(sb, bars);
  else throw new Error(`unknown MODE=${mode}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
