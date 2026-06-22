/**
 * Drift summary — operator-facing report surface for the /reports
 * Drift tab. SG.5 closure (2026-06-22 NIGHT LATE).
 *
 * Two layers:
 *   1. Current per-algo drift state — runs `detectDrift` against every
 *      algo with a `backtest_results.win_rate` baseline. Returns the
 *      same `DriftCheckResult` the scan engine consumes, so the UI's
 *      view of drift severity matches what the engine would do on its
 *      next post-close pass.
 *   2. Recent drift event history — pulls `activity_log` rows with
 *      `event_type ∈ ('drift_halt','drift_warn')` for the last N days
 *      + joins algo name. Diagnostic surface for "when did drift fire
 *      historically?"
 *
 * Why this exists separately from `drift-detector.ts`: the detector
 * module is engine-loop code (called from `runPostCloseAnalytics`).
 * This module is the OPERATOR REVIEW SURFACE — pulls + aggregates +
 * formats for UI consumption. The detector's contract stays unchanged.
 *
 * Mirrors the `cohort-report.ts` + `engine-activity.ts` +
 * `live-mirror-eligibility.ts` siblings in this directory — each one
 * is a pure read-side aggregator the /reports server action + CLI
 * scripts can both consume.
 */
import {
  DEFAULT_DRIFT_CONFIG,
  detectDrift,
  type DriftConfig,
  type DriftSeverity,
} from "@/lib/scan/drift-detector";
import type { BacktestResults } from "@/types/algorithm";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface AlgoDriftStatus {
  algorithm_id: string;
  algorithm_name: string;
  /** None | warn | halt — matches detectDrift's severity contract. */
  severity: DriftSeverity;
  /** Human-readable reason string from detectDrift. Always present. */
  reason: string;
  /** Recent live-trade stats (over the lookback window). */
  recent_trades: number;
  recent_win_rate: number;
  recent_net_pnl: number;
  /** Baseline stats from backtest_results. null when algo had no baseline. */
  baseline_win_rate: number | null;
  baseline_total_return: number | null;
  /** Quick-lookup label for sorting / filtering. "live" / "paper" / "paused" / "off". */
  algo_status: string;
}

export interface DriftEvent {
  /** ISO timestamp the event fired. */
  when: string;
  algorithm_id: string;
  algorithm_name: string;
  /** `drift_halt` | `drift_warn`. */
  event_type: "drift_halt" | "drift_warn";
  /** detectDrift's `severity` field at fire time. Matches event_type but
   *  carried separately because pre-existing rows may have either shape. */
  severity: DriftSeverity | "unknown";
  /** detectDrift's `reason` field at fire time. */
  reason: string;
  /** Stat snapshot at fire time. May be partial if older rows weren't
   *  tagged with the full payload. */
  recent_trades?: number;
  recent_win_rate?: number;
  recent_net_pnl?: number;
  baseline_win_rate?: number | null;
  baseline_total_return?: number | null;
}

export interface DriftSummary {
  /** ISO timestamp the report was built. */
  generated_at: string;
  /** How many days of activity_log history were pulled for `recent_events`. */
  history_days: number;
  /** Per-algo current drift state. One row per algo with a baseline. */
  per_algo: AlgoDriftStatus[];
  /** Counts by severity across `per_algo` — for the summary cards. */
  severity_counts: { none: number; warn: number; halt: number; no_baseline: number };
  /** Last N drift events from activity_log. */
  recent_events: DriftEvent[];
}

export interface DriftSummaryOptions {
  /** History window for `recent_events`. Default 30 days. */
  history_days?: number;
  /** Max event rows. Default 50. */
  event_limit?: number;
  /** Drift detector config override — primarily for tests. */
  drift_config?: DriftConfig;
}

interface AlgoRow {
  id: string;
  name: string;
  status: string;
  backtest_results: { win_rate?: number; total_return?: number; [k: string]: unknown } | null;
  rules: { drift?: { min_live_wr_pct?: number } | null } | null;
}

interface ActivityRow {
  created_at: string;
  algorithm_id: string;
  event_type: string;
  details: {
    severity?: DriftSeverity;
    reason?: string;
    recent?: { trades?: number; win_rate?: number; net_pnl?: number };
    baseline?: { win_rate?: number | null; total_return?: number | null };
  } | null;
}

/**
 * Per-algo drift loop — extracted from buildDriftSummary so the
 * orchestrator stays under the 80-LOC function cap. Returns the
 * populated per_algo array + severity counts.
 */
async function evaluatePerAlgoDrift(
  supabase: SupabaseClient,
  rows: AlgoRow[],
  opts: DriftSummaryOptions
): Promise<{
  per_algo: AlgoDriftStatus[];
  counts: { none: number; warn: number; halt: number; no_baseline: number };
}> {
  const per_algo: AlgoDriftStatus[] = [];
  const counts = { none: 0, warn: 0, halt: 0, no_baseline: 0 };

  for (const row of rows) {
    const baseline = row.backtest_results as BacktestResults | null;
    const hasBaseline = baseline && typeof baseline.win_rate === "number";

    if (!hasBaseline) {
      counts.no_baseline++;
      per_algo.push({
        algorithm_id: row.id,
        algorithm_name: row.name,
        severity: "none",
        reason: "No backtest baseline — drift check skipped",
        recent_trades: 0,
        recent_win_rate: 0,
        recent_net_pnl: 0,
        baseline_win_rate: null,
        baseline_total_return: null,
        algo_status: row.status,
      });
      continue;
    }

    const config = opts.drift_config ?? {
      ...DEFAULT_DRIFT_CONFIG,
      minLiveWrPct: row.rules?.drift?.min_live_wr_pct,
    };
    const result = await detectDrift(supabase, row.id, baseline, config);

    if (result.severity === "halt") counts.halt++;
    else if (result.severity === "warn") counts.warn++;
    else counts.none++;

    per_algo.push({
      algorithm_id: row.id,
      algorithm_name: row.name,
      severity: result.severity,
      reason: result.reason,
      recent_trades: result.recent.trades,
      recent_win_rate: result.recent.win_rate,
      recent_net_pnl: result.recent.net_pnl,
      baseline_win_rate: result.baseline.win_rate,
      baseline_total_return: result.baseline.total_return,
      algo_status: row.status,
    });
  }

  // Sort per_algo: halt → warn → none → no_baseline; within severity,
  // alphabetically by name. Operator sees actionable rows first.
  const sevOrder: Record<string, number> = { halt: 0, warn: 1, none: 2 };
  per_algo.sort((a, b) => {
    const aRank = a.baseline_win_rate == null ? 3 : (sevOrder[a.severity] ?? 2);
    const bRank = b.baseline_win_rate == null ? 3 : (sevOrder[b.severity] ?? 2);
    if (aRank !== bRank) return aRank - bRank;
    return a.algorithm_name.localeCompare(b.algorithm_name);
  });

  return { per_algo, counts };
}

/**
 * Aggregate per-algo drift state + history events. Pure-ish (no DB
 * mutations); makes 1 algorithms query + 1 activity_log query + 1
 * detectDrift call per algo.
 *
 * Always returns a valid summary — zero algos / zero events produce
 * empty arrays + zero counts. Operator reads "no drift events yet"
 * cleanly.
 */
export async function buildDriftSummary(
  supabase: SupabaseClient,
  opts: DriftSummaryOptions = {}
): Promise<DriftSummary> {
  const history_days = opts.history_days ?? 30;
  const event_limit = opts.event_limit ?? 50;
  const generated_at = new Date().toISOString();

  // Pull all algos. Drift check only runs for those with a baseline.
  const { data: algos, error: algoErr } = await supabase
    .from("algorithms")
    .select("id, name, status, backtest_results, rules")
    .order("name");
  if (algoErr) throw new Error(`algorithms query failed: ${algoErr.message}`);
  const rows = (algos ?? []) as AlgoRow[];

  const { per_algo, counts } = await evaluatePerAlgoDrift(supabase, rows, opts);

  // Pull recent drift events. activity_log.event_type ∈ {drift_halt, drift_warn}.
  const sinceIso = new Date(Date.now() - history_days * 86_400_000).toISOString();
  const { data: events, error: eventsErr } = await supabase
    .from("activity_log")
    .select("created_at, algorithm_id, event_type, details")
    .in("event_type", ["drift_halt", "drift_warn"])
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(event_limit);
  if (eventsErr) throw new Error(`activity_log query failed: ${eventsErr.message}`);

  // Map algo_id → name for join (avoid N+1)
  const algoNameById = new Map(rows.map((r) => [r.id, r.name]));

  const recent_events: DriftEvent[] = ((events ?? []) as ActivityRow[]).map((e) => {
    const d = e.details ?? {};
    const event_type = e.event_type === "drift_halt" ? "drift_halt" : "drift_warn";
    return {
      when: e.created_at,
      algorithm_id: e.algorithm_id,
      algorithm_name: algoNameById.get(e.algorithm_id) ?? `(unknown ${e.algorithm_id.slice(0, 8)})`,
      event_type,
      severity: (d.severity ?? "unknown") as DriftSeverity | "unknown",
      reason: d.reason ?? "(no reason recorded)",
      recent_trades: d.recent?.trades,
      recent_win_rate: d.recent?.win_rate,
      recent_net_pnl: d.recent?.net_pnl,
      baseline_win_rate: d.baseline?.win_rate ?? null,
      baseline_total_return: d.baseline?.total_return ?? null,
    };
  });

  return {
    generated_at,
    history_days,
    per_algo,
    severity_counts: counts,
    recent_events,
  };
}
