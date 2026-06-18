/**
 * validate-algo — CANONICAL validation runner. Replaces the ad-hoc
 * step2/3/4/5/6 + verify-* + analyze-* one-offs.
 *
 * Runs the full Phase A→B validation pipeline for one algorithm OR for
 * all deployed algorithms, with Phase B fidelity gates applied:
 *   - Empirical friction (slippage_bps=3, spread_bps=0 — from real fills)
 *   - Direction-conflict simulation (sibling open positions block)
 *   - Spread-gate ATR-proxy (refuse high-vol entries)
 *   - [pending: risk-pool halt, FTMO termination]
 *
 * Output: per-algo {step2 stats, step3 walk-forward, step6 OOS-tiered,
 * promotion_eligible boolean, blockers list}. Persisted to
 * algorithms.backtest_results JSONB.
 *
 * Usage:
 *   pnpm dlx tsx scripts/canonical/validate-algo.ts                    # all deployed
 *   pnpm dlx tsx scripts/canonical/validate-algo.ts ALGO="Library: Gold sweep_reclaim-DailyBias-Long 4h"
 *
 * Env:
 *   ALGO          (optional) — algo name (exact match)
 *   OOS_CUTOFF    (optional) — date for OOS holdout, default 2025-12-18
 *   PERSIST       (default 1) — write backtest_results to DB. Set 0 for dry-run.
 *   SIBLINGS      (default 1) — include direction-conflict simulation
 *   SPREAD_GATE   (default 1) — include spread-gate ATR proxy
 *
 * Acceptance: every result includes friction config + sample window +
 * step verdicts. Re-run anytime; same input → same output.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { timeframeToInterval } from "../../src/lib/market-data/interval";
import {
  runPortfolioBacktest,
  tradesAsSiblingWindows,
  type RiskPoolConfig,
  type SiblingTradeWindow,
  type SpreadGateConfig,
} from "../../src/lib/market-data/portfolio-backtest";
import type { BacktestTrade, PriceBar } from "../../src/lib/market-data/types";
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

const ONLY_ALGO = process.env.ALGO ?? null;
const OOS_CUTOFF = process.env.OOS_CUTOFF ?? "2025-12-18";
const PERSIST = process.env.PERSIST !== "0";
const ENABLE_SIBLINGS = process.env.SIBLINGS !== "0";
const ENABLE_SPREAD_GATE = process.env.SPREAD_GATE !== "0";
const ENABLE_RISK_POOL = process.env.RISK_POOL !== "0";
const POOL_CAP_PCT = Number(process.env.POOL_CAP_PCT ?? 4);

const TRAIN_MONTHS = 12;
const TEST_MONTHS = 3;
const WR_FLOOR = 37;
const SMALL_N = 15;
const SPREAD_GATE_CONFIG: SpreadGateConfig = {
  enabled: true,
  threshold_multiplier: 2.5,
  atr_lookback_bars: 200,
};

interface AlgoRow {
  id: string;
  name: string;
  capital: number;
  rules: AlgorithmRules;
  ticker: string;
  status: string;
}

interface GateResults {
  computed_at: string;
  sample_first: string | null;
  sample_last: string | null;
  friction: { slippage_bps: number; spread_bps: number; commission_per_lot: number };
  fidelity_gates_applied: { siblings: boolean; spread_gate: boolean; risk_pool: boolean };
  step2: StepStats;
  step3: WalkForwardStats;
  step6: OosStats;
  promotion_eligible: boolean;
  promotion_blockers: string[];
}

interface StepStats {
  total_return: number;
  total_trades: number;
  win_rate: number;
  max_drawdown: number;
  max_static_dd: number;
  max_daily_dd: number;
  verdict: "PASS" | "FAIL" | "EXCLUDED";
  reason?: string;
}

interface WalkForwardStats {
  walk_forward_green_pct: number;
  walk_forward_n_windows: number;
  per_year_green_pct: number;
  per_year_n_years: number;
  verdict: "PASS" | "WEAK" | "FAIL" | "INSUFFICIENT_DATA";
  reason: string;
}

interface OosStats {
  in_sample_n: number;
  in_sample_mean_r: number;
  held_out_n: number;
  held_out_mean_r: number;
  r_delta_pct: number;
  verdict: "TIER_1_PASS" | "TIER_2_PASS" | "FAIL" | "INSUFFICIENT_DATA";
  reason: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getBarsNoTtl(supabase: any, ticker: string, interval: string): Promise<PriceBar[] | null> {
  const { data } = await supabase
    .from("price_cache")
    .select("bars")
    .eq("ticker", ticker.toUpperCase())
    .eq("output_size", "full")
    .eq("interval", interval)
    .limit(1)
    .single();
  return (data as { bars: PriceBar[] } | null)?.bars ?? null;
}

function pnlOf(trades: BacktestTrade[]): number {
  return trades.reduce((s, t) => s + t.pnl, 0);
}

function tradesInWindow(trades: BacktestTrade[], start: Date, end: Date): BacktestTrade[] {
  return trades.filter((t) => {
    const exit = new Date(t.exit_date);
    return exit >= start && exit < end;
  });
}

function analyzeStats(trades: BacktestTrade[], capital: number, friction: GateResults["friction"], fidelityGates: GateResults["fidelity_gates_applied"], riskPct: number): GateResults {
  const empty: GateResults = {
    computed_at: "2026-06-18T16:00:00Z",
    sample_first: null,
    sample_last: null,
    friction,
    fidelity_gates_applied: fidelityGates,
    step2: { total_return: 0, total_trades: 0, win_rate: 0, max_drawdown: 0, max_static_dd: 0, max_daily_dd: 0, verdict: "EXCLUDED", reason: "zero trades" },
    step3: { walk_forward_green_pct: 0, walk_forward_n_windows: 0, per_year_green_pct: 0, per_year_n_years: 0, verdict: "INSUFFICIENT_DATA", reason: "no trades" },
    step6: { in_sample_n: 0, in_sample_mean_r: 0, held_out_n: 0, held_out_mean_r: 0, r_delta_pct: 0, verdict: "INSUFFICIENT_DATA", reason: "no trades" },
    promotion_eligible: false,
    promotion_blockers: ["zero trades"],
  };
  if (trades.length === 0) return empty;

  const sorted = [...trades].sort((a, b) => new Date(a.exit_date).getTime() - new Date(b.exit_date).getTime());

  // STEP 2 stats with daily DD
  let cum = 0, maxSdd = 0, maxPdd = 0, peak = 0, wins = 0;
  const dailyPnl = new Map<string, number>();
  for (const t of sorted) {
    cum += t.pnl;
    if (t.pnl > 0) wins++;
    if (cum > peak) peak = cum;
    const pdd = ((peak - cum) / capital) * 100;
    if (pdd > maxPdd) maxPdd = pdd;
    const sdd = cum < 0 ? (-cum / capital) * 100 : 0;
    if (sdd > maxSdd) maxSdd = sdd;
    const day = t.exit_date.slice(0, 10);
    dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + t.pnl);
  }
  let worstDay = 0;
  for (const v of dailyPnl.values()) if (v < worstDay) worstDay = v;
  const ddd = worstDay < 0 ? -worstDay / capital * 100 : 0;
  const wr = wins / sorted.length * 100;
  const step2Pass = cum > 0 && wr >= WR_FLOOR && maxSdd < 10 && ddd < 5;
  const step2Reasons: string[] = [];
  if (cum <= 0) step2Reasons.push("not positive");
  if (wr < WR_FLOOR) step2Reasons.push(`WR ${wr.toFixed(1)}% < ${WR_FLOOR}`);
  if (maxSdd >= 10) step2Reasons.push(`static DD ${maxSdd.toFixed(2)}% >= 10`);
  if (ddd >= 5) step2Reasons.push(`daily DD ${ddd.toFixed(2)}% >= 5`);

  // STEP 3 walk-forward (12mo train / 3mo test)
  const firstDate = new Date(sorted[0].entry_date);
  const lastDate = new Date(sorted[sorted.length - 1].exit_date);
  const wfStart = new Date(firstDate);
  wfStart.setMonth(wfStart.getMonth() + TRAIN_MONTHS);
  const windows: { pnl: number; green: boolean }[] = [];
  let cursor = new Date(wfStart);
  while (cursor < lastDate) {
    const end = new Date(cursor);
    end.setMonth(end.getMonth() + TEST_MONTHS);
    const wt = tradesInWindow(sorted, cursor, end);
    if (wt.length > 0) {
      const wp = pnlOf(wt);
      windows.push({ pnl: wp, green: wp > 0 });
    }
    cursor = new Date(end);
  }
  const wfGreen = windows.filter((w) => w.green).length;
  const wfGreenPct = windows.length === 0 ? 0 : Math.round(wfGreen / windows.length * 100);

  const byYear = new Map<string, number>();
  for (const t of sorted) {
    const y = t.exit_date.slice(0, 4);
    byYear.set(y, (byYear.get(y) ?? 0) + t.pnl);
  }
  const yearsGreen = [...byYear.values()].filter((p) => p > 0).length;
  const yearsGreenPct = byYear.size === 0 ? 0 : Math.round(yearsGreen / byYear.size * 100);

  let step3Verdict: WalkForwardStats["verdict"], step3Reason: string;
  if (cum <= 0) { step3Verdict = "FAIL"; step3Reason = "aggregate negative"; }
  else if (windows.length === 0) { step3Verdict = "INSUFFICIENT_DATA"; step3Reason = "history too short for 12mo train + 3mo test"; }
  else if (wfGreenPct >= 70 && yearsGreenPct >= 70) { step3Verdict = "PASS"; step3Reason = "both gates pass strict 70%"; }
  else if (wfGreenPct >= 50 && yearsGreenPct >= 50) { step3Verdict = "WEAK"; step3Reason = `WF ${wfGreenPct}% / per-year ${yearsGreenPct}%`; }
  else { step3Verdict = "FAIL"; step3Reason = `WF ${wfGreenPct}% / per-year ${yearsGreenPct}% — both below 50`; }

  // STEP 6 OOS tiered
  const cutoffMs = new Date(OOS_CUTOFF).getTime();
  const inSampleT = sorted.filter((t) => new Date(t.exit_date).getTime() < cutoffMs);
  const heldOutT = sorted.filter((t) => new Date(t.exit_date).getTime() >= cutoffMs);
  const riskPerTrade = capital * (riskPct / 100);
  const meanR = (ts: BacktestTrade[]) => riskPerTrade <= 0 || ts.length === 0 ? 0 : ts.reduce((s, t) => s + t.pnl, 0) / ts.length / riskPerTrade;
  const inSampleR = meanR(inSampleT);
  const heldOutR = meanR(heldOutT);
  let step6Verdict: OosStats["verdict"], step6Reason: string;
  let rDelta = 0;
  if (inSampleT.length < 10) { step6Verdict = "INSUFFICIENT_DATA"; step6Reason = `in-sample ${inSampleT.length} trades`; }
  else if (heldOutT.length < 3) { step6Verdict = "INSUFFICIENT_DATA"; step6Reason = `held-out ${heldOutT.length} trades`; }
  else if (Math.abs(inSampleR) < 0.001) { step6Verdict = "FAIL"; step6Reason = "in-sample R near zero"; }
  else {
    rDelta = (heldOutR - inSampleR) / Math.abs(inSampleR) * 100;
    if (heldOutR <= 0) { step6Verdict = "FAIL"; step6Reason = `held-out R=${heldOutR.toFixed(2)} (≤ 0)`; }
    else if (Math.abs(rDelta) <= 50) { step6Verdict = "TIER_1_PASS"; step6Reason = `clean ±50%`; }
    else if (Math.abs(rDelta) <= 75 || heldOutT.length < SMALL_N) { step6Verdict = "TIER_2_PASS"; step6Reason = `held-out positive (n=${heldOutT.length}); ±75% OR small-N`; }
    else { step6Verdict = "FAIL"; step6Reason = `diverges ${rDelta.toFixed(0)}%, n=${heldOutT.length} large enough`; }
  }

  // Promotion eligibility (Phase B.4 strict reading): step2 PASS + step3 PASS + step6 TIER_1 or TIER_2
  const blockers: string[] = [];
  if (!step2Pass) blockers.push(`STEP 2: ${step2Reasons.join("; ")}`);
  if (step3Verdict === "FAIL") blockers.push(`STEP 3: ${step3Reason}`);
  if (step3Verdict === "WEAK") blockers.push(`STEP 3: WEAK (not strict 70% — Phase B reads strict only)`);
  if (step6Verdict === "FAIL") blockers.push(`STEP 6: ${step6Reason}`);
  if (step3Verdict === "INSUFFICIENT_DATA" || step6Verdict === "INSUFFICIENT_DATA") {
    blockers.push("history too short for full validation — revisit with more data");
  }
  const eligible = blockers.length === 0;

  return {
    computed_at: "2026-06-18T16:00:00Z",
    sample_first: sorted[0].exit_date.slice(0, 10),
    sample_last: sorted[sorted.length - 1].exit_date.slice(0, 10),
    friction,
    fidelity_gates_applied: fidelityGates,
    step2: {
      total_return: Math.round(cum * 100) / 100,
      total_trades: sorted.length,
      win_rate: Math.round(wr * 10) / 10,
      max_drawdown: Math.round(maxPdd * 100) / 100,
      max_static_dd: Math.round(maxSdd * 100) / 100,
      max_daily_dd: Math.round(ddd * 100) / 100,
      verdict: step2Pass ? "PASS" : "FAIL",
      reason: step2Pass ? undefined : step2Reasons.join("; "),
    },
    step3: { walk_forward_green_pct: wfGreenPct, walk_forward_n_windows: windows.length, per_year_green_pct: yearsGreenPct, per_year_n_years: byYear.size, verdict: step3Verdict, reason: step3Reason },
    step6: { in_sample_n: inSampleT.length, in_sample_mean_r: Math.round(inSampleR * 100) / 100, held_out_n: heldOutT.length, held_out_mean_r: Math.round(heldOutR * 100) / 100, r_delta_pct: Math.round(rDelta * 10) / 10, verdict: step6Verdict, reason: step6Reason },
    promotion_eligible: eligible,
    promotion_blockers: blockers,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadAlgos(supabase: any, only: string | null): Promise<AlgoRow[]> {
  let query = supabase.from("algorithms").select("id, name, capital, rules, status");
  if (only) query = query.eq("name", only);
  else query = query.or("name.like.Library:%,name.eq.Gold Swing 4h");
  const res = await query;
  if (res.error) { console.error(res.error.message); process.exit(1); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (res.data ?? []) as any as Omit<AlgoRow, "ticker">[];
  const out: AlgoRow[] = [];
  for (const r of rows) {
    const wl = await supabase.from("algorithm_watchlist").select("ticker").eq("algorithm_id", r.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ticker = ((wl.data ?? []) as any[])[0]?.ticker?.toUpperCase() ?? "";
    if (ticker) out.push({ ...r, ticker });
  }
  return out;
}

async function main(): Promise<void> {
  console.log(`\n===== validate-algo @ ${new Date().toISOString().slice(0, 16)} =====`);
  console.log(`Mode: ${ONLY_ALGO ? `single algo "${ONLY_ALGO}"` : "all deployed"}`);
  console.log(`Phase B fidelity gates: siblings=${ENABLE_SIBLINGS} spread_gate=${ENABLE_SPREAD_GATE} risk_pool=${ENABLE_RISK_POOL} (cap=${POOL_CAP_PCT}%)`);
  console.log(`OOS cutoff: ${OOS_CUTOFF}`);
  console.log(`Persist to DB: ${PERSIST}\n`);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const algos = await loadAlgos(supabase, ONLY_ALGO);
  console.log(`Loaded ${algos.length} algos.\n`);

  // For sibling sim: pre-run all algos to capture trades, then re-run each with siblings.
  // Two-pass approach — pass 1 produces sibling pool, pass 2 applies it per-algo.
  // First pass: collect trades per algo (no siblings).
  const baselineTradesByAlgo = new Map<string, BacktestTrade[]>();
  for (const algo of algos) {
    const interval = timeframeToInterval(algo.rules.timeframe);
    const bars = await getBarsNoTtl(supabase, algo.ticker, interval);
    if (!bars) continue;
    const result = runPortfolioBacktest(algo.rules, new Map([[algo.ticker, bars]]), algo.capital, []);
    const tagged = result.trades.map((t) => ({ ...t, ticker: algo.ticker, side: t.side ?? "long" }));
    baselineTradesByAlgo.set(algo.id, tagged);
  }
  console.log(`Pass 1 (baseline): collected trades for ${baselineTradesByAlgo.size} algos.\n`);

  // Pass 2: run each algo with sibling-blocking trades from all OTHER algos.
  let pass = 0, fail = 0, excluded = 0;
  for (const algo of algos) {
    const interval = timeframeToInterval(algo.rules.timeframe);
    const bars = await getBarsNoTtl(supabase, algo.ticker, interval);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pf = (algo.rules as any).prop_firm ?? {};
    const friction = {
      slippage_bps: pf.slippage_bps ?? 0,
      spread_bps: pf.spread_bps ?? 0,
      commission_per_lot: pf.commission_per_lot ?? 0,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const riskPct = ((algo.rules as any).position_sizing?.value ?? 1);

    // Build sibling list. For risk-pool: attach risk_dollars per-sibling
    // computed from THAT sibling's capital × risk_pct.
    let siblings: SiblingTradeWindow[] = [];
    if (ENABLE_SIBLINGS || ENABLE_RISK_POOL) {
      for (const [otherId, otherTrades] of baselineTradesByAlgo) {
        if (otherId === algo.id) continue;
        const otherAlgo = algos.find((a) => a.id === otherId);
        if (!otherAlgo) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const otherRiskPct = ((otherAlgo.rules as any).position_sizing?.value ?? 0) as number;
        const otherRiskDollars = otherAlgo.capital * (otherRiskPct / 100);
        siblings = siblings.concat(tradesAsSiblingWindows(otherTrades, otherRiskDollars));
      }
    }
    const spreadGate: SpreadGateConfig | null = ENABLE_SPREAD_GATE ? SPREAD_GATE_CONFIG : null;
    const riskPool: RiskPoolConfig | null = ENABLE_RISK_POOL
      ? { enabled: true, pool_cap_pct: POOL_CAP_PCT }
      : null;
    const fidelityFlags = { siblings: ENABLE_SIBLINGS, spread_gate: ENABLE_SPREAD_GATE, risk_pool: ENABLE_RISK_POOL };

    let results: GateResults;
    if (!bars) {
      results = analyzeStats([], algo.capital, friction, fidelityFlags, riskPct);
      results.step2.reason = "no bars in cache";
      results.promotion_blockers = ["no bars in cache"];
    } else {
      const result = runPortfolioBacktest(algo.rules, new Map([[algo.ticker, bars]]), algo.capital, [], null, null, siblings, spreadGate, riskPool);
      results = analyzeStats(result.trades, algo.capital, friction, fidelityFlags, riskPct);
    }
    if (results.promotion_eligible) pass++;
    else if (results.step2.verdict === "EXCLUDED") excluded++;
    else fail++;

    if (PERSIST) {
      await supabase.from("algorithms").update({ backtest_results: results }).eq("id", algo.id);
    }
    const flag = results.promotion_eligible ? "✓ ELIGIBLE" : (results.step2.verdict === "EXCLUDED" ? "— excluded" : "✗ blocked");
    console.log(`  ${flag.padEnd(11)} ${algo.name.padEnd(50)} $${results.step2.total_return.toString().padStart(8)} ${results.step2.total_trades.toString().padStart(4)}t WR${results.step2.win_rate}% S2:${results.step2.verdict} S3:${results.step3.verdict} S6:${results.step6.verdict}`);
    if (results.promotion_blockers.length > 0 && !results.promotion_eligible) {
      console.log(`    Blockers: ${results.promotion_blockers.slice(0, 3).join(" | ")}`);
    }
  }

  console.log(`\nSUMMARY: ${pass} ELIGIBLE / ${fail} BLOCKED / ${excluded} EXCLUDED\n`);
  console.log(`Phase B fidelity gates applied: siblings=${ENABLE_SIBLINGS}, spread_gate=${ENABLE_SPREAD_GATE}, risk_pool=${ENABLE_RISK_POOL} (cap=${POOL_CAP_PCT}%)`);
  console.log(`Compare to Phase A results (no gates) to measure fidelity impact.\n`);
}

void main();
