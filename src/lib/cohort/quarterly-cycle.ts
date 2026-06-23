/**
 * H.5 — Quarterly research cycle. Generates the operator-facing cycle
 * report (markdown + structured payload) covering the 4 spec'd
 * artifacts:
 *   1. Feature library refresh — current FEATURES list + categories +
 *      count vs prior cycle
 *   2. Alpha library snapshot — active algo list with current
 *      backtest_results stats (return, DD, Sharpe, DSR when present)
 *   3. Decay report — alpha-decay summary across all live algos
 *      (reuses G.4 buildAlphaDecaySummary)
 *   4. New-hypothesis log — template section the operator fills in
 *      with backlog ideas for the next cycle
 *
 * Consumed by:
 *   - /api/cron/quarterly-cycle (auto-runs 1st of Jan/Apr/Jul/Oct)
 *   - Operator can curl ad-hoc for an on-demand cycle preview
 *
 * Replaces the manual cadence described in
 * `scripts/canonical/B6_continuous_validation_cadence.md` (marked
 * SUPERSEDED there). The monthly validate-algo-monthly-cron.sh still
 * runs as a sub-component; this cycle is the QUARTERLY review surface
 * spanning features + alphas + decay + hypotheses.
 *
 * Pure-ish — one read pass over the FEATURES registry + DB queries for
 * algos / decay. Never mutates the DB. The cron route persists the
 * markdown render to a file under /tmp; the operator copies into the
 * repo if they want to archive a particular cycle.
 */
import {
  buildAlphaDecaySummary,
  DEFAULT_ALPHA_DECAY_CONFIG,
  type AlphaDecaySummary,
} from "@/lib/cohort/alpha-decay";
import { FEATURES, FEATURES_BY_CATEGORY, type FeatureCategory } from "@/lib/features";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface FeatureLibrarySnapshot {
  total_count: number;
  by_category: Record<FeatureCategory, number>;
  feature_names: string[];
}

export interface AlphaSnapshotEntry {
  algorithm_id: string;
  algorithm_name: string;
  status: string;
  live_trading_enabled: boolean;
  ticker: string | null;
  /** From backtest_results — null when never validated. */
  baseline_total_return: number | null;
  baseline_max_drawdown: number | null;
  baseline_sharpe: number | null;
  baseline_win_rate: number | null;
  baseline_total_trades: number | null;
  /** From statistical_rigor.deflated.deflated_sharpe — null when never deflated. */
  deflated_sharpe: number | null;
  /** From statistical_rigor.deflated.pbo — null when never computed. */
  pbo: number | null;
}

export interface CycleReport {
  /** Cycle identifier — e.g. "2026-Q3". */
  cycle_id: string;
  /** ISO timestamp the cycle was generated. */
  generated_at: string;
  /** Next cycle's expected fire time (1st of next quarter UTC). */
  next_cycle_at: string;
  feature_library: FeatureLibrarySnapshot;
  alpha_library: AlphaSnapshotEntry[];
  decay: AlphaDecaySummary;
  /** Markdown-rendered version of the same payload. Operator-readable.
   *  Written to a file by the cron route + returned in the API response. */
  markdown: string;
}

/** Compute "YYYY-Qn" for the cycle the `now` date falls inside. */
export function cycleIdFor(now: Date): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0=Jan
  const q = Math.floor(m / 3) + 1; // 1..4
  return `${y}-Q${q}`;
}

/** First UTC moment of the NEXT quarter after `now`. */
export function nextCycleAt(now: Date): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const nextQStartMonth = (Math.floor(m / 3) + 1) * 3; // 3/6/9/12 → start of next q
  if (nextQStartMonth === 12) {
    return new Date(Date.UTC(y + 1, 0, 1, 0, 0, 0));
  }
  return new Date(Date.UTC(y, nextQStartMonth, 1, 0, 0, 0));
}

function buildFeatureLibrarySnapshot(): FeatureLibrarySnapshot {
  const by_category: Record<FeatureCategory, number> = {
    volatility: 0, momentum: 0, trend: 0, structure: 0,
    time: 0, volume: 0, context: 0, pattern: 0,
  };
  for (const cat of Object.keys(FEATURES_BY_CATEGORY) as FeatureCategory[]) {
    by_category[cat] = FEATURES_BY_CATEGORY[cat].length;
  }
  return {
    total_count: FEATURES.length,
    by_category,
    feature_names: FEATURES.map((f) => f.name),
  };
}

interface AlgoRow {
  id: string;
  name: string;
  status: string;
  live_trading_enabled: boolean | null;
  backtest_results: Record<string, unknown> | null;
  algorithm_watchlist?: { ticker: string }[] | null;
}

async function buildAlphaLibrarySnapshot(supabase: SupabaseClient): Promise<AlphaSnapshotEntry[]> {
  const { data, error } = await supabase
    .from("algorithms")
    .select("id, name, status, live_trading_enabled, backtest_results, algorithm_watchlist(ticker)")
    .in("status", ["active", "paused"])
    .order("name");
  if (error) throw new Error(`quarterly-cycle algorithms query failed: ${error.message}`);
  const rows = (data ?? []) as AlgoRow[];
  return rows.map((r) => {
    const br = r.backtest_results ?? {};
    const step2 = (br.step2 as Record<string, unknown> | undefined) ?? {};
    const stat = (br.statistical_rigor as Record<string, unknown> | undefined) ?? {};
    const deflated = (stat.deflated as Record<string, unknown> | undefined) ?? {};
    const deflatedSharpe = (deflated.deflated_sharpe as Record<string, unknown> | undefined)?.deflatedSharpe;
    const pbo = (deflated.pbo as Record<string, unknown> | undefined)?.probabilityOfBacktestOverfitting;
    const ticker = r.algorithm_watchlist?.[0]?.ticker ?? null;
    return {
      algorithm_id: r.id,
      algorithm_name: r.name,
      status: r.status,
      live_trading_enabled: r.live_trading_enabled ?? false,
      ticker,
      baseline_total_return: typeof step2.total_return === "number" ? step2.total_return : null,
      baseline_max_drawdown: typeof step2.max_static_dd === "number" ? step2.max_static_dd : null,
      baseline_sharpe: typeof br.sharpe_ratio === "number" ? br.sharpe_ratio : null,
      baseline_win_rate: typeof step2.win_rate === "number" ? step2.win_rate : null,
      baseline_total_trades: typeof step2.total_trades === "number" ? step2.total_trades : null,
      deflated_sharpe: typeof deflatedSharpe === "number" ? deflatedSharpe : null,
      pbo: typeof pbo === "number" ? pbo : null,
    };
  });
}

/** Render the markdown the operator reads. Sections mirror the spec's
 *  4 artifacts. Hypothesis-log section is a TEMPLATE prompt; the
 *  operator fills it in. */
export function renderCycleMarkdown(report: Omit<CycleReport, "markdown">): string {
  const lines: string[] = [];
  lines.push(`# Quarterly Research Cycle — ${report.cycle_id}`);
  lines.push("");
  lines.push(`**Generated:** ${report.generated_at}`);
  lines.push(`**Next cycle:** ${report.next_cycle_at}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // 1. Feature library refresh
  lines.push("## 1. Feature library refresh");
  lines.push("");
  lines.push(`**Total features:** ${report.feature_library.total_count}`);
  lines.push("");
  lines.push("| Category | Count |");
  lines.push("|---|---|");
  for (const cat of Object.keys(report.feature_library.by_category).sort()) {
    lines.push(`| ${cat} | ${report.feature_library.by_category[cat as FeatureCategory]} |`);
  }
  lines.push("");
  lines.push("<details><summary>All feature names</summary>");
  lines.push("");
  for (const name of report.feature_library.feature_names) {
    lines.push(`- \`${name}\``);
  }
  lines.push("");
  lines.push("</details>");
  lines.push("");

  // 2. Alpha library snapshot
  lines.push("## 2. Alpha library snapshot");
  lines.push("");
  if (report.alpha_library.length === 0) {
    lines.push("_No active or paused algorithms — nothing to snapshot._");
  } else {
    lines.push("| Algorithm | Status | Live | Return | DD | Sharpe | DSR | PBO | Trades |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const a of report.alpha_library) {
      const fmt = (n: number | null, dp = 2) => n == null ? "—" : n.toFixed(dp);
      lines.push(
        `| ${a.algorithm_name} | ${a.status} | ${a.live_trading_enabled ? "yes" : "no"} | ` +
        `${fmt(a.baseline_total_return, 0)} | ${fmt(a.baseline_max_drawdown)}% | ` +
        `${fmt(a.baseline_sharpe, 3)} | ${fmt(a.deflated_sharpe, 3)} | ` +
        `${fmt(a.pbo, 3)} | ${a.baseline_total_trades ?? "—"} |`,
      );
    }
  }
  lines.push("");

  // 3. Decay report
  lines.push("## 3. Alpha decay report (G.4)");
  lines.push("");
  lines.push(`**Evaluated:** ${report.decay.evaluated} active algos`);
  lines.push("");
  lines.push("| Severity | Count |");
  lines.push("|---|---|");
  for (const sev of ["decay", "warn", "none", "insufficient_data", "no_baseline"] as const) {
    lines.push(`| ${sev} | ${report.decay.counts[sev]} |`);
  }
  lines.push("");
  if (report.decay.per_algo.length > 0) {
    lines.push("| Algorithm | Severity | Baseline Sharpe | 30d Sharpe (n) | 90d Sharpe (n) |");
    lines.push("|---|---|---|---|---|");
    for (const d of report.decay.per_algo) {
      const fmt = (n: number | null, dp = 3) => n == null ? "—" : n.toFixed(dp);
      lines.push(
        `| ${d.algorithm_name} | ${d.severity} | ${fmt(d.baseline_sharpe)} | ` +
        `${fmt(d.rolling_short.sharpe)} (${d.rolling_short.n_trades}) | ` +
        `${fmt(d.rolling_long.sharpe)} (${d.rolling_long.n_trades}) |`,
      );
    }
  }
  lines.push("");

  // 4. New-hypothesis log (operator-fillable template)
  lines.push("## 4. New-hypothesis log");
  lines.push("");
  lines.push("> Operator-maintained. Each entry is a research thread for the NEXT cycle —");
  lines.push("> what to investigate, what evidence is needed, what success looks like.");
  lines.push("> If empty, no new hypotheses for the next cycle.");
  lines.push("");
  lines.push("- [ ] _(operator: add hypothesis here; e.g. 'Test whether `pattern_engulfing_signed` retains importance under regime split — depends on H.6')_");
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("_Generated by `scripts/canonical/quarterly-research-cycle.md` process; auto-run by `/api/cron/quarterly-cycle` on 1st of Jan/Apr/Jul/Oct UTC._");
  return lines.join("\n");
}

export async function buildQuarterlyCycleReport(
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<CycleReport> {
  const cycle_id = cycleIdFor(now);
  const generated_at = now.toISOString();
  const next_cycle_at = nextCycleAt(now).toISOString();
  const feature_library = buildFeatureLibrarySnapshot();
  const alpha_library = await buildAlphaLibrarySnapshot(supabase);
  const decay = await buildAlphaDecaySummary(supabase, DEFAULT_ALPHA_DECAY_CONFIG, now);
  const payload = { cycle_id, generated_at, next_cycle_at, feature_library, alpha_library, decay };
  const markdown = renderCycleMarkdown(payload);
  return { ...payload, markdown };
}
