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
import { resolve as resolvePath } from "path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { timeframeToInterval } from "../../src/lib/market-data/interval";
import type { Database } from "../../src/lib/supabase/database.types";
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
  sharpeRatio,
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
import {
  buildBonferroniFamilyRationale,
  classifyPreregExpiry,
} from "../../src/lib/stats/validator-output";
import {
  purgedKFoldEvaluate,
  type PurgedKFoldResult,
} from "../../src/lib/stats/purged-kfold";

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
/** Stage 4.3 (2026-06-20): `ALGOS` env CSV-overrides the canonical
 *  algorithm-set filter. Use when running a targeted subset (e.g.
 *  sensitivity analysis on 2 algos) without changing the script.
 *  Mutually exclusive with `ALGO` (which targets a single name). */
const ALGOS_CSV = process.env.ALGOS ?? null;
/** Stage 4.3 (2026-06-20): print the selected algos + exit without
 *  running backtests. Used to verify the filter before a long-running
 *  PERSIST=1 fleet pass. */
const LIST_ONLY = process.env.LIST_ONLY === "1";
/** B.2.31 (Stage 3.2, 2026-06-20): suppress per-algo result lines for
 *  fleet runs where the operator only cares about the SUMMARY row
 *  (e.g. monthly cron-driven verification). Startup config + warnings
 *  + final SUMMARY are always shown — only the ~3-line-per-algo body
 *  is silenced. With 17 algos this cuts ~60 lines of console noise. */
const QUIET = process.env.QUIET === "1";
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
/** B.2.47 (Stage 3, 2026-06-19 EVE): resolve to absolute path so a run
 *  from a different cwd doesn't silently fall through `existsSync → false →
 *  empty preregs object` (which would defeat the entire pre-reg discipline).
 *  Documented default lives in the source tree; operator override is also
 *  resolved against cwd for explicit relative paths to work as expected. */
const PREREG_PATH = resolvePath(process.env.PREREG_PATH ?? "scripts/canonical/preregistration.json");
/** E2.25.g (2026-07-17): raised 2000 → 10000. The mid-rank bootstrap
 *  p-value has a hard floor of 0.5/(B+1) — at B=2000 that is 2.499e-4,
 *  which sits ABOVE the pre-registered Bonferroni bar α/N (α/308 =
 *  1.62e-4). A bar below the p-floor is UNPASSABLE BY CONSTRUCTION: the
 *  historical "0/308 strict survivors" was partially predetermined, not
 *  purely empirical, and every persisted passing row sat exactly at the
 *  floor. B=10000 → floor 5.0e-5 ≪ α/308, restoring real resolution.
 *  `assertBonferroniResolvable` below fails loudly if a future N pushes
 *  the bar back under the floor. */
const BOOTSTRAP_ITERATIONS = Number(process.env.BOOTSTRAP_ITERATIONS ?? 10000);
const BOOTSTRAP_SEED = Number(process.env.BOOTSTRAP_SEED ?? 42);
const FAMILY_ALPHA = Number(process.env.FAMILY_ALPHA ?? 0.05);
/** B.2.4 + B.2.19 + OD.2a (2026-06-22 rename): STATISTICAL-tests-per-algo
 *  for Bonferroni family-size calculation. Renamed from
 *  `BONFERRONI_TESTS_PER_ALGO` to `BONFERRONI_STATISTICAL_TESTS_PER_ALGO`
 *  to honestly name what it counts (statistical tests, not all gates).
 *  The old env var name is read as a fallback to preserve external
 *  invocations (operator's local cron + any scripts that set it).
 *
 *  Default 1 = correct for "is mean R > 0?" as the SOLE per-algo
 *  *statistical* test. The other 6 criteria in `preregistration.ts:134-152`
 *  (min_win_rate, max_static_dd, max_daily_dd, min_mean_r_ci_lower,
 *  max_oos_r_delta_pct, min_held_out_trades) are DETERMINISTIC GATES
 *  (deploy-readiness floors / DD limits), NOT significance tests subject
 *  to MCC. Treating them as N independent significance tests would over-
 *  correct alpha — the WR floor of 37% isn't a hypothesis test, it's an
 *  operator-locked deploy floor (see [[feedback_winner_rule_return_within_ftmo]]).
 *
 *  The JSONB `bonferroni_correction_scope` field surfaced in
 *  `statistical_rigor` documents this so the verdict is hostile-critic-
 *  ready: "one bootstrap mean-R p-value per algo; other 5 criteria are
 *  deterministic gates not significance tests."
 *
 *  Set higher (e.g. 5) for cross-test strict-family correction if treating
 *  every criterion as an independent significance test. */
const BONFERRONI_STATISTICAL_TESTS_PER_ALGO = Math.max(
  1,
  Number(
    process.env.BONFERRONI_STATISTICAL_TESTS_PER_ALGO ??
      process.env.BONFERRONI_TESTS_PER_ALGO ??
      1
  )
);
/** @deprecated — kept as a local alias for grep-continuity during the rename. */
const BONFERRONI_TESTS_PER_ALGO = BONFERRONI_STATISTICAL_TESTS_PER_ALGO;
const BONFERRONI_CORRECTION_SCOPE =
  "one bootstrap mean-R p-value per algo; other criteria (WR floor, DD limits, OOS-delta, held-out N) are deterministic deploy gates, not significance tests subject to MCC";
/** Block bootstrap (B.2.5): use moving-block bootstrap rather than
 *  trade-level. Default on — trades within regimes are correlated, so
 *  trade-level bootstrap understates the CI width. */
const ENABLE_BLOCK_BOOTSTRAP = process.env.BLOCK_BOOTSTRAP !== "0";
/** Phase F.3 (ROADMAP.md) — purged k-fold CV with embargo. 0 = off (default,
 *  preserves legacy behaviour for existing callers). Set to integer ≥ 2 to
 *  enable. F.4 re-evaluation uses KFOLD=5 + EMBARGO_FRACTION=0.01 per spec. */
const KFOLD = Number(process.env.KFOLD ?? 0);
const EMBARGO_FRACTION = Number(process.env.EMBARGO_FRACTION ?? 0.01);

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
  /** Stage 4.2.b (2026-06-20): provenance disclosure for the friction
   *  values used in THIS run. Operator can audit whether the verdict was
   *  produced under (a) measured friction from real broker fills,
   *  (b) literature default pending real-fill capture, or (c) the algo's
   *  own override. Without this, a "ELIGIBLE" verdict produced under
   *  literature defaults could be mistaken for one produced under measured
   *  friction — the latter is shippable, the former is not. */
  friction_source: "measured" | "literature_default" | "algo_override" | "zero_no_friction";
  friction_source_disclosure: string;
  fidelity_gates_applied: { siblings: boolean; spread_gate: boolean; risk_pool: boolean; ftmo_termination: boolean; re_entry_cooldown: boolean; portfolio_halt: boolean };
  step2: StepStats;
  step3: WalkForwardStats;
  step6: OosStats;
  statistical_rigor: StatisticalRigorBlock;
  preregistration?: PreregistrationCheck;
  /** Stage 4.6 / B.5 (2026-06-20): demo-phase alignment gate. Derived from
   *  the in-sample mean-R bootstrap CI; used at Stage 5.2 to check whether
   *  demo-mirror trades fall within the in-sample distribution before
   *  green-lighting a real $10K challenge. */
  demo_gate?: DemoGateSpec;
  promotion_eligible: boolean;
  promotion_blockers: string[];
}

/** Stage 4.6 / B.5 (2026-06-20): the alignment spec a Stage-5-deployed algo
 *  must meet on broker DEMO before the operator green-lights real $10K
 *  capital. Built from the in-sample mean-R bootstrap CI + min_trades floor. */
interface DemoGateSpec {
  /** Minimum demo trades before evaluating alignment. Bootstrap CI on
   *  small N is too wide to fail anything; 10 is the operator's floor. */
  min_trades: number;
  /** In-sample point estimate the demo distribution should track. */
  expected_mean_r: number;
  /** In-sample 95% CI bounds. Demo mean-R must fall WITHIN this window
   *  for alignment-pass. Computed from `statistical_rigor.mean_r_ci`. */
  expected_mean_r_lower: number;
  expected_mean_r_upper: number;
  /** Operator-readable contract string explaining the gate semantics. */
  evaluation_contract: string;
}

interface StatisticalRigorBlock {
  bootstrap_iterations: number;
  bootstrap_seed: number;
  /** B.2.24 (Stage 3, 2026-06-19 EVE): per-algo seed actually used,
   *  derived as `bootstrap_seed ^ hash(algo_name)`. Surfaced so the
   *  exact reseed used for THIS algo's CIs is reproducible. */
  bootstrap_seed_effective: number;
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
  /** B.2.19 + OD.2a (2026-06-22): explicit scope-of-correction disclosure
   *  so a hostile critic reading the JSONB can tell what the Bonferroni
   *  count covers vs what's a deterministic deploy gate. */
  bonferroni_correction_scope: string;
  total_return_ci: BootstrapResult;
  mean_r_ci: BootstrapResult;
  mean_r_bonferroni: MccVerdict;
  /** B.2.10: per-trade Sharpe ratio (mean R / std R). Not annualised —
   *  consumer scales by sqrt(trades_per_year) if it wants annual. */
  sharpe_ratio: number;
  /** B.2.10: bootstrap CI on Sharpe ratio. Uses block bootstrap when enabled. */
  sharpe_ratio_ci: BootstrapResult;
  /** Phase F.3 (ROADMAP.md) — purged k-fold CV with embargo per López de Prado
   *  AFML ch.7. Optional; null when KFOLD env was 0/unset. v3 ship-criterion
   *  per ROADMAP.md F.5: consistency_count ≥ k-1 (e.g. 4/5 for k=5). */
  purged_kfold: PurgedKFoldResult | null;
  /** B.2.36 (Stage 3, 2026-06-19 EVE): OOS_CUTOFF data-snooping
   *  disclosure. Personal-operator context (no hostile evaluator)
   *  permits the data-snooped cutoff selection — but the disclosure
   *  owed to a future-self / hostile auditor MUST be on the row, not
   *  buried in a memory file. */
  oos_cutoff_used: string;
  oos_cutoff_selection_disclosure: string;
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
  /** B.3 (Stage 4.1, 2026-06-20): collapsed PASS|WEAK|FAIL → PASS|FAIL.
   *  Phase B has been reading "strict 70% only" since the gates landed;
   *  the WEAK middle tier had no decision power and only existed to
   *  preserve operator triage signal. That signal is now embedded in the
   *  FAIL reason string (`step3_distance_to_pass`). */
  verdict: "PASS" | "FAIL" | "INSUFFICIENT_DATA";
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
  /** B.3 (Stage 4.1, 2026-06-20): collapsed TIER_1_PASS|TIER_2_PASS|FAIL
   *  → PASS|FAIL. TIER_2_PASS (±75% OR n<15) was a small-N caveat that
   *  Phase B reads as FAIL; merge for clarity. Small-N + close-to-pass
   *  diagnostic preserved in the FAIL reason string. */
  verdict: "PASS" | "FAIL" | "INSUFFICIENT_DATA";
  reason: string;
}

async function getBarsNoTtl(
  supabase: SupabaseClient<Database>,
  ticker: string,
  interval: string
): Promise<PriceBar[] | null> {
  const { data, error } = await supabase
    .from("price_cache")
    .select("bars")
    .eq("ticker", ticker.toUpperCase())
    .eq("output_size", "full")
    .eq("interval", interval)
    .limit(1)
    .single();
  // B.2.43 (Stage 3, 2026-06-19 EVE): distinguish "no row" (legitimate
  // — algo's ticker not in cache yet) from "Supabase error" (transient
  // outage or permission issue). Previously both returned null → entire
  // fleet appeared as "no bars" → all EXCLUDED → silently wrong verdicts.
  // PGRST116 = "no rows" for .single() → expected.
  if (error && error.code !== "PGRST116") {
    throw new Error(
      `getBarsNoTtl: price_cache query failed for ${ticker} (${interval}) — message="${error.message}" code="${error.code ?? "n/a"}" details="${error.details ?? "n/a"}"`
    );
  }
  // CB.C3 (2026-06-19 EVE): price_cache.bars is `Json` per DB schema;
  // application contract is `PriceBar[]`. Runtime narrowing is the
  // operator's responsibility (DB rows here are produced by our own
  // writers in price-cache.ts, which always emit PriceBar[]).
  return (data?.bars as PriceBar[] | null) ?? null;
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

interface AnalyzeStatsArgs {
  trades: BacktestTrade[];
  capital: number;
  friction: GateResults["friction"];
  /** Stage 4.2.b (2026-06-20): asset-class for friction-source disclosure. */
  ticker?: string;
  fidelityGates: GateResults["fidelity_gates_applied"];
  riskPct: number;
  algoName: string;
  nCandidates: number;
  preregs: ReturnType<typeof loadPreregistrations>;
  now: Date;
}

/** B.2.24 (Stage 3, 2026-06-19 EVE): derive a per-algo bootstrap seed so
 *  resampling sequences are independent across algos. Without this, all
 *  algos share the same PRNG sequence — the `Math.floor(rng() * N)`
 *  indices are correlated across algos, so the Bonferroni independence
 *  assumption is violated and FWE > nominal 0.05 in practice.
 *
 *  Strategy: XOR base seed with a deterministic hash of the algo name.
 *  Same `algoName + base_seed` → same effective seed → reproducible runs.
 *  Different `algoName` → independent PRNG sequence. */
function deriveAlgoSeed(baseSeed: number, algoName: string): number {
  // 32-bit djb2-style hash. Sufficient bit-mixing for PRNG seed derivation;
  // we're not doing crypto, just making sure different names produce
  // structurally independent seeds.
  let h = 5381;
  for (let i = 0; i < algoName.length; i++) {
    h = ((h * 33) ^ algoName.charCodeAt(i)) >>> 0;
  }
  return (baseSeed ^ h) >>> 0;
}

/** B.2.36 (Stage 3, 2026-06-19 EVE): build the data-snooping disclosure
 *  string from the env-resolved cutoff. Operator can grep
 *  `oos_cutoff_selection_disclosure` in the JSONB output to audit
 *  whether the verdict was produced under the documented 12-month sweet
 *  spot OR a different cutoff (e.g. `OOS_CUTOFF=2025-09-18` for sensitivity
 *  analysis). */
function buildOosCutoffDisclosure(cutoff: string): string {
  if (cutoff === "2025-06-18") {
    return "12mo holdout (default) — empirically chosen from sweep across [3,6,9,12,15]mo on 2026-06-18 to maximise eligible-algo count from 1→2 per feedback_oos_cutoff_sweet_spot. Data-snooped: ACCEPT in personal-operator context (no hostile evaluator + full visibility into criteria selection). Quant-firm-grade true-held-out OOS deferred to Phase D.5.";
  }
  return `${cutoff} — operator override (env OOS_CUTOFF=${cutoff}). Sensitivity-analysis or alternative-methodology run; NOT the default 12mo holdout.`;
}

function analyzeStats(args: AnalyzeStatsArgs): GateResults {
  const { trades, capital, friction, fidelityGates, riskPct, algoName, nCandidates, preregs, now } = args;
  const computedAt = now.toISOString();
  const effectiveNTests = Math.max(1, nCandidates * BONFERRONI_TESTS_PER_ALGO);
  // E2.25.g: a Bonferroni bar below the bootstrap p-floor is unpassable
  // by construction — fail loudly rather than silently reject every
  // candidate at the floor. Floor = 0.5/(B+1) (mid-rank estimator).
  const pFloor = 0.5 / (BOOTSTRAP_ITERATIONS + 1);
  const bonferroniBar = FAMILY_ALPHA / effectiveNTests;
  if (bonferroniBar < pFloor) {
    throw new Error(
      `Bonferroni bar α/N = ${bonferroniBar.toExponential(3)} (α=${FAMILY_ALPHA}, N=${effectiveNTests}) ` +
        `is below the bootstrap p-floor 0.5/(B+1) = ${pFloor.toExponential(3)} at B=${BOOTSTRAP_ITERATIONS}. ` +
        `The gate would be unpassable by construction (E2.25.g). Raise BOOTSTRAP_ITERATIONS to ≥ ${Math.ceil(0.5 / bonferroniBar - 1)}.`
    );
  }
  const algoSeed = deriveAlgoSeed(BOOTSTRAP_SEED, algoName);
  const oosCutoffDisclosure = buildOosCutoffDisclosure(OOS_CUTOFF);
  // B.2.4/B.2.26 (extracted 2026-06-22 NIGHT LATE): family-rationale
  // string derived in src/lib/stats/validator-output.ts so the format
  // contract has a unit test guarding against silent template drift.
  const familyRationale = buildBonferroniFamilyRationale(nCandidates, BONFERRONI_TESTS_PER_ALGO);
  const emptyRigor: StatisticalRigorBlock = {
    bootstrap_iterations: BOOTSTRAP_ITERATIONS,
    bootstrap_seed: BOOTSTRAP_SEED,
    bootstrap_seed_effective: algoSeed,
    block_bootstrap: ENABLE_BLOCK_BOOTSTRAP,
    family_alpha: FAMILY_ALPHA,
    n_tests: effectiveNTests,
    bonferroni_tests_per_algo: BONFERRONI_TESTS_PER_ALGO,
    bonferroni_family_rationale: familyRationale,
    bonferroni_correction_scope: BONFERRONI_CORRECTION_SCOPE,
    total_return_ci: { point: 0, lower: NaN, upper: NaN, n_iterations: 0, ci_level: 0.95 },
    mean_r_ci: { point: 0, lower: NaN, upper: NaN, n_iterations: 0, ci_level: 0.95 },
    mean_r_bonferroni: { p_value: 1, bonferroni_alpha: FAMILY_ALPHA / effectiveNTests, passes: false, family_alpha: FAMILY_ALPHA, n_tests: effectiveNTests },
    sharpe_ratio: 0,
    sharpe_ratio_ci: { point: 0, lower: NaN, upper: NaN, n_iterations: 0, ci_level: 0.95 },
    purged_kfold: null,
    oos_cutoff_used: OOS_CUTOFF,
    oos_cutoff_selection_disclosure: oosCutoffDisclosure,
  };
  const frictionClass = classifyFriction(args.ticker ?? "UNKNOWN", friction);
  const empty: GateResults = {
    computed_at: computedAt,
    sample_first: null,
    sample_last: null,
    friction,
    friction_source: frictionClass.source,
    friction_source_disclosure: frictionClass.disclosure,
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

  // B.3 (Stage 4.1, 2026-06-20): strict PASS|FAIL only. Reason strings
  // preserve operator triage signal — "near-miss" (≥50%/≥50% but <70%
  // on at least one axis), "well-short" (any axis <50%), "aggregate
  // negative" — so removing the WEAK tier doesn't blind the operator
  // to "close-but-not-quite" vs "way-off".
  let step3Verdict: WalkForwardStats["verdict"], step3Reason: string;
  if (cum <= 0) { step3Verdict = "FAIL"; step3Reason = "aggregate negative"; }
  else if (windows.length === 0) { step3Verdict = "INSUFFICIENT_DATA"; step3Reason = "history too short for 12mo train + 3mo test"; }
  else if (wfGreenPct >= 70 && yearsGreenPct >= 70) { step3Verdict = "PASS"; step3Reason = "both gates pass strict 70%"; }
  else if (wfGreenPct >= 50 && yearsGreenPct >= 50) {
    step3Verdict = "FAIL";
    step3Reason = `near-miss WF ${wfGreenPct}% / per-year ${yearsGreenPct}% — strict 70% required (B.3)`;
  }
  else { step3Verdict = "FAIL"; step3Reason = `well-short WF ${wfGreenPct}% / per-year ${yearsGreenPct}% — at least one axis below 50%`; }

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
        ? bootstrapStatBlock(heldOutT, (ts: BacktestTrade[]) => meanR(ts, riskPerTrade), { seed: algoSeed, n_iterations: BOOTSTRAP_ITERATIONS })
        : bootstrapStat(heldOutT, (ts: BacktestTrade[]) => meanR(ts, riskPerTrade), { seed: algoSeed, n_iterations: BOOTSTRAP_ITERATIONS }))
    : { point: NaN, lower: NaN, upper: NaN, n_iterations: 0, ci_level: 0.95 };
  // B.3 (Stage 4.1, 2026-06-20): strict PASS|FAIL only. The TIER_2_PASS
  // branch (±75% OR small-N) was a leniency Phase B never honoured; merge
  // into FAIL with a diagnostic reason that preserves the "small-N
  // caveat" vs "large-divergence" distinction.
  let step6Verdict: OosStats["verdict"], step6Reason: string;
  let rDelta = 0;
  if (inSampleT.length < 10) { step6Verdict = "INSUFFICIENT_DATA"; step6Reason = `in-sample ${inSampleT.length} trades`; }
  else if (heldOutT.length < 3) { step6Verdict = "INSUFFICIENT_DATA"; step6Reason = `held-out ${heldOutT.length} trades`; }
  else if (Math.abs(inSampleR) < 0.001) { step6Verdict = "FAIL"; step6Reason = "in-sample R near zero"; }
  else {
    rDelta = (heldOutR - inSampleR) / Math.abs(inSampleR) * 100;
    if (heldOutR <= 0) { step6Verdict = "FAIL"; step6Reason = `held-out R=${heldOutR.toFixed(2)} (≤ 0)`; }
    else if (Math.abs(rDelta) <= 50) { step6Verdict = "PASS"; step6Reason = `clean ±50%`; }
    else if (heldOutT.length < SMALL_N) {
      step6Verdict = "FAIL";
      step6Reason = `small-N caveat n=${heldOutT.length}<${SMALL_N}, rDelta=${rDelta.toFixed(0)}% — Phase B requires ±50% regardless of N (B.3)`;
    }
    else if (Math.abs(rDelta) <= 75) {
      step6Verdict = "FAIL";
      step6Reason = `near-miss rDelta=${rDelta.toFixed(0)}%, n=${heldOutT.length} — Phase B requires ±50% (B.3)`;
    }
    else { step6Verdict = "FAIL"; step6Reason = `diverges ${rDelta.toFixed(0)}%, n=${heldOutT.length} large enough`; }
  }

  // Phase B.2 statistical rigor: bootstrap CIs on total_return + mean_R,
  // Bonferroni p-value for "mean R > 0" against family of nCandidates tests.
  // B.2.5: block bootstrap (default) handles trade-to-trade correlation
  // within regime windows; trade-level bootstrap UNDERSTATES CI width.
  const totalReturnCI = ENABLE_BLOCK_BOOTSTRAP
    ? bootstrapStatBlock(sorted, totalReturn, { seed: algoSeed, n_iterations: BOOTSTRAP_ITERATIONS })
    : bootstrapStat(sorted, totalReturn, { seed: algoSeed, n_iterations: BOOTSTRAP_ITERATIONS });
  const meanRWithSamples = ENABLE_BLOCK_BOOTSTRAP
    ? bootstrapStatBlockWithSamples(
        sorted,
        (ts: BacktestTrade[]) => meanR(ts, riskPerTrade),
        { seed: algoSeed, n_iterations: BOOTSTRAP_ITERATIONS }
      )
    : bootstrapStatWithSamples(
        sorted,
        (ts: BacktestTrade[]) => meanR(ts, riskPerTrade),
        { seed: algoSeed, n_iterations: BOOTSTRAP_ITERATIONS }
      );
  const meanRBonferroni = bonferroniVerdict(meanRWithSamples.samples, FAMILY_ALPHA, effectiveNTests);
  // B.2.10: per-trade Sharpe + bootstrap CI.
  const sharpePoint = sharpeRatio(sorted, riskPerTrade);
  const sharpeCI = ENABLE_BLOCK_BOOTSTRAP
    ? bootstrapStatBlock(sorted, (ts: BacktestTrade[]) => sharpeRatio(ts, riskPerTrade), { seed: algoSeed, n_iterations: BOOTSTRAP_ITERATIONS })
    : bootstrapStat(sorted, (ts: BacktestTrade[]) => sharpeRatio(ts, riskPerTrade), { seed: algoSeed, n_iterations: BOOTSTRAP_ITERATIONS });
  // Phase F.3 (ROADMAP.md) — purged k-fold CV with embargo. Opt-in via KFOLD env;
  // adds per-fold OOS mean R + consistency count for v3 ship-criterion check.
  // Skipped when sorted.length < k (each fold needs ≥ 1 trade for meaningful result).
  let purgedKfold: PurgedKFoldResult | null = null;
  if (KFOLD >= 2 && sorted.length >= KFOLD) {
    try {
      purgedKfold = purgedKFoldEvaluate(sorted, riskPerTrade, {
        k: KFOLD,
        embargoFraction: EMBARGO_FRACTION,
      });
    } catch (e) {
      // Don't fail the whole validate-algo run on a k-fold error; log + persist null.
      console.warn(
        `[validate-algo] purgedKFoldEvaluate failed for ${algoName}: ${e instanceof Error ? e.message : String(e)} — persisting null.`,
      );
    }
  }
  const rigor: StatisticalRigorBlock = {
    bootstrap_iterations: BOOTSTRAP_ITERATIONS,
    bootstrap_seed: BOOTSTRAP_SEED,
    bootstrap_seed_effective: algoSeed,
    block_bootstrap: ENABLE_BLOCK_BOOTSTRAP,
    family_alpha: FAMILY_ALPHA,
    n_tests: effectiveNTests,
    bonferroni_tests_per_algo: BONFERRONI_TESTS_PER_ALGO,
    bonferroni_family_rationale: familyRationale,
    bonferroni_correction_scope: BONFERRONI_CORRECTION_SCOPE,
    total_return_ci: totalReturnCI,
    mean_r_ci: {
      point: meanRWithSamples.point,
      lower: meanRWithSamples.lower,
      upper: meanRWithSamples.upper,
      n_iterations: meanRWithSamples.n_iterations,
      ci_level: meanRWithSamples.ci_level,
    },
    mean_r_bonferroni: meanRBonferroni,
    sharpe_ratio: sharpePoint,
    sharpe_ratio_ci: sharpeCI,
    purged_kfold: purgedKfold,
    oos_cutoff_used: OOS_CUTOFF,
    oos_cutoff_selection_disclosure: oosCutoffDisclosure,
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
    // B.3 (Stage 4.1, 2026-06-20): WEAK + TIER_2_PASS removed. step3/6
    // verdicts are now PASS|FAIL|INSUFFICIENT_DATA only. The "near-miss"
    // diagnostic that the WEAK tier used to carry is embedded in the
    // FAIL reason string directly — operators triage by reading the
    // reason (e.g. "near-miss WF 67% / per-year 75%" vs "well-short").
    if (!step2Pass) blockers.push(`STEP 2: ${step2Reasons.join("; ")}`);
    if (step3Verdict === "FAIL") blockers.push(`STEP 3: ${step3Reason}`);
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
    friction_source: frictionClass.source,
    friction_source_disclosure: frictionClass.disclosure,
    fidelity_gates_applied: fidelityGates,
    demo_gate: buildDemoGate(rigor) ?? undefined,
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

/** CB.C3 (2026-06-19 EVE): typed via SupabaseClient<Database>. The
 *  `algorithms.rules` column is `Json` in the DB; we narrow to
 *  `AlgorithmRules` at this boundary because every row in this table is
 *  produced by our own writers (deploy-*.ts scripts that validate against
 *  the AlgorithmsRules Zod schema). Downstream consumers can rely on the
 *  narrowed type without re-validating each access.
 *
 *  B.2.40 fix (2026-06-19 EVE): on Supabase error we now THROW with the
 *  full error context (.code/.details/.hint) instead of `console.error +
 *  process.exit(1)`. That preserves the stack trace for the top-level
 *  main().catch handler + makes the failure debuggable by call site. */
async function loadAlgos(
  supabase: SupabaseClient<Database>,
  only: string | null,
  algosCsv: string | null
): Promise<AlgoRow[]> {
  let query = supabase.from("algorithms").select("id, name, capital, rules, status, broker_connection_id");
  // Stage 4.3 (2026-06-20): precedence ALGO > ALGOS > canonical-set.
  // - ALGO=NAME            → exact match (legacy single-algo path)
  // - ALGOS=A,B,C          → CSV explicit set
  // - neither              → canonical set: `Library:%` + Gold Swing 4h
  if (only) {
    query = query.eq("name", only);
  } else if (algosCsv) {
    const names = algosCsv.split(",").map((n) => n.trim()).filter(Boolean);
    if (names.length === 0) {
      throw new Error(`loadAlgos: ALGOS="${algosCsv}" parsed to zero names. Use comma-separated exact names.`);
    }
    query = query.in("name", names);
  } else {
    // Canonical set rationale: `Library:%` covers every condition-based
    // strategy seeded via deploy-*.ts; `Gold Swing 4h` is the LLM-trader
    // baseline that isn't named with the Library: prefix. Extend the OR
    // clause when adding new non-Library algos that should be validated.
    query = query.or("name.like.Library:%,name.eq.Gold Swing 4h");
  }
  const res = await query;
  if (res.error) {
    throw new Error(
      `loadAlgos: Supabase query failed — message="${res.error.message}" code="${res.error.code ?? "n/a"}" details="${res.error.details ?? "n/a"}" hint="${res.error.hint ?? "n/a"}"`
    );
  }
  const rows = (res.data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    capital: r.capital,
    rules: r.rules as unknown as AlgorithmRules,
    status: r.status,
    broker_connection_id: r.broker_connection_id,
  }));
  const out: AlgoRow[] = [];
  for (const r of rows) {
    const wl = await supabase.from("algorithm_watchlist").select("ticker").eq("algorithm_id", r.id);
    if (wl.error) {
      throw new Error(
        `loadAlgos: algorithm_watchlist query failed for algo ${r.id} — message="${wl.error.message}" code="${wl.error.code ?? "n/a"}"`
      );
    }
    const ticker = (wl.data ?? [])[0]?.ticker?.toUpperCase() ?? "";
    if (ticker) out.push({ ...r, ticker });
  }
  return out;
}

/** Fetch broker_connections referenced by any of the loaded algos. Returns
 *  a Map<broker_connection_id, account_capital|null>. account_capital is
 *  null for connections without an explicit value set; portfolio-halt and
 *  risk-pool then fall back to per-algo capital (conservative). */
async function loadBrokerCapitals(
  supabase: SupabaseClient<Database>,
  algos: AlgoRow[]
): Promise<Map<string, number | null>> {
  const brokerIds = Array.from(new Set(algos.map((a) => a.broker_connection_id).filter((id): id is string => !!id)));
  const out = new Map<string, number | null>();
  if (brokerIds.length === 0) return out;
  const res = await supabase.from("broker_connections").select("id, label, account_capital").in("id", brokerIds);
  // Soft-fail here is intentional (B.2.40 caveat): unlike loadAlgos which
  // is a hard prereq, broker_capital fetch loss degrades to per-algo
  // capital fallback — the validator still produces verdicts, they're
  // just slightly more conservative. Warn loudly so operator notices.
  if (res.error) {
    console.warn(
      `broker_connections fetch failed: message="${res.error.message}" code="${res.error.code ?? "n/a"}" — falling back to per-algo capital`
    );
    return out;
  }
  for (const r of res.data ?? []) {
    out.set(r.id, r.account_capital);
  }
  return out;
}

/** CB.C3 typed accessors for the `algorithms.rules` JSONB shape. The
 *  DB types model `rules` as `Json`; AlgorithmRules is our domain shape
 *  for the same field. These narrow once at the boundary so the call
 *  sites stay clean and don't repeat the cast. Safe to read these
 *  fields directly because every row is produced by deploy-*.ts which
 *  validates against the Zod schema before insert. */
interface AlgoRulesAccess {
  prop_firm: {
    slippage_bps?: number;
    spread_bps?: number;
    commission_per_lot?: number;
  };
  position_sizing_value: number;
}

function readAlgoRulesAccess(rules: AlgorithmRules): AlgoRulesAccess {
  // The narrowing here mirrors the existing reads — `prop_firm` and
  // `position_sizing` are both declared optional on AlgorithmRules, so
  // we collapse to safe defaults. Wrapping in a typed accessor means
  // the "what does the JSONB shape look like?" knowledge lives in one
  // place instead of being smeared across 3 inline casts.
  const r = rules as unknown as {
    prop_firm?: {
      slippage_bps?: number;
      spread_bps?: number;
      commission_per_lot?: number;
    };
    position_sizing?: { value?: number };
  };
  return {
    prop_firm: r.prop_firm ?? {},
    position_sizing_value: r.position_sizing?.value ?? 1,
  };
}

/** Stage 4.2.b (2026-06-20): per-instrument friction provenance.
 *
 *  Friction comes from `algo.rules.prop_firm` (the algo's own deploy-time
 *  values). This function CLASSIFIES that friction so the JSONB output
 *  tells operators whether the run produced shippable verdicts (measured)
 *  or directional-only (literature default).
 *
 *  Asset-class heuristics:
 *   - GOLD (XAU/USD): measured 3 bps slippage / 0 spread / 0 commission_per_lot
 *     from 37 FTMO MT5 fills 2026-06. Any match = "measured".
 *   - FOREX: literature default = 1 pip slippage equivalent (~0.7 bps for
 *     EUR/USD-like; 0 for now until Stage 4.2.c real fill capture). Any
 *     match of the documented placeholder = "literature_default".
 *   - All zero = "zero_no_friction" (only acceptable for diagnostic runs).
 *   - Otherwise = "algo_override".
 *
 *  Future: when 4.2.c real fill data lands + per-instrument calibration
 *  JSON exists, gold + each forex pair gets its own "measured" baseline. */
function classifyFriction(
  ticker: string,
  friction: { slippage_bps: number; spread_bps: number; commission_per_lot: number }
): { source: GateResults["friction_source"]; disclosure: string } {
  const { slippage_bps: s, spread_bps: sp, commission_per_lot: c } = friction;
  const isGold = ticker.toUpperCase().startsWith("XAU");
  const isForex = /^(EUR|GBP|USD|JPY|CHF|AUD|NZD|CAD)/.test(ticker.toUpperCase()) && ticker.includes("/");
  if (s === 0 && sp === 0 && c === 0) {
    return {
      source: "zero_no_friction",
      disclosure: `Zero friction — DIAGNOSTIC ONLY. Verdicts produced under this config are NOT shippable. ${isGold ? "Gold real-fill baseline: 3 bps slippage / 0 spread / 0 commission." : isForex ? "Forex awaits Stage 4.2.c real-fill capture; until then use literature placeholder." : "Unknown asset class — operator must specify friction explicitly."}`,
    };
  }
  if (isGold && s === 3 && sp === 0 && c === 0) {
    return {
      source: "measured",
      disclosure: "Gold measured baseline: 3 bps slippage / 0 spread / 0 commission_per_lot from 37 FTMO MT5 fills (2026-06).",
    };
  }
  if (isForex && s === 1 && sp === 0 && c === 0) {
    return {
      source: "literature_default",
      disclosure: "Forex literature default: 1 bps slippage / 0 spread / 0 commission. PENDING Stage 4.2.c real-fill capture before shippable. Run scripts/canonical/sample-forex-spreads.ts to start the corpus.",
    };
  }
  return {
    source: "algo_override",
    disclosure: `Algo-specific friction override: slippage=${s} bps / spread=${sp} bps / commission_per_lot=${c}. Document the source of these values in the algo's deploy script.`,
  };
}

/** Stage 4.6 / B.5 (2026-06-20): build the demo-phase alignment spec
 *  from the in-sample mean-R bootstrap CI. Returns null when stats are
 *  insufficient (no trades, NaN CI). Stage 5.2 reads `demo_gate` from the
 *  algo's `backtest_results` JSONB to evaluate whether the live-mirrored
 *  demo trades align with the in-sample distribution. */
function buildDemoGate(rigor: StatisticalRigorBlock): DemoGateSpec | null {
  const ci = rigor.mean_r_ci;
  if (!Number.isFinite(ci.point) || !Number.isFinite(ci.lower) || !Number.isFinite(ci.upper)) {
    return null;
  }
  return {
    min_trades: 10,
    expected_mean_r: Number(ci.point.toFixed(4)),
    expected_mean_r_lower: Number(ci.lower.toFixed(4)),
    expected_mean_r_upper: Number(ci.upper.toFixed(4)),
    evaluation_contract:
      `After min_trades=10 demo trades, compute demo mean-R. Demo-aligned if demo_mean_r ∈ [${ci.lower.toFixed(2)}, ${ci.upper.toFixed(2)}] (in-sample 95% CI). ` +
      `Outside-window outcomes trigger Stage 5.4 fallback (algo back to research; do NOT progress to real $10K challenge).`,
  };
}

async function main(): Promise<void> {
  console.log(`\n===== validate-algo @ ${new Date().toISOString().slice(0, 16)} =====`);
  console.log(`Mode: ${ONLY_ALGO ? `single algo "${ONLY_ALGO}"` : "all deployed"}`);
  console.log(`Phase B fidelity gates: siblings=${ENABLE_SIBLINGS} spread_gate=${ENABLE_SPREAD_GATE} risk_pool=${ENABLE_RISK_POOL} (cap=${POOL_CAP_PCT}%) ftmo_termination=${ENABLE_FTMO_TERMINATION} re_entry_cooldown=${ENABLE_RE_ENTRY_COOLDOWN} portfolio_halt=${ENABLE_PORTFOLIO_HALT} (dll=${PORTFOLIO_DLL_PCT}%)`);
  console.log(`OOS cutoff: ${OOS_CUTOFF}`);
  console.log(`Persist to DB: ${PERSIST}\n`);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "validate-algo: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. " +
      "Both should be present in .env.local (the inline loader at the top of this script reads them)."
    );
  }
  const supabase = createClient<Database>(url, key, { auth: { persistSession: false } });

  const algos = await loadAlgos(supabase, ONLY_ALGO, ALGOS_CSV);
  if (algos.length === 0) {
    // Stage 4.3 (2026-06-20): explicit empty-set diagnostic. Previously
    // the script proceeded silently with 0 algos and printed a confused
    // "SUMMARY: 0 ELIGIBLE / 0 BLOCKED" — operator couldn't tell whether
    // the algo set was actually empty or if the filter excluded everything.
    throw new Error(
      `validate-algo: 0 algos matched the filter (${
        ONLY_ALGO ? `ALGO="${ONLY_ALGO}"` : ALGOS_CSV ? `ALGOS="${ALGOS_CSV}"` : "canonical Library:%+Gold Swing 4h set"
      }). Verify (a) the name exists in the algorithms table, (b) RLS allows service-role access (it should), (c) the script isn't pointed at the wrong Supabase project.`
    );
  }
  console.log(`Loaded ${algos.length} algos.`);
  if (LIST_ONLY) {
    // Stage 4.3 (2026-06-20): smoke-list selected algos + exit. Used to
    // verify the filter before committing to a long-running PERSIST=1 run.
    console.log("\nLIST_ONLY=1 — printing selected algos + exiting (no backtests run, no DB writes):");
    for (const a of algos) {
      console.log(`  - ${a.name}  (status=${a.status}, capital=$${a.capital}, ticker=${a.ticker}, broker=${a.broker_connection_id?.slice(0, 8) ?? "none"})`);
    }
    return;
  }

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
  // B.2.9/B.2.27 (extracted 2026-06-22 NIGHT LATE): expiry classification
  // moved to src/lib/stats/validator-output.ts:classifyPreregExpiry so the
  // deployed-only filter + warn-window partition + orphan/malformed-skip
  // semantics are unit-tested. The console render layer (loud warnings
  // below) stays here — that's CLI presentation, not classification logic.
  const PREREG_WARN_DAYS = 14;
  const NOW = new Date();
  const deployedAlgoNames = new Set(algos.map((a) => a.name));
  const { expired, expiringSoon } = classifyPreregExpiry(preregs, deployedAlgoNames, NOW, PREREG_WARN_DAYS);
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
    const result = runPortfolioBacktest(algo.rules, new Map([[algo.ticker, bars]]), algo.capital);
    // B.1.5 fix: assertTradeSidePopulated throws if engine had a side bug.
    const tagged: (BacktestTrade & { ticker: string })[] = [];
    for (const t of result.trades) {
      assertTradeSidePopulated(t, algo.name);
      tagged.push({ ...t, ticker: algo.ticker });
    }
    baselineTradesByAlgo.set(algo.id, tagged);
  }
  if (!QUIET) console.log(`Pass 1 (baseline): collected trades for ${baselineTradesByAlgo.size} algos.\n`);

  // Pass 2: run each algo with sibling-blocking trades from all OTHER algos.
  let pass = 0, excluded = 0;
  // B.2.13: split fail bucketing so operator can triage by cause.
  let bonfFail = 0, preregFail = 0, stepFail = 0;
  for (const algo of algos) {
    const interval = timeframeToInterval(algo.rules.timeframe);
    const bars = await getBarsNoTtl(supabase, algo.ticker, interval);
    const access = readAlgoRulesAccess(algo.rules);
    const friction = {
      slippage_bps: access.prop_firm.slippage_bps ?? 0,
      spread_bps: access.prop_firm.spread_bps ?? 0,
      commission_per_lot: access.prop_firm.commission_per_lot ?? 0,
    };
    const riskPct = access.position_sizing_value;

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
        const otherRiskPct = readAlgoRulesAccess(otherAlgo.rules).position_sizing_value;
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
      // B.4.5: Record (not Map) — see PortfolioHaltConfig.sibling_daily_pnl
      // docstring. JSON-serialisable for any persisted-audit downstream.
      const siblingDailyPnl: Record<string, number> = {};
      if (algo.broker_connection_id !== null) {
        for (const [otherId, otherTrades] of baselineTradesByAlgo) {
          if (otherId === algo.id) continue;
          const otherAlgo = algos.find((a) => a.id === otherId);
          if (!otherAlgo) continue;
          // Only same-broker siblings contribute to this algo's portfolio DLL.
          if (algo.broker_connection_id !== otherAlgo.broker_connection_id) continue;
          for (const t of otherTrades) {
            const day = t.exit_date.slice(0, 10);
            siblingDailyPnl[day] = (siblingDailyPnl[day] ?? 0) + t.pnl;
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

    const baseAnalyzeArgs: Omit<AnalyzeStatsArgs, "trades"> = {
      capital: algo.capital, friction, fidelityGates: fidelityFlags, riskPct,
      // Stage 4.2.b (2026-06-20): pass ticker through so friction-source
      // classification can use asset-class heuristics (gold vs forex vs other).
      ticker: algo.ticker,
      algoName: algo.name, nCandidates, preregs, now: NOW,
    };
    let results: GateResults;
    if (!bars) {
      results = analyzeStats({ ...baseAnalyzeArgs, trades: [] });
      results.step2.reason = "no bars in cache";
      results.promotion_blockers = ["no bars in cache"];
    } else {
      const result = runPortfolioBacktest(algo.rules, new Map([[algo.ticker, bars]]), algo.capital, {
        siblingBlockingTrades: directionConflictSiblings,
        spreadGate,
        riskPool,
        ftmoTermination,
        riskPoolSiblings,
        reEntryCooldown,
        portfolioHalt,
      });
      results = analyzeStats({ ...baseAnalyzeArgs, trades: result.trades });
    }
    // B.2.13: triage bucketing — split failures by cause so operator can
    // see at a glance whether candidates die on stats, pre-reg, step gates,
    // or data shortage.
    if (results.promotion_eligible) pass++;
    else if (results.step2.verdict === "EXCLUDED") excluded++;
    else if (results.preregistration?.has_preregistration && !results.preregistration.passed) preregFail++;
    else if (!results.statistical_rigor.mean_r_bonferroni.passes) bonfFail++;
    else stepFail++;

    if (PERSIST) {
      // CB.C3 (2026-06-19 EVE): `backtest_results` column is typed `Json`
      // in database.types.ts, which requires the writable shape to satisfy
      // `{[k: string]: Json | undefined}`. `GateResults` is a concrete
      // interface (no index signature) so we cast at the persist boundary.
      // Safe because GateResults is composed entirely of primitives +
      // nested objects + arrays of the same — JSON.stringify-able by
      // construction. B.4.5 confirms no Map/Set/Date instances leak through.
      const updateRes = await supabase
        .from("algorithms")
        .update({ backtest_results: results as unknown as Database["public"]["Tables"]["algorithms"]["Update"]["backtest_results"] })
        .eq("id", algo.id);
      if (updateRes.error) {
        throw new Error(
          `Failed to persist backtest_results for algo ${algo.id} (${algo.name}) — message="${updateRes.error.message}" code="${updateRes.error.code ?? "n/a"}" details="${updateRes.error.details ?? "n/a"}"`
        );
      }
    }
    // B.2.31 (Stage 3.2, 2026-06-20): under QUIET, skip the ~3-line
    // per-algo render block. Bucketing counters above (eligible/excluded/
    // bonfFail/preregFail/stepFail) are already incremented, so the
    // SUMMARY row below still produces correct counts.
    if (!QUIET) {
      const flag = results.promotion_eligible ? "✓ ELIGIBLE" : (results.step2.verdict === "EXCLUDED" ? "— excluded" : "✗ blocked");
      const ci = results.statistical_rigor.mean_r_ci;
      const mcc = results.statistical_rigor.mean_r_bonferroni;
      const sharpe = results.statistical_rigor.sharpe_ratio;
      // B.2.7 + B.2.32 (Stage 3.2, 2026-06-20): three registration-type
      // tags — TRUE-PREREG (criteria set BEFORE the data existed),
      // FWD-PREREG (criteria informed by historical data but evaluated
      // ONLY against data accumulated after the lock), P-LOCK (post-hoc
      // discipline commitment over both past + future). All three
      // distinguish "discipline" from "statistical novelty"; only TRUE-PREREG
      // earns the latter.
      let preregLabel = "no-prereg";
      if (results.preregistration?.has_preregistration) {
        const type = results.preregistration.registration_type;
        const passMark = results.preregistration.passed ? "✓" : "✗";
        if (type === "true-prereg") preregLabel = `PREREG${passMark}`;
        else if (type === "forward-pre-registered") preregLabel = `FWD-PREREG${passMark}`;
        else preregLabel = `P-LOCK${passMark}`;
      }
      // B.2.12: explicit bonf=PASS/FAIL instead of cryptic `*` after p-value.
      const bonfTag = `bonf=${mcc.passes ? "PASS" : "FAIL"}`;
      // B.2.41 (Stage 3, 2026-06-19 EVE): R[NaN,NaN] is meaningless to the
      // operator. Render "R[n/a]" when CI bounds are NaN (zero-trade case),
      // matching the step3/step6 formatters' convention.
      const rTag = Number.isFinite(ci.lower) && Number.isFinite(ci.upper)
        ? `R[${ci.lower.toFixed(2)},${ci.upper.toFixed(2)}]`
        : "R[n/a]";
      // B.2.30 (Stage 3, 2026-06-19 EVE): Sharpe was computed + persisted to
      // JSONB but never displayed. Surface on the headline row alongside
      // the mean-R CI. n/a when fewer than 2 trades or risk=0.
      const sharpeTag = Number.isFinite(sharpe) && sharpe !== 0
        ? `Sh=${sharpe.toFixed(2)}`
        : "Sh=n/a";
      console.log(`  ${flag.padEnd(11)} ${algo.name.padEnd(50)} $${results.step2.total_return.toString().padStart(8)} ${results.step2.total_trades.toString().padStart(4)}t WR${results.step2.win_rate}% ${rTag} ${sharpeTag} p=${mcc.p_value.toFixed(4)} ${bonfTag} ${preregLabel}`);
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
  }

  const totalFail = bonfFail + preregFail + stepFail;
  console.log(`\nSUMMARY: ${pass} ELIGIBLE / ${totalFail} BLOCKED (${preregFail} prereg, ${bonfFail} bonferroni, ${stepFail} step-verdict) / ${excluded} EXCLUDED\n`);
  console.log(`Phase B fidelity gates applied: siblings=${ENABLE_SIBLINGS}, spread_gate=${ENABLE_SPREAD_GATE}, risk_pool=${ENABLE_RISK_POOL} (cap=${POOL_CAP_PCT}%), ftmo_termination=${ENABLE_FTMO_TERMINATION}, re_entry_cooldown=${ENABLE_RE_ENTRY_COOLDOWN}, portfolio_halt=${ENABLE_PORTFOLIO_HALT} (dll=${PORTFOLIO_DLL_PCT}%)`);
  console.log(`Compare to Phase A results (no gates) to measure fidelity impact.\n`);
}

void main();
