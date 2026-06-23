/**
 * Alpha decay monitoring (G.4) — rolling 30d/90d Sharpe per live algo vs
 * in-sample baseline. Auto-pauses an algo when BOTH windows agree
 * current Sharpe < threshold_ratio × baseline (≥30 days sustained low alpha).
 *
 * Distinct from drift-detector.ts (which watches WIN-RATE and only sets
 * live_trading_enabled=false). Alpha-decay watches SHARPE and sets the
 * stronger algorithms.status='paused' (halts the scan entirely) + writes
 * a durable alpha_decay_pause activity_log event.
 *
 * Three consumers:
 *   1. Daily cron at /api/cron/alpha-decay → evaluateAndApplyAlphaDecay()
 *      iterates live algos, classifies, auto-pauses when criteria met.
 *   2. /reports drift tab → buildAlphaDecaySummary() (pure-read, no
 *      mutations) for operator review.
 *   3. Synthetic-fixture tests for the classifier + math.
 *
 * Mirrors the pattern of `drift-summary.ts` + `engine-activity.ts` +
 * `live-mirror-eligibility.ts` siblings in this directory.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type AlphaDecaySeverity =
  | "none"
  | "warn"
  | "decay"
  | "insufficient_data"
  | "no_baseline";

export interface RollingWindowStats {
  days: number;
  n_trades: number;
  /** Per-trade Sharpe = mean(R) / std(R). Null when <2 trades or std=0. */
  sharpe: number | null;
  /** Wins / total × 100. Null when 0 trades. */
  hit_rate_pct: number | null;
  /** Mean R-multiple. Null when 0 trades. */
  mean_r: number | null;
}

export interface AlphaDecayCheck {
  algorithm_id: string;
  algorithm_name: string;
  algo_status: string;
  live_trading_enabled: boolean;
  /** In-sample baseline Sharpe from backtest_results.sharpe_ratio. Null
   *  when the algo has no backtest_results or no sharpe field. */
  baseline_sharpe: number | null;
  rolling_short: RollingWindowStats; // 30d window default
  rolling_long: RollingWindowStats; // 90d window default
  severity: AlphaDecaySeverity;
  reason: string;
  /** True iff the cron will auto-pause this algo on this run (severity=decay
   *  AND algo is currently active). */
  should_auto_pause: boolean;
  evaluated_at: string;
}

export interface AlphaDecayConfig {
  /** Current Sharpe must be < threshold_ratio × baseline to count as
   *  "below threshold". Default 0.5 per ROADMAP G.4. */
  threshold_ratio?: number;
  /** Min closed trades in the SHORT window to compute Sharpe at all.
   *  Below this → insufficient_data (no warn, no pause). Default 10. */
  min_trades_short?: number;
  /** Min closed trades in the LONG window to count its result as a
   *  valid "sustained" signal for auto-pause. Default 20. */
  min_trades_long?: number;
  /** Days for the short rolling window. Default 30 per spec. */
  short_window_days?: number;
  /** Days for the long (sustained) window. Default 90 per spec. */
  long_window_days?: number;
}

export const DEFAULT_ALPHA_DECAY_CONFIG: Required<AlphaDecayConfig> = {
  threshold_ratio: 0.5,
  min_trades_short: 10,
  min_trades_long: 20,
  short_window_days: 30,
  long_window_days: 90,
};

export interface ClosedPositionForDecay {
  side: "long" | "short" | string;
  entry_price: number;
  exit_price: number | null;
  initial_stop_loss_price: number | null;
  stop_loss_price: number | null;
  realized_pnl: number | null;
  closed_at: string | null;
}

/** R-multiple from entry / stop / exit. Inlined (no cross-module import)
 *  to match the pattern in live-mirror-eligibility.ts + llm-trader-audit.ts;
 *  all three must stay numerically identical. Returns 0 on broken-state
 *  input (risk ≤ 0); the caller filters those out before computing stats. */
export function computeRMultipleForDecay(
  side: "long" | "short",
  entryPrice: number,
  stopPrice: number,
  exitPrice: number,
): number {
  const risk = side === "long" ? entryPrice - stopPrice : stopPrice - entryPrice;
  if (risk <= 0) return 0;
  const move = side === "long" ? exitPrice - entryPrice : entryPrice - exitPrice;
  return move / risk;
}

/** Compute rolling-window stats from closed positions newer than `sinceMs`.
 *  Pure; no DB. The R-multiple is computed using initial_stop_loss_price
 *  when present (matches the "risk taken at entry" canonical definition),
 *  falling back to stop_loss_price for positions opened before migration
 *  00032 introduced initial_stop_loss_price. */
export function rollingWindowStatsFromPositions(
  positions: ClosedPositionForDecay[],
  sinceMs: number,
  windowDays: number,
): RollingWindowStats {
  const rs: number[] = [];
  let wins = 0;
  for (const p of positions) {
    if (!p.closed_at || p.exit_price == null) continue;
    const closedAt = new Date(p.closed_at).getTime();
    if (closedAt < sinceMs) continue;
    const stop = p.initial_stop_loss_price ?? p.stop_loss_price;
    if (stop == null) continue;
    if (p.side !== "long" && p.side !== "short") continue;
    const r = computeRMultipleForDecay(p.side, p.entry_price, stop, p.exit_price);
    if (!Number.isFinite(r)) continue;
    rs.push(r);
    if ((p.realized_pnl ?? 0) > 0) wins++;
  }
  if (rs.length === 0) {
    return { days: windowDays, n_trades: 0, sharpe: null, hit_rate_pct: null, mean_r: null };
  }
  const mean = rs.reduce((s, x) => s + x, 0) / rs.length;
  if (rs.length < 2) {
    return { days: windowDays, n_trades: rs.length, sharpe: null, hit_rate_pct: (wins / rs.length) * 100, mean_r: mean };
  }
  const variance = rs.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (rs.length - 1);
  const sd = Math.sqrt(variance);
  return {
    days: windowDays,
    n_trades: rs.length,
    sharpe: sd > 0 ? mean / sd : null,
    hit_rate_pct: (wins / rs.length) * 100,
    mean_r: mean,
  };
}

interface ClassifyInputs {
  baseline_sharpe: number | null;
  rolling_short: RollingWindowStats;
  rolling_long: RollingWindowStats;
  algo_status: string;
  config: Required<AlphaDecayConfig>;
}

/** Severity classification per G.4 spec:
 *   - no_baseline: backtest_results.sharpe_ratio missing
 *   - insufficient_data: short window has < min_trades_short
 *   - decay: BOTH windows below threshold AND long-window has ≥ min_trades_long
 *     → triggers auto-pause when algo is currently active
 *   - warn: short window below threshold, but long window is above OR insufficient
 *   - none: short window at-or-above threshold
 *
 *  Auto-pause requires algo_status === 'active' — won't re-pause an already
 *  paused algo (idempotent across cron runs).
 */
export function classifyAlphaDecay(inputs: ClassifyInputs): {
  severity: AlphaDecaySeverity;
  reason: string;
  should_auto_pause: boolean;
} {
  const { baseline_sharpe, rolling_short: s, rolling_long: l, algo_status, config } = inputs;
  if (baseline_sharpe == null || !Number.isFinite(baseline_sharpe)) {
    return {
      severity: "no_baseline",
      reason: "No backtest_results.sharpe_ratio baseline — alpha-decay check skipped",
      should_auto_pause: false,
    };
  }
  if (s.n_trades < config.min_trades_short) {
    return {
      severity: "insufficient_data",
      reason: `Short window has ${s.n_trades} trades (< ${config.min_trades_short} required) — wait for more live data`,
      should_auto_pause: false,
    };
  }
  const threshold = baseline_sharpe * config.threshold_ratio;
  const shortBelow = s.sharpe != null && s.sharpe < threshold;
  const longBelow = l.sharpe != null && l.sharpe < threshold;
  const longHasEnoughTrades = l.n_trades >= config.min_trades_long;
  if (shortBelow && longBelow && longHasEnoughTrades) {
    return {
      severity: "decay",
      reason:
        `Sustained decay — short(${s.days}d) Sharpe ${s.sharpe?.toFixed(3)} AND ` +
        `long(${l.days}d) Sharpe ${l.sharpe?.toFixed(3)} both below ${threshold.toFixed(3)} ` +
        `(${(config.threshold_ratio * 100).toFixed(0)}% × baseline ${baseline_sharpe.toFixed(3)})`,
      should_auto_pause: algo_status === "active",
    };
  }
  if (shortBelow) {
    const longNote = longHasEnoughTrades
      ? `; long(${l.days}d) Sharpe ${l.sharpe?.toFixed(3)} still above threshold`
      : `; long(${l.days}d) has only ${l.n_trades} trades — insufficient to confirm sustained decay yet`;
    return {
      severity: "warn",
      reason:
        `Short window decay — short(${s.days}d) Sharpe ${s.sharpe?.toFixed(3)} ` +
        `< ${threshold.toFixed(3)}${longNote}`,
      should_auto_pause: false,
    };
  }
  return {
    severity: "none",
    reason:
      `Healthy — short(${s.days}d) Sharpe ${s.sharpe?.toFixed(3) ?? "n/a"} ` +
      `vs baseline ${baseline_sharpe.toFixed(3)} (threshold ${threshold.toFixed(3)})`,
    should_auto_pause: false,
  };
}

interface AlgoRow {
  id: string;
  name: string;
  status: string;
  live_trading_enabled: boolean | null;
  user_id: string;
  backtest_results: { sharpe_ratio?: number; [k: string]: unknown } | null;
}

/** Fetch one algo's closed paper_positions (most recent first) and run
 *  the decay classifier. Pure-ish (one DB read, no writes). */
export async function checkAlphaDecay(
  supabase: SupabaseClient,
  algo: AlgoRow,
  config: Required<AlphaDecayConfig> = DEFAULT_ALPHA_DECAY_CONFIG,
  now: Date = new Date(),
): Promise<AlphaDecayCheck> {
  const baseline_sharpe = typeof algo.backtest_results?.sharpe_ratio === "number"
    ? (algo.backtest_results.sharpe_ratio as number)
    : null;
  const longSinceMs = now.getTime() - config.long_window_days * 86_400_000;
  const shortSinceMs = now.getTime() - config.short_window_days * 86_400_000;
  // Pull positions covering the longer window (the short window is a
  // strict subset, computed in-memory).
  const { data, error } = await supabase
    .from("paper_positions")
    .select("side, entry_price, exit_price, initial_stop_loss_price, stop_loss_price, realized_pnl, closed_at")
    .eq("algorithm_id", algo.id)
    .eq("status", "closed")
    .gte("closed_at", new Date(longSinceMs).toISOString());
  if (error) throw new Error(`alpha-decay paper_positions query failed for ${algo.id}: ${error.message}`);
  const positions = (data ?? []) as ClosedPositionForDecay[];
  const rolling_short = rollingWindowStatsFromPositions(positions, shortSinceMs, config.short_window_days);
  const rolling_long = rollingWindowStatsFromPositions(positions, longSinceMs, config.long_window_days);
  const classification = classifyAlphaDecay({
    baseline_sharpe,
    rolling_short,
    rolling_long,
    algo_status: algo.status,
    config,
  });
  return {
    algorithm_id: algo.id,
    algorithm_name: algo.name,
    algo_status: algo.status,
    live_trading_enabled: algo.live_trading_enabled ?? false,
    baseline_sharpe,
    rolling_short,
    rolling_long,
    ...classification,
    evaluated_at: now.toISOString(),
  };
}

export interface EvaluateAndApplyResult {
  generated_at: string;
  evaluated: number;
  /** Per-algo decay checks. */
  per_algo: AlphaDecayCheck[];
  /** Algos that were auto-paused on THIS run (severity=decay AND was active). */
  paused: { algorithm_id: string; algorithm_name: string; reason: string }[];
  /** Counts by severity. */
  counts: Record<AlphaDecaySeverity, number>;
}

/** Cron entry point. Pulls all status='active' algos, runs the decay
 *  check, auto-pauses + writes alpha_decay_pause for any algo that
 *  classifier flagged. Returns a summary report.
 *
 *  Pause SQL: status='paused' + live_trading_enabled=false. Both fields
 *  flip so the scan stops AND broker mirroring stops. The operator
 *  manually un-pauses (no auto-recovery) — a false-positive decay should
 *  trigger a deliberate operator review before resumption. */
export async function evaluateAndApplyAlphaDecay(
  supabase: SupabaseClient,
  config: Required<AlphaDecayConfig> = DEFAULT_ALPHA_DECAY_CONFIG,
  now: Date = new Date(),
): Promise<EvaluateAndApplyResult> {
  const generated_at = now.toISOString();
  const { data: algos, error } = await supabase
    .from("algorithms")
    .select("id, name, status, live_trading_enabled, user_id, backtest_results")
    .eq("status", "active");
  if (error) throw new Error(`alpha-decay algorithms query failed: ${error.message}`);
  const rows = (algos ?? []) as AlgoRow[];
  const per_algo: AlphaDecayCheck[] = [];
  const paused: { algorithm_id: string; algorithm_name: string; reason: string }[] = [];
  const counts: Record<AlphaDecaySeverity, number> = {
    none: 0, warn: 0, decay: 0, insufficient_data: 0, no_baseline: 0,
  };
  for (const algo of rows) {
    const check = await checkAlphaDecay(supabase, algo, config, now);
    per_algo.push(check);
    counts[check.severity]++;
    if (check.should_auto_pause) {
      const { error: updErr } = await supabase
        .from("algorithms")
        .update({ status: "paused", live_trading_enabled: false })
        .eq("id", algo.id);
      if (updErr) throw new Error(`alpha-decay auto-pause UPDATE failed for ${algo.id}: ${updErr.message}`);
      const { error: logErr } = await supabase.from("activity_log").insert({
        user_id: algo.user_id,
        algorithm_id: algo.id,
        event_type: "alpha_decay_pause",
        details: {
          severity: check.severity,
          reason: check.reason,
          baseline_sharpe: check.baseline_sharpe,
          rolling_short: check.rolling_short,
          rolling_long: check.rolling_long,
          config,
        },
      });
      if (logErr) {
        // Log-and-continue: pause already applied; missing audit row is
        // bad but not as bad as crashing mid-loop and leaving other algos
        // unevaluated.
        console.error(`[alpha-decay] activity_log insert failed for ${algo.id}:`, logErr.message);
      }
      paused.push({ algorithm_id: algo.id, algorithm_name: algo.name, reason: check.reason });
    }
  }
  return { generated_at, evaluated: rows.length, per_algo, paused, counts };
}

export interface AlphaDecaySummary extends EvaluateAndApplyResult {
  /** Marker — buildAlphaDecaySummary is pure-read. evaluateAndApplyAlphaDecay
   *  applies the pause. Same shape so the FE can render either. */
  source: "snapshot";
}

/** Pure-read summary for the /reports drift tab. Same classification logic
 *  as evaluateAndApplyAlphaDecay but writes nothing. `paused` array will
 *  be empty unless the cron has already fired this run. */
export async function buildAlphaDecaySummary(
  supabase: SupabaseClient,
  config: Required<AlphaDecayConfig> = DEFAULT_ALPHA_DECAY_CONFIG,
  now: Date = new Date(),
): Promise<AlphaDecaySummary> {
  // Same algo set as the cron — only active. Operators paused for
  // unrelated reasons don't need an in-flight decay check.
  const { data: algos, error } = await supabase
    .from("algorithms")
    .select("id, name, status, live_trading_enabled, user_id, backtest_results")
    .eq("status", "active");
  if (error) throw new Error(`alpha-decay summary algorithms query failed: ${error.message}`);
  const rows = (algos ?? []) as AlgoRow[];
  const per_algo: AlphaDecayCheck[] = [];
  const counts: Record<AlphaDecaySeverity, number> = {
    none: 0, warn: 0, decay: 0, insufficient_data: 0, no_baseline: 0,
  };
  for (const algo of rows) {
    const check = await checkAlphaDecay(supabase, algo, config, now);
    per_algo.push(check);
    counts[check.severity]++;
  }
  // Sort: decay → warn → insufficient_data → no_baseline → none
  const sevOrder: Record<AlphaDecaySeverity, number> = {
    decay: 0, warn: 1, insufficient_data: 2, no_baseline: 3, none: 4,
  };
  per_algo.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity] || a.algorithm_name.localeCompare(b.algorithm_name));
  return {
    generated_at: now.toISOString(),
    evaluated: rows.length,
    per_algo,
    paused: [],
    counts,
    source: "snapshot",
  };
}
