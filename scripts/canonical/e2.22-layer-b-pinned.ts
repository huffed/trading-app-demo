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
  const risks = new Map(members.map((m) => [m.label, uniformRisk]));
  return runSiblingAwareWeighted(members, bars, risks);
}

/** E2.28 — sibling-aware run with PER-MEMBER risk. Each sibling contributes
 *  its OWN risk to the risk-pool blocking windows + daily-halt sum (the
 *  uniform version is the special case risks = all-equal). */
async function runSiblingAwareWeighted(
  members: Member[],
  bars: PriceBar[],
  risks: Map<string, number>
): Promise<{ union: BacktestTrade[]; perMember: Array<{ label: string; solo: number; aware: number }>; soloTrades: Map<string, BacktestTrade[]> }> {
  const priceMap = new Map([["XAU/USD", bars]]);
  const riskOf = (label: string): number => risks.get(label) ?? 0;
  const atRisk = (m: Member): AlgorithmRules => ({
    ...m.rules,
    position_sizing: { ...m.rules.position_sizing, type: "risk_per_trade", value: riskOf(m.label) },
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
      sibWindows = sibWindows.concat(tradesAsSiblingWindows(ot, POOL_CAPITAL * (riskOf(other.label) / 100)));
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

/**
 * MODE=algo-stats — predicted per-algo + portfolio stats for the DEPLOYED
 * 5-algo gold portfolio at the live 0.42% risk, on the complete-fidelity
 * harness (session-day + floating ML + de-compound + gap). Per-algo rows
 * are SOLO runs (each alone at 0.42%); the portfolio row is sibling-aware
 * (direction-conflict/risk-pool/etc. applied), so per-algo returns do NOT
 * simply sum to the portfolio (sibling gating drops some entries).
 */
async function runAlgoStats(sb: SupabaseClient<Database>, bars: PriceBar[]): Promise<void> {
  const RISK = 0.42;
  const CH_PER_MONTH = 2;
  const trioLabels = ["ARB rr3_lb3", "Engulfing rr3_lb6", "ARB rr25_lb3"];
  const members: Member[] = [];
  for (let i = 0; i < TRIO_IDS.length; i++) members.push({ label: trioLabels[i], rules: withDailyBias(await fetchRules(sb, TRIO_IDS[i])) });
  members.push({ label: "OutsideBar v2 rr3_lb3", rules: await fetchRules(sb, DEPLOYED_OB_ID) });
  const engBase = withDailyBias(await fetchRules(sb, PATTERN_IDS["Engulfing-Long"]));
  const engV = enumerateLayerBVariants({ name: "Search: XAU/USD Engulfing-Long 4h", ticker: "XAU/USD", capital: POOL_CAPITAL, rules: engBase }).find((v) => v.variant_tag === "rr25_lb4_r06_rf0_af0")!;
  members.push({ label: "Engulfing25 rr25_lb4", rules: engV.rules });

  const run = await runSiblingAware(members, bars, RISK);
  console.log(`=== DEPLOYED 5-ALGO GOLD PORTFOLIO — predicted stats @ ${RISK}% (complete-fidelity harness, pinned H4 2015→2026) ===\n`);
  const hdr = "algo".padEnd(24) + "n".padStart(5) + "WR%".padStart(7) + "statDD%".padStart(9) + "dayDD%".padStart(8) + "flML%".padStart(7) + "$pnl".padStart(9) + "%/mo".padStart(7) + "Ppass%".padStart(8) + "med.mo".padStart(8);
  console.log(hdr);
  console.log("-".repeat(hdr.length));
  const line = (label: string, trades: BacktestTrade[]): void => {
    const st = soloStats(trades);
    const ss = stressTest(trades);
    const ch = runUntilTarget(trades);
    const monthly = ss.avg_return_pct / CH_PER_MONTH;
    console.log(
      label.padEnd(24) +
      String(st.trades).padStart(5) +
      st.wr.toFixed(1).padStart(7) +
      st.static_dd_pct.toFixed(2).padStart(9) +
      st.daily_dd_pct.toFixed(2).padStart(8) +
      ss.worst_ml.toFixed(2).padStart(7) +
      st.total_pnl.toFixed(0).padStart(9) +
      monthly.toFixed(2).padStart(7) +
      ch.pass_rate_pct.toFixed(0).padStart(8) +
      ch.median_months.toFixed(1).padStart(8)
    );
  };
  for (const m of members) line(m.label + " (solo)", run.soloTrades.get(m.label)!);
  console.log("-".repeat(hdr.length));
  line("PORTFOLIO (sibling-aware)", run.union);

  // FTMO two-phase challenge economics on the deployed portfolio @0.42%.
  const p1 = runUntilTarget(run.union, POOL_CAPITAL, 10, 10, 5); // Phase 1: +10% / −10%ML / −5%DL
  const p2 = runUntilTarget(run.union, POOL_CAPITAL, 5, 10, 5);  // Phase 2: +5% / same loss limits
  const combined = (p1.pass_rate_pct / 100) * (p2.pass_rate_pct / 100) * 100;
  console.log("\n=== FTMO CHALLENGE (deployed 5-algo @0.42%, run-until-target, no time limit) ===");
  console.log(`  Phase 1 (+10% target): P(pass) ${p1.pass_rate_pct.toFixed(1)}%  median ${p1.median_months.toFixed(1)}mo  (ML-fail ${p1.fails_ml}, DL-fail ${p1.fails_dl} of ${p1.resolved} resolved)`);
  console.log(`  Phase 2 (+5% target):  P(pass) ${p2.pass_rate_pct.toFixed(1)}%  median ${p2.median_months.toFixed(1)}mo  (ML-fail ${p2.fails_ml}, DL-fail ${p2.fails_dl})`);
  console.log(`  BOTH phases (independent approx): P(funded) ≈ ${combined.toFixed(0)}%  |  expected calendar to funded ≈ ${(p1.median_months + p2.median_months).toFixed(1)}mo (median-sum)`);
  console.log(`  Requirements met: profit target ✓ (reaches +10/+5)  |  max daily loss 5% ✓ (worst-window ${stressTest(run.union).worst_dl.toFixed(2)}%)  |  max static loss 10% ✓ (worst-window ML ${stressTest(run.union).worst_ml.toFixed(2)}%)  |  min trading days ✓ (843 trades / 11.5y ≫ 4-day min)`);

  console.log("\nNotes: per-algo rows are SOLO @0.42% (each alone); PORTFOLIO is sibling-aware (gating drops some");
  console.log("entries → rows don't sum). flML = floating-inclusive worst-window Max Loss. Ppass/med.mo = run-until-");
  console.log("target FTMO (+10/−10ML/−5DL, no time limit). daily_bias evidence form; live news_veto/time_filter");
  console.log("overlays trim trade count slightly. Numbers are IN-SAMPLE on pinned data — the demo is the OOS test.");

  // G.8 baseline artifact (M1 evidence tracker input): per-trade mean R,
  // risk-normalized via equity_at_entry so de-compounding cannot skew it.
  // Written every run — deterministic on pinned data; regenerate on any
  // re-derivation and re-transcribe into src/lib/cohort/m1-baseline.ts.
  const rSeries = (trades: BacktestTrade[]): number[] =>
    trades.map((t) => {
      const riskDollars = ((t.equity_at_entry ?? POOL_CAPITAL) * RISK) / 100;
      return riskDollars > 0 ? t.pnl / riskDollars : 0;
    });
  const meanR = (trades: BacktestTrade[]): number => {
    const rs = rSeries(trades);
    return rs.length === 0 ? 0 : rs.reduce((a, b) => a + b, 0) / rs.length;
  };
  // G.4.a: per-trade Sharpe with the EXACT alpha-decay convention
  // (mean(R) / sample-std(R), no annualization — alpha-decay.ts:145).
  const sharpeR = (trades: BacktestTrade[]): number | null => {
    const rs = rSeries(trades);
    if (rs.length < 2) return null;
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
    const variance = rs.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (rs.length - 1);
    const sd = Math.sqrt(variance);
    return sd > 0 ? mean / sd : null;
  };
  const LIVE_NAMES: Record<string, string> = {
    "ARB rr3_lb3": "Deploy: XAU/USD ARB+DailyBias 4h | r085 v1",
    "Engulfing rr3_lb6": "Deploy: XAU/USD Engulfing+DailyBias 4h | r080 v1",
    "ARB rr25_lb3": "Deploy: XAU/USD ARB25+DailyBias 4h | r080 v1",
    "OutsideBar v2 rr3_lb3": "Deploy: XAU/USD OutsideBar+DailyBias 4h | rr3_lb3 r066 v2",
    "Engulfing25 rr25_lb4": "Deploy: XAU/USD Engulfing25+DailyBias 4h | r042 v1",
  };
  const unionStress = stressTest(run.union);
  const unionSolo = soloStats(run.union);
  const artifact = {
    generated_at: new Date().toISOString(),
    source: "e2.22-layer-b-pinned.ts MODE=algo-stats (complete-fidelity harness, pinned H4 2015→2026)",
    risk_pct: RISK,
    capital: POOL_CAPITAL,
    per_algo: members.map((m) => {
      const trades = run.soloTrades.get(m.label)!;
      const st = soloStats(trades);
      return {
        label: m.label,
        live_name: LIVE_NAMES[m.label] ?? null,
        n: st.trades,
        wr_pct: st.wr,
        mean_r: meanR(trades),
        sharpe_r: sharpeR(trades),
        monthly_pct: stressTest(trades).avg_return_pct / CH_PER_MONTH,
        note: "SOLO run — sibling gating slightly changes live composition",
      };
    }),
    portfolio: {
      n: unionSolo.trades,
      wr_pct: unionSolo.wr,
      mean_r: meanR(run.union),
      monthly_pct: unionStress.avg_return_pct / CH_PER_MONTH,
      worst_ml_pct: unionStress.worst_ml,
      worst_dl_pct: unionStress.worst_dl,
    },
    g8_gate: { min_trades: 30, tolerance_pct: 30 },
  };
  const g8Path = resolve(process.cwd(), `${RESULTS_DIR}/g8-baseline.json`);
  writeFileSync(g8Path, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`\nG.8 baseline artifact written: ${g8Path}`);
  console.log(`  portfolio mean R/trade = ${artifact.portfolio.mean_r.toFixed(4)} over n=${artifact.portfolio.n}; ±30% band = [${(artifact.portfolio.mean_r * 0.7).toFixed(4)}, ${(artifact.portfolio.mean_r * 1.3).toFixed(4)}]`);

  // G.4.a (WRITE_SHARPE=1): arm alpha-decay by MERGING sharpe_ratio into
  // each live row's backtest_results — merge, never overwrite: the rows
  // carry the v4 deploy-evidence blocks.
  if (process.env.WRITE_SHARPE === "1") {
    console.log("\nG.4.a: writing per-algo baseline sharpe_ratio to live rows…");
    for (const m of members) {
      const liveName = LIVE_NAMES[m.label];
      const sharpe = sharpeR(run.soloTrades.get(m.label)!);
      if (!liveName || sharpe === null) { console.log(`  ${m.label}: SKIP (no live name or n<2)`); continue; }
      const { data: rows, error } = await sb.from("algorithms").select("id, name, backtest_results").eq("status", "active");
      if (error) throw new Error(`G.4.a read failed: ${error.message}`);
      const row = (rows ?? []).find((r) => r.name === liveName);
      if (!row) { console.log(`  ${m.label}: SKIP (live row "${liveName}" not found)`); continue; }
      const merged = {
        ...((row.backtest_results as Record<string, unknown> | null) ?? {}),
        sharpe_ratio: sharpe,
        sharpe_provenance: `G.4.a 2026-07-30: per-trade mean(R)/std(R), alpha-decay convention, complete-fidelity harness on pinned H4 @${RISK}% (MODE=algo-stats WRITE_SHARPE=1)`,
      };
      const upd = await sb.from("algorithms").update({ backtest_results: merged as never }).eq("id", row.id);
      if (upd.error) throw new Error(`G.4.a write failed for ${liveName}: ${upd.error.message}`);
      console.log(`  ${m.label}: sharpe_ratio=${sharpe.toFixed(4)} → ${liveName}`);
    }
  }
}

/**
 * MODE=weight-opt (E2.28) — is the deployed portfolio leaving return on
 * the table with UNIFORM 0.42% sizing? Overfit-disciplined: a ONE-parameter
 * tilt family wᵢ ∝ (soloMonthlyᵢ)^k (k=0 → uniform; higher k → more weight
 * on the higher-return algos), each weight VECTOR scaled by a scalar s so
 * the portfolio worst-window ML hits the 8.0 band exactly (binary search;
 * ML ∝ s under RPT). Return is then compared at EQUAL tail risk across k.
 * 1 dof + a monotone family + tiny grid = minimal RDOF. In-sample on
 * pinned data; the demo is the OOS test.
 */
async function runWeightOpt(sb: SupabaseClient<Database>, bars: PriceBar[]): Promise<void> {
  const ML_TARGET = 8.0;
  const CH_PER_MONTH = 2;
  const BASE = 0.42;
  const trioLabels = ["ARB rr3_lb3", "Engulfing rr3_lb6", "ARB rr25_lb3"];
  const members: Member[] = [];
  for (let i = 0; i < TRIO_IDS.length; i++) members.push({ label: trioLabels[i], rules: withDailyBias(await fetchRules(sb, TRIO_IDS[i])) });
  members.push({ label: "OutsideBar v2", rules: await fetchRules(sb, DEPLOYED_OB_ID) });
  const engBase = withDailyBias(await fetchRules(sb, PATTERN_IDS["Engulfing-Long"]));
  members.push({ label: "Engulfing25", rules: enumerateLayerBVariants({ name: "Search: XAU/USD Engulfing-Long 4h", ticker: "XAU/USD", capital: POOL_CAPITAL, rules: engBase }).find((v) => v.variant_tag === "rr25_lb4_r06_rf0_af0")!.rules });

  // Per-member solo monthly return @BASE — the tilt basis.
  const soloMonthly = new Map<string, number>();
  for (const m of members) {
    const res = runPortfolioBacktest({ ...m.rules, position_sizing: { ...m.rules.position_sizing, type: "risk_per_trade", value: BASE } }, new Map([["XAU/USD", bars]]), POOL_CAPITAL, { dailyBarsOverride: sessionDaily() });
    soloMonthly.set(m.label, Math.max(0.001, stressTest(res.trades ?? []).avg_return_pct / CH_PER_MONTH));
  }

  const runAt = async (risks: Map<string, number>): Promise<{ s: StressResult; monthly: number }> => {
    const run = await runSiblingAwareWeighted(members, bars, risks);
    const s = stressTest(run.union);
    return { s, monthly: s.avg_return_pct / CH_PER_MONTH };
  };
  // Scale a relative-weight vector so worst-window ML == ML_TARGET.
  const scaleToML = async (relW: Map<string, number>): Promise<{ risks: Map<string, number>; res: { s: StressResult; monthly: number } }> => {
    let lo = 0.05, hi = 1.5, mid = BASE, res = await runAt(new Map([...relW].map(([l, w]) => [l, w * BASE])));
    for (let it = 0; it < 12; it++) {
      mid = (lo + hi) / 2;
      const risks = new Map([...relW].map(([l, w]) => [l, w * mid]));
      res = await runAt(risks);
      if (res.s.worst_ml > ML_TARGET) hi = mid; else lo = mid;
    }
    const risks = new Map([...relW].map(([l, w]) => [l, w * mid]));
    return { risks, res: await runAt(risks) };
  };

  console.log(`=== E2.28 — risk-weighting tilt sweep (1-param family, each scaled to worst-window ML=${ML_TARGET}) ===`);
  console.log(`Solo monthly @${BASE}%: ` + members.map((m) => `${m.label}=${soloMonthly.get(m.label)!.toFixed(3)}`).join("  "));
  console.log("");
  const meanMonthly = [...soloMonthly.values()].reduce((a, b) => a + b, 0) / members.length;
  interface Row { k: number; monthly: number; ml: number; dl: number; breach: number; risks: Map<string, number> }
  const rows: Row[] = [];
  for (const k of [0, 0.5, 1, 1.5, 2]) {
    // rel weight ∝ (soloMonthly / mean)^k, normalized to mean 1.
    const raw = new Map(members.map((m) => [m.label, Math.pow(soloMonthly.get(m.label)! / meanMonthly, k)]));
    const meanRaw = [...raw.values()].reduce((a, b) => a + b, 0) / members.length;
    const relW = new Map([...raw].map(([l, w]) => [l, w / meanRaw]));
    const { risks, res } = await scaleToML(relW);
    rows.push({ k, monthly: res.monthly, ml: res.s.worst_ml, dl: res.s.worst_dl, breach: res.s.fail_ml + res.s.fail_dl, risks });
    const wStr = members.map((m) => `${m.label.split(" ")[0].slice(0, 5)}=${risks.get(m.label)!.toFixed(3)}`).join(" ");
    console.log(`k=${k.toFixed(1)}  → ${res.monthly.toFixed(3)}%/mo  ML=${res.s.worst_ml.toFixed(2)} DL=${res.s.worst_dl.toFixed(2)} breach=${res.s.fail_ml + res.s.fail_dl}  | risks: ${wStr}`);
  }
  const uniform = rows.find((r) => r.k === 0)!;
  const valid = rows.filter((r) => r.breach === 0 && r.ml <= ML_TARGET + 0.05 && r.dl <= 5);
  const best = valid.reduce((a, b) => (b.monthly > a.monthly ? b : a), valid[0]);
  const lift = ((best.monthly - uniform.monthly) / uniform.monthly) * 100;
  console.log("");
  console.log(`UNIFORM (k=0): ${uniform.monthly.toFixed(3)}%/mo @ ML ${uniform.ml.toFixed(2)}`);
  console.log(`BEST TILT (k=${best.k}): ${best.monthly.toFixed(3)}%/mo @ ML ${best.ml.toFixed(2)} → ${lift >= 0 ? "+" : ""}${lift.toFixed(1)}% vs uniform`);
  if (best.k === 0 || lift < 5) {
    console.log(`VERDICT: uniform is already ~optimal (lift <5%) — no meaningful return left on the table; KEEP uniform 0.42%.`);
  } else {
    console.log(`VERDICT: tilt k=${best.k} lifts return ${lift.toFixed(1)}% at the same tail risk. Deploy weights: ` + members.map((m) => `${m.label}=${best.risks.get(m.label)!.toFixed(3)}%`).join(", "));
    // MC + run-until-target validation of the winner.
    const run = await runSiblingAwareWeighted(members, bars, best.risks);
    const ch = runUntilTarget(run.union);
    console.log(`  MC/run-until-target @ winner: P(pass)=${ch.pass_rate_pct.toFixed(1)}% median=${ch.median_months.toFixed(1)}mo`);
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
  else if (mode === "algo-stats") await runAlgoStats(sb, bars);
  else if (mode === "weight-opt") await runWeightOpt(sb, bars);
  else throw new Error(`unknown MODE=${mode}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
