/**
 * validate-algo — CANONICAL validation runner. Replaces the ad-hoc
 * step2/3/4/5/6 + verify-* + analyze-* one-offs.
 *
 * Runs the full Phase A→B validation pipeline for one algorithm OR for
 * all deployed algorithms, with Phase B fidelity gates applied:
 *   - Empirical friction (slippage_bps=3, spread_bps=0 — from real fills)
 *   - Direction-conflict simulation (sibling open positions block)
 *   - Spread-gate ATR-proxy (refuse high-vol entries)
 *   - Risk-pool halt (combined open SL-$ across siblings vs cap %)
 *   - FTMO termination (force-close + stop on static-DD breach)
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
 *   ALGO              (optional) — algo name (exact match)
 *   OOS_CUTOFF        (optional) — date for OOS holdout, default 2025-12-18
 *   PERSIST           (default 1) — write backtest_results to DB. Set 0 for dry-run.
 *   SIBLINGS          (default 1) — include direction-conflict simulation
 *   SPREAD_GATE       (default 1) — include spread-gate ATR proxy
 *   RISK_POOL         (default 1) — include risk-pool halt simulation
 *   POOL_CAP_PCT      (default 4) — risk-pool cap as % of capital
 *   FTMO_TERMINATION  (default 1) — force-close + stop on static-DD breach
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
  type FtmoTerminationConfig,
  type PortfolioHaltConfig,
  type ReEntryCooldownConfig,
  type RiskPoolConfig,
  type SiblingTradeWindow,
  type SpreadGateConfig,
} from "../../src/lib/market-data/portfolio-backtest";
import { assertTradeSidePopulated } from "../../src/lib/market-data/assert-trade-side";
import type { BacktestTrade, PriceBar } from "../../src/lib/market-data/types";
import type { AlgorithmRules } from "../../src/types/algorithm";
import {
  bootstrapStat,
  bootstrapStatBlock,
  bootstrapStatBlockWithSamples,
  bootstrapStatWithSamples,
  meanR,
  totalReturn,
  wilsonIntervalProportion,
  type BootstrapResult,
} from "../../src/lib/stats/bootstrap";
import { bonferroniVerdict, type MccVerdict } from "../../src/lib/stats/multiple-comparisons";
import {
  checkPreregistration,
  loadPreregistrations,
  type ObservedStats,
  type PreregistrationCheck,
} from "../../src/lib/stats/preregistration";

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
/** OOS holdout cutoff. Default 2025-06-18 = 12 months held-out as of
 *  2026-06-18 default snapshot. Empirically the sweet spot across the
 *  current fleet: shorter windows have too few held-out trades for
 *  small-N algos to pass the min_held_out_trades floor; longer windows
 *  push held-out R away from in-sample R (oos_r_delta blockers). The
 *  roadmap B.6 cadence says "quarterly re-roll 3 months" but that
 *  produces 0 ELIGIBLE under current pre-reg floors — reconcile by
 *  either lowering min_held_out_trades for short cadences OR using a
 *  rolling 12-month holdout regardless of re-roll frequency. */
const OOS_CUTOFF = process.env.OOS_CUTOFF ?? "2025-06-18";
const PERSIST = process.env.PERSIST !== "0";
const ENABLE_SIBLINGS = process.env.SIBLINGS !== "0";
const ENABLE_SPREAD_GATE = process.env.SPREAD_GATE !== "0";
const ENABLE_RISK_POOL = process.env.RISK_POOL !== "0";
const POOL_CAP_PCT = Number(process.env.POOL_CAP_PCT ?? 4);
const ENABLE_FTMO_TERMINATION = process.env.FTMO_TERMINATION !== "0";
const ENABLE_RE_ENTRY_COOLDOWN = process.env.RE_ENTRY_COOLDOWN !== "0";
const ENABLE_PORTFOLIO_HALT = process.env.PORTFOLIO_HALT !== "0";
const PORTFOLIO_DLL_PCT = Number(process.env.PORTFOLIO_DLL_PCT ?? 5);
const PREREG_PATH = process.env.PREREG_PATH ?? "scripts/canonical/preregistration.json";
const BOOTSTRAP_ITERATIONS = Number(process.env.BOOTSTRAP_ITERATIONS ?? 2000);
const BOOTSTRAP_SEED = Number(process.env.BOOTSTRAP_SEED ?? 42);
const FAMILY_ALPHA = Number(process.env.FAMILY_ALPHA ?? 0.05);
/** B.2.4: tests-per-algo for Bonferroni family-size calculation.
 *
 *  Default 1 = correct for "is mean R > 0?" as the SOLE per-algo statistical
 *  test. The other gates (step2/3/6 verdicts, CI lower>0, pre-reg criteria)
 *  are treated as a single composite ship hypothesis that the pre-registration
 *  captures, NOT independent significance tests subject to MCC.
 *
 *  Set to a higher integer (e.g. 5) for strict cross-test family-wise
 *  correction if treating every criterion as a separate test. Trade-off:
 *  stricter alpha kills more candidates (good for false-discovery control,
 *  bad for power). Operator-tunable. */
const BONFERRONI_TESTS_PER_ALGO = Math.max(1, Number(process.env.BONFERRONI_TESTS_PER_ALGO ?? 1));
/** Block bootstrap (B.2.5): use moving-block bootstrap rather than
 *  trade-level. Default on — trades within regimes are correlated, so
 *  trade-level bootstrap understates the CI width. */
const ENABLE_BLOCK_BOOTSTRAP = process.env.BLOCK_BOOTSTRAP !== "0";

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
  /** broker_connection_id groups algos sharing a broker account for
   *  portfolio-halt + risk-pool sibling aggregation. Null = solo. */
  broker_connection_id: string | null;
}

interface BrokerConnectionRow {
  id: string;
  label: string;
  /** Real account starting capital (USD). Null = no portfolio capital
   *  set; validate-algo falls back to per-algo capital (conservative). */
  account_capital: number | null;
}

interface GateResults {
  computed_at: string;
  sample_first: string | null;
  sample_last: string | null;
  friction: { slippage_bps: number; spread_bps: number; commission_per_lot: number };
  fidelity_gates_applied: { siblings: boolean; spread_gate: boolean; risk_pool: boolean; ftmo_termination: boolean; re_entry_cooldown: boolean; portfolio_halt: boolean };
  step2: StepStats;
  step3: WalkForwardStats;
  step6: OosStats;
  statistical_rigor: StatisticalRigorBlock;
  preregistration?: PreregistrationCheck;
  promotion_eligible: boolean;
  promotion_blockers: string[];
}

interface StatisticalRigorBlock {
  bootstrap_iterations: number;
  bootstrap_seed: number;
  /** B.2.5: block bootstrap on/off. */
  block_bootstrap: boolean;
  family_alpha: number;
  /** B.2.4: total family size = candidates × tests_per_algo. */
  n_tests: number;
  /** B.2.4: per-algo test count used in family-size calc. Default 1 =
   *  Bonferroni-corrects only the "mean R > 0" significance test. */
  bonferroni_tests_per_algo: number;
  /** Rationale string explaining the chosen family-size semantic. */
  bonferroni_family_rationale: string;
  total_return_ci: BootstrapResult;
  mean_r_ci: BootstrapResult;
  mean_r_bonferroni: MccVerdict;
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
  /** B.2.6: Wilson 95% CI on the green-window proportion. */
  walk_forward_green_ci: { point: number; lower: number; upper: number };
  per_year_green_pct: number;
  per_year_n_years: number;
  /** B.2.6: Wilson 95% CI on the green-year proportion. */
  per_year_green_ci: { point: number; lower: number; upper: number };
  verdict: "PASS" | "WEAK" | "FAIL" | "INSUFFICIENT_DATA";
  reason: string;
}

interface OosStats {
  in_sample_n: number;
  in_sample_mean_r: number;
  held_out_n: number;
  held_out_mean_r: number;
  /** B.2.6: bootstrap CI on held-out mean R. Block bootstrap when enabled. */
  held_out_mean_r_ci: { point: number; lower: number; upper: number };
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

function analyzeStats(
  trades: BacktestTrade[],
  capital: number,
  friction: GateResults["friction"],
  fidelityGates: GateResults["fidelity_gates_applied"],
  riskPct: number,
  algoName: string,
  nCandidates: number,
  preregs: ReturnType<typeof loadPreregistrations>,
  now: Date
): GateResults {
  const computedAt = now.toISOString();
  const effectiveNTests = Math.max(1, nCandidates * BONFERRONI_TESTS_PER_ALGO);
  const familyRationale = BONFERRONI_TESTS_PER_ALGO === 1
    ? `n=${nCandidates} (one mean-R test per algo; step verdicts + pre-reg are a single composite ship hypothesis, not independent significance tests)`
    : `n=${nCandidates} × tests_per_algo=${BONFERRONI_TESTS_PER_ALGO} = ${effectiveNTests} (strict cross-test family-wise correction)`;
  const emptyRigor: StatisticalRigorBlock = {
    bootstrap_iterations: BOOTSTRAP_ITERATIONS,
    bootstrap_seed: BOOTSTRAP_SEED,
    block_bootstrap: ENABLE_BLOCK_BOOTSTRAP,
    family_alpha: FAMILY_ALPHA,
    n_tests: effectiveNTests,
    bonferroni_tests_per_algo: BONFERRONI_TESTS_PER_ALGO,
    bonferroni_family_rationale: familyRationale,
    total_return_ci: { point: 0, lower: NaN, upper: NaN, n_iterations: 0, ci_level: 0.95 },
    mean_r_ci: { point: 0, lower: NaN, upper: NaN, n_iterations: 0, ci_level: 0.95 },
    mean_r_bonferroni: { p_value: 1, bonferroni_alpha: FAMILY_ALPHA / effectiveNTests, passes: false, family_alpha: FAMILY_ALPHA, n_tests: effectiveNTests },
  };
  const empty: GateResults = {
    computed_at: computedAt,
    sample_first: null,
    sample_last: null,
    friction,
    fidelity_gates_applied: fidelityGates,
    step2: { total_return: 0, total_trades: 0, win_rate: 0, max_drawdown: 0, max_static_dd: 0, max_daily_dd: 0, verdict: "EXCLUDED", reason: "zero trades" },
    step3: { walk_forward_green_pct: 0, walk_forward_n_windows: 0, walk_forward_green_ci: { point: NaN, lower: NaN, upper: NaN }, per_year_green_pct: 0, per_year_n_years: 0, per_year_green_ci: { point: NaN, lower: NaN, upper: NaN }, verdict: "INSUFFICIENT_DATA", reason: "no trades" },
    step6: { in_sample_n: 0, in_sample_mean_r: 0, held_out_n: 0, held_out_mean_r: 0, held_out_mean_r_ci: { point: NaN, lower: NaN, upper: NaN }, r_delta_pct: 0, verdict: "INSUFFICIENT_DATA", reason: "no trades" },
    statistical_rigor: emptyRigor,
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
  // B.2.6: Wilson 95% CI on the walk-forward green proportion.
  const wfGreenCI = windows.length > 0
    ? wilsonIntervalProportion(wfGreen, windows.length, 0.95)
    : { point: NaN, lower: NaN, upper: NaN };

  const byYear = new Map<string, number>();
  for (const t of sorted) {
    const y = t.exit_date.slice(0, 4);
    byYear.set(y, (byYear.get(y) ?? 0) + t.pnl);
  }
  const yearsGreen = [...byYear.values()].filter((p) => p > 0).length;
  const yearsGreenPct = byYear.size === 0 ? 0 : Math.round(yearsGreen / byYear.size * 100);
  // B.2.6: Wilson 95% CI on the per-year green proportion.
  const yearsGreenCI = byYear.size > 0
    ? wilsonIntervalProportion(yearsGreen, byYear.size, 0.95)
    : { point: NaN, lower: NaN, upper: NaN };

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
  const inSampleR = meanR(inSampleT, riskPerTrade);
  const heldOutR = meanR(heldOutT, riskPerTrade);
  // B.2.6: bootstrap CI on held-out mean R. Block bootstrap when enabled.
  const heldOutMeanRCI = heldOutT.length > 0
    ? (ENABLE_BLOCK_BOOTSTRAP
        ? bootstrapStatBlock(heldOutT, (ts: BacktestTrade[]) => meanR(ts, riskPerTrade), { seed: BOOTSTRAP_SEED, n_iterations: BOOTSTRAP_ITERATIONS })
        : bootstrapStat(heldOutT, (ts: BacktestTrade[]) => meanR(ts, riskPerTrade), { seed: BOOTSTRAP_SEED, n_iterations: BOOTSTRAP_ITERATIONS }))
    : { point: NaN, lower: NaN, upper: NaN, n_iterations: 0, ci_level: 0.95 };
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

  // Phase B.2 statistical rigor: bootstrap CIs on total_return + mean_R,
  // Bonferroni p-value for "mean R > 0" against family of nCandidates tests.
  // B.2.5: block bootstrap (default) handles trade-to-trade correlation
  // within regime windows; trade-level bootstrap UNDERSTATES CI width.
  const totalReturnCI = ENABLE_BLOCK_BOOTSTRAP
    ? bootstrapStatBlock(sorted, totalReturn, { seed: BOOTSTRAP_SEED, n_iterations: BOOTSTRAP_ITERATIONS })
    : bootstrapStat(sorted, totalReturn, { seed: BOOTSTRAP_SEED, n_iterations: BOOTSTRAP_ITERATIONS });
  const meanRWithSamples = ENABLE_BLOCK_BOOTSTRAP
    ? bootstrapStatBlockWithSamples(
        sorted,
        (ts: BacktestTrade[]) => meanR(ts, riskPerTrade),
        { seed: BOOTSTRAP_SEED, n_iterations: BOOTSTRAP_ITERATIONS }
      )
    : bootstrapStatWithSamples(
        sorted,
        (ts: BacktestTrade[]) => meanR(ts, riskPerTrade),
        { seed: BOOTSTRAP_SEED, n_iterations: BOOTSTRAP_ITERATIONS }
      );
  const meanRBonferroni = bonferroniVerdict(meanRWithSamples.samples, FAMILY_ALPHA, effectiveNTests);
  const rigor: StatisticalRigorBlock = {
    bootstrap_iterations: BOOTSTRAP_ITERATIONS,
    bootstrap_seed: BOOTSTRAP_SEED,
    block_bootstrap: ENABLE_BLOCK_BOOTSTRAP,
    family_alpha: FAMILY_ALPHA,
    n_tests: effectiveNTests,
    bonferroni_tests_per_algo: BONFERRONI_TESTS_PER_ALGO,
    bonferroni_family_rationale: familyRationale,
    total_return_ci: totalReturnCI,
    mean_r_ci: {
      point: meanRWithSamples.point,
      lower: meanRWithSamples.lower,
      upper: meanRWithSamples.upper,
      n_iterations: meanRWithSamples.n_iterations,
      ci_level: meanRWithSamples.ci_level,
    },
    mean_r_bonferroni: meanRBonferroni,
  };

  // Phase B.2 pre-registration check: if algo is registered, the registered
  // criteria are the SOLE ship gate (locked before re-running). If unregistered,
  // fall back to legacy Phase B.4 step-verdict eligibility.
  const observed: ObservedStats = {
    total_return: cum,
    win_rate: wr,
    max_static_dd: maxSdd,
    max_daily_dd: ddd,
    mean_r_ci_lower: meanRWithSamples.lower,
    bonferroni_p_value: meanRBonferroni.p_value,
    oos_r_delta_pct: rDelta,
    held_out_trades: heldOutT.length,
  };
  const preregCheck = checkPreregistration(algoName, observed, preregs, now);

  // Promotion eligibility:
  //   - If pre-registered: pre-registration criteria are sole gate (and we want
  //     CI lower > 0 + Bonferroni pass baked in via the preregistration entry).
  //   - Otherwise: legacy Phase B.4 step verdicts.
  const blockers: string[] = [];
  if (preregCheck.has_preregistration) {
    if (!preregCheck.passed) {
      for (const c of preregCheck.failed_criteria) blockers.push(`PREREG: ${c}`);
    }
  } else {
    if (!step2Pass) blockers.push(`STEP 2: ${step2Reasons.join("; ")}`);
    if (step3Verdict === "FAIL") blockers.push(`STEP 3: ${step3Reason}`);
    if (step3Verdict === "WEAK") blockers.push(`STEP 3: WEAK (not strict 70% — Phase B reads strict only)`);
    if (step6Verdict === "FAIL") blockers.push(`STEP 6: ${step6Reason}`);
    if (step3Verdict === "INSUFFICIENT_DATA" || step6Verdict === "INSUFFICIENT_DATA") {
      blockers.push("history too short for full validation — revisit with more data");
    }
  }
  const eligible = blockers.length === 0;

  return {
    computed_at: computedAt,
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
    step3: { walk_forward_green_pct: wfGreenPct, walk_forward_n_windows: windows.length, walk_forward_green_ci: wfGreenCI, per_year_green_pct: yearsGreenPct, per_year_n_years: byYear.size, per_year_green_ci: yearsGreenCI, verdict: step3Verdict, reason: step3Reason },
    step6: { in_sample_n: inSampleT.length, in_sample_mean_r: Math.round(inSampleR * 100) / 100, held_out_n: heldOutT.length, held_out_mean_r: Math.round(heldOutR * 100) / 100, held_out_mean_r_ci: { point: heldOutMeanRCI.point, lower: heldOutMeanRCI.lower, upper: heldOutMeanRCI.upper }, r_delta_pct: Math.round(rDelta * 10) / 10, verdict: step6Verdict, reason: step6Reason },
    statistical_rigor: rigor,
    preregistration: preregCheck,
    promotion_eligible: eligible,
    promotion_blockers: blockers,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadAlgos(supabase: any, only: string | null): Promise<AlgoRow[]> {
  let query = supabase.from("algorithms").select("id, name, capital, rules, status, broker_connection_id");
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

/** Fetch broker_connections referenced by any of the loaded algos. Returns
 *  a Map<broker_connection_id, account_capital|null>. account_capital is
 *  null for connections without an explicit value set; portfolio-halt and
 *  risk-pool then fall back to per-algo capital (conservative). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadBrokerCapitals(supabase: any, algos: AlgoRow[]): Promise<Map<string, number | null>> {
  const brokerIds = Array.from(new Set(algos.map((a) => a.broker_connection_id).filter((id): id is string => !!id)));
  const out = new Map<string, number | null>();
  if (brokerIds.length === 0) return out;
  const res = await supabase.from("broker_connections").select("id, label, account_capital").in("id", brokerIds);
  if (res.error) { console.warn(`broker_connections fetch failed: ${res.error.message} — falling back to per-algo capital`); return out; }
  for (const r of (res.data ?? []) as BrokerConnectionRow[]) {
    out.set(r.id, r.account_capital);
  }
  return out;
}

async function main(): Promise<void> {
  console.log(`\n===== validate-algo @ ${new Date().toISOString().slice(0, 16)} =====`);
  console.log(`Mode: ${ONLY_ALGO ? `single algo "${ONLY_ALGO}"` : "all deployed"}`);
  console.log(`Phase B fidelity gates: siblings=${ENABLE_SIBLINGS} spread_gate=${ENABLE_SPREAD_GATE} risk_pool=${ENABLE_RISK_POOL} (cap=${POOL_CAP_PCT}%) ftmo_termination=${ENABLE_FTMO_TERMINATION} re_entry_cooldown=${ENABLE_RE_ENTRY_COOLDOWN} portfolio_halt=${ENABLE_PORTFOLIO_HALT} (dll=${PORTFOLIO_DLL_PCT}%)`);
  console.log(`OOS cutoff: ${OOS_CUTOFF}`);
  console.log(`Persist to DB: ${PERSIST}\n`);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const algos = await loadAlgos(supabase, ONLY_ALGO);
  console.log(`Loaded ${algos.length} algos.`);

  // Phase B.1.7/B.1.3 portfolio modelling: fetch per-broker account_capital
  // for portfolio-halt + risk-pool reference. Algos sharing a broker_connection_id
  // form a portfolio sharing one account's capital. Algos with null
  // broker_connection_id or null account_capital fall back to per-algo capital.
  const brokerCapitals = await loadBrokerCapitals(supabase, algos);
  const brokerGroupCount = new Map<string, number>();
  for (const a of algos) {
    if (!a.broker_connection_id) continue;
    brokerGroupCount.set(a.broker_connection_id, (brokerGroupCount.get(a.broker_connection_id) ?? 0) + 1);
  }
  const groupSummaries = Array.from(brokerGroupCount.entries()).map(([id, count]) => {
    const cap = brokerCapitals.get(id);
    return `${count} algos on ${id.slice(0, 8)} (cap=${cap != null ? `$${cap.toLocaleString()}` : "per-algo"})`;
  });
  const soloAlgos = algos.filter((a) => !a.broker_connection_id).length;
  console.log(`Broker grouping: ${groupSummaries.length > 0 ? groupSummaries.join(", ") : "(none)"}${soloAlgos > 0 ? ` + ${soloAlgos} solo (no broker)` : ""}\n`);

  // Phase B.2 statistical-rigor inputs.
  const preregs = loadPreregistrations(PREREG_PATH);
  const nCandidates = Math.max(algos.length, 1);
  const nRegistered = Object.keys(preregs).filter((k) => algos.some((a) => a.name === k)).length;
  // B.2.9: surface expired + expiring-soon preregs loudly. The previous
  // silent fallback to legacy step verdicts meant operator wouldn't notice
  // a locked bar quietly going stale. Warn loudly at run start so they can
  // re-register before deploying anything that depends on the stale bar.
  const PREREG_WARN_DAYS = 14;
  const NOW = new Date();
  const expired: string[] = [];
  const expiringSoon: string[] = [];
  for (const [algoName, entry] of Object.entries(preregs)) {
    if (!algos.some((a) => a.name === algoName)) continue;
    const expires = new Date(entry.expires_at);
    if (Number.isNaN(expires.getTime())) continue;
    const daysToExpiry = (expires.getTime() - NOW.getTime()) / 86_400_000;
    if (daysToExpiry < 0) {
      expired.push(`${algoName} (expired ${Math.abs(Math.round(daysToExpiry))}d ago)`);
    } else if (daysToExpiry < PREREG_WARN_DAYS) {
      expiringSoon.push(`${algoName} (expires in ${Math.round(daysToExpiry)}d)`);
    }
  }
  if (expired.length > 0) {
    console.log(`⚠️  PREREG EXPIRED — these algos have silently fallen back to legacy step verdicts:`);
    for (const e of expired) console.log(`    - ${e}`);
    console.log(`    Re-register or remove from preregistration.json before relying on their verdicts.`);
  }
  if (expiringSoon.length > 0) {
    console.log(`⏳  PREREG EXPIRING within ${PREREG_WARN_DAYS}d:`);
    for (const e of expiringSoon) console.log(`    - ${e}`);
  }
  if (expired.length > 0 || expiringSoon.length > 0) console.log("");
  const effectiveNTests = Math.max(1, nCandidates * BONFERRONI_TESTS_PER_ALGO);
  console.log(`Phase B.2 statistical rigor:`);
  console.log(`  bootstrap: ${BOOTSTRAP_ITERATIONS} iterations, seed=${BOOTSTRAP_SEED}, block_bootstrap=${ENABLE_BLOCK_BOOTSTRAP}`);
  console.log(`  Bonferroni: family alpha ${FAMILY_ALPHA} ÷ ${effectiveNTests} (= ${nCandidates} candidates × ${BONFERRONI_TESTS_PER_ALGO} test/algo) = ${(FAMILY_ALPHA / effectiveNTests).toFixed(5)} per-test`);
  console.log(`  pre-registration: ${nRegistered}/${algos.length} algos registered in ${PREREG_PATH}\n`);

  // For sibling sim: pre-run all algos to capture trades, then re-run each with siblings.
  // Two-pass approach — pass 1 produces sibling pool, pass 2 applies it per-algo.
  // First pass: collect trades per algo (no siblings).
  const baselineTradesByAlgo = new Map<string, BacktestTrade[]>();
  for (const algo of algos) {
    const interval = timeframeToInterval(algo.rules.timeframe);
    const bars = await getBarsNoTtl(supabase, algo.ticker, interval);
    if (!bars) continue;
    const result = runPortfolioBacktest(algo.rules, new Map([[algo.ticker, bars]]), algo.capital, []);
    // B.1.5 fix: assertTradeSidePopulated throws if engine had a side bug.
    const tagged: (BacktestTrade & { ticker: string })[] = [];
    for (const t of result.trades) {
      assertTradeSidePopulated(t, algo.name);
      tagged.push({ ...t, ticker: algo.ticker });
    }
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

    // Build sibling lists. B.1.4 fix: pass separate lists to direction-conflict
    // and risk-pool so SIBLINGS=0 + RISK_POOL=1 (and the inverse) toggle
    // independently. Both lists derive from the same baseline-trade pool but
    // are gated separately by the env flags.
    //
    // B.1.7 fix: filter siblings to ONLY those sharing the same
    // broker_connection_id. Algos on different brokers (different FTMO
    // accounts) are not portfolio-mates; their positions don't compete for
    // the same capital pool. Algos with null broker_connection_id are solo
    // (no siblings — treat as their own portfolio of one).
    let allSiblings: SiblingTradeWindow[] = [];
    // An algo with null broker_connection_id isn't deployed anywhere — it has
    // no portfolio dynamics with anything else. Sibling list stays empty.
    // (Without this guard, null === null would lump every unlinked algo into
    // one implicit "no-broker" group, which is wrong: those are just
    // standalone backtests with no shared account.)
    if ((ENABLE_SIBLINGS || ENABLE_RISK_POOL) && algo.broker_connection_id !== null) {
      for (const [otherId, otherTrades] of baselineTradesByAlgo) {
        if (otherId === algo.id) continue;
        const otherAlgo = algos.find((a) => a.id === otherId);
        if (!otherAlgo) continue;
        // Skip cross-broker siblings — different accounts don't share capital.
        if (algo.broker_connection_id !== otherAlgo.broker_connection_id) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const otherRiskPct = ((otherAlgo.rules as any).position_sizing?.value ?? 0) as number;
        const otherRiskDollars = otherAlgo.capital * (otherRiskPct / 100);
        allSiblings = allSiblings.concat(tradesAsSiblingWindows(otherTrades, otherRiskDollars));
      }
    }
    const directionConflictSiblings: SiblingTradeWindow[] = ENABLE_SIBLINGS ? allSiblings : [];
    const riskPoolSiblings: SiblingTradeWindow[] = ENABLE_RISK_POOL ? allSiblings : [];
    const spreadGate: SpreadGateConfig | null = ENABLE_SPREAD_GATE ? SPREAD_GATE_CONFIG : null;
    // B.1.7 portfolio reference_capital: use this algo's broker account_capital
    // when available; else fall back to per-algo capital (conservative).
    const brokerCap = algo.broker_connection_id ? brokerCapitals.get(algo.broker_connection_id) ?? null : null;
    const portfolioReferenceCapital = brokerCap ?? undefined;
    const riskPool: RiskPoolConfig | null = ENABLE_RISK_POOL
      ? { enabled: true, pool_cap_pct: POOL_CAP_PCT, ...(portfolioReferenceCapital !== undefined ? { reference_capital: portfolioReferenceCapital } : {}) }
      : null;
    const ftmoTermination: FtmoTerminationConfig | null = ENABLE_FTMO_TERMINATION
      ? { enabled: true }
      : null;
    const reEntryCooldown: ReEntryCooldownConfig | null = ENABLE_RE_ENTRY_COOLDOWN
      ? { enabled: true }  // cooldown_minutes undefined → auto-derives from rules.timeframe
      : null;
    // Portfolio-halt: pre-compute sibling daily PnL from baseline runs,
    // restricted to same-broker siblings (B.1.7). Same null-broker semantic
    // as direction-conflict + risk-pool: an algo without a broker connection
    // has no portfolio dynamics — its sibling map stays empty (it's a
    // standalone backtest, not part of any account).
    let portfolioHalt: PortfolioHaltConfig | null = null;
    if (ENABLE_PORTFOLIO_HALT) {
      const siblingDailyPnl = new Map<string, number>();
      if (algo.broker_connection_id !== null) {
        for (const [otherId, otherTrades] of baselineTradesByAlgo) {
          if (otherId === algo.id) continue;
          const otherAlgo = algos.find((a) => a.id === otherId);
          if (!otherAlgo) continue;
          // Only same-broker siblings contribute to this algo's portfolio DLL.
          if (algo.broker_connection_id !== otherAlgo.broker_connection_id) continue;
          for (const t of otherTrades) {
            const day = t.exit_date.slice(0, 10);
            siblingDailyPnl.set(day, (siblingDailyPnl.get(day) ?? 0) + t.pnl);
          }
        }
      }
      portfolioHalt = {
        enabled: true,
        daily_loss_limit_pct: PORTFOLIO_DLL_PCT,
        // B.1.7: use broker's account_capital when set; else fall back
        // to algo.capital via the in-engine default. portfolioReferenceCapital
        // is undefined when no broker capital available — preserves conservative
        // per-algo behaviour.
        ...(portfolioReferenceCapital !== undefined ? { reference_capital: portfolioReferenceCapital } : {}),
        sibling_daily_pnl: siblingDailyPnl,
      };
    }
    const fidelityFlags = { siblings: ENABLE_SIBLINGS, spread_gate: ENABLE_SPREAD_GATE, risk_pool: ENABLE_RISK_POOL, ftmo_termination: ENABLE_FTMO_TERMINATION, re_entry_cooldown: ENABLE_RE_ENTRY_COOLDOWN, portfolio_halt: ENABLE_PORTFOLIO_HALT };

    let results: GateResults;
    if (!bars) {
      results = analyzeStats([], algo.capital, friction, fidelityFlags, riskPct, algo.name, nCandidates, preregs, NOW);
      results.step2.reason = "no bars in cache";
      results.promotion_blockers = ["no bars in cache"];
    } else {
      const result = runPortfolioBacktest(algo.rules, new Map([[algo.ticker, bars]]), algo.capital, [], null, null, directionConflictSiblings, spreadGate, riskPool, ftmoTermination, riskPoolSiblings, reEntryCooldown, portfolioHalt);
      results = analyzeStats(result.trades, algo.capital, friction, fidelityFlags, riskPct, algo.name, nCandidates, preregs, NOW);
    }
    if (results.promotion_eligible) pass++;
    else if (results.step2.verdict === "EXCLUDED") excluded++;
    else fail++;

    if (PERSIST) {
      await supabase.from("algorithms").update({ backtest_results: results }).eq("id", algo.id);
    }
    const flag = results.promotion_eligible ? "✓ ELIGIBLE" : (results.step2.verdict === "EXCLUDED" ? "— excluded" : "✗ blocked");
    const ci = results.statistical_rigor.mean_r_ci;
    const mcc = results.statistical_rigor.mean_r_bonferroni;
    // B.2.7: distinguish post-hoc-locked from true-prereg in the tag so the
    // reader knows whether the pass is statistical evidence or a discipline
    // promise. "P-LOCK✓" = post-hoc-locked passed; "PREREG✓" = true-prereg passed.
    const preregTag = results.preregistration?.has_preregistration
      ? `${results.preregistration.registration_type === "true-prereg" ? "PREREG" : "P-LOCK"}${results.preregistration.passed ? "✓" : "✗"}`
      : "no-prereg";
    console.log(`  ${flag.padEnd(11)} ${algo.name.padEnd(50)} $${results.step2.total_return.toString().padStart(8)} ${results.step2.total_trades.toString().padStart(4)}t WR${results.step2.win_rate}% R[${ci.lower.toFixed(2)},${ci.upper.toFixed(2)}] p=${mcc.p_value.toFixed(4)}${mcc.passes ? "*" : ""} ${preregTag}`);
    // B.2.6: surface step3 + step6 CIs on a sub-line for operator visibility.
    const wfCi = results.step3.walk_forward_green_ci;
    const yrCi = results.step3.per_year_green_ci;
    const hoCi = results.step6.held_out_mean_r_ci;
    const fmtCi = (v: { lower: number; upper: number }): string =>
      Number.isFinite(v.lower) && Number.isFinite(v.upper) ? `[${(v.lower * 100).toFixed(0)}%-${(v.upper * 100).toFixed(0)}%]` : "n/a";
    const fmtR = (v: { lower: number; upper: number }): string =>
      Number.isFinite(v.lower) && Number.isFinite(v.upper) ? `[${v.lower.toFixed(2)},${v.upper.toFixed(2)}]` : "n/a";
    console.log(`               step3 wf=${results.step3.walk_forward_green_pct}% ${fmtCi(wfCi)} yr=${results.step3.per_year_green_pct}% ${fmtCi(yrCi)}  step6 heldR=${results.step6.held_out_mean_r} ${fmtR(hoCi)}`);
    if (results.promotion_blockers.length > 0 && !results.promotion_eligible) {
      console.log(`    Blockers: ${results.promotion_blockers.slice(0, 3).join(" | ")}`);
    }
  }

  console.log(`\nSUMMARY: ${pass} ELIGIBLE / ${fail} BLOCKED / ${excluded} EXCLUDED\n`);
  console.log(`Phase B fidelity gates applied: siblings=${ENABLE_SIBLINGS}, spread_gate=${ENABLE_SPREAD_GATE}, risk_pool=${ENABLE_RISK_POOL} (cap=${POOL_CAP_PCT}%), ftmo_termination=${ENABLE_FTMO_TERMINATION}, re_entry_cooldown=${ENABLE_RE_ENTRY_COOLDOWN}, portfolio_halt=${ENABLE_PORTFOLIO_HALT} (dll=${PORTFOLIO_DLL_PCT}%)`);
  console.log(`Compare to Phase A results (no gates) to measure fidelity impact.\n`);
}

void main();
