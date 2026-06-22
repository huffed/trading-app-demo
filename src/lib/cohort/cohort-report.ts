/**
 * Cohort report — shared aggregation between the CLI cron
 * (`scripts/cohort-report.ts`) and the in-UI /reports Cohort tab.
 *
 * SG.6 closure (2026-06-22 NIGHT LATE): extracted from the CLI script so
 * the operator can read cohort decay flags + per-cohort expectancy +
 * shadow-gate candidates from /reports without tailing log files or
 * running the cron manually. The CLI cron continues to run weekly +
 * write dated JSON for historical diff.
 *
 * Honesty contract preserved from the original CLI script: with small n
 * the report explicitly says "insufficient n" rather than printing noise
 * as signal. Cohort gates were reverted once (#136/#137) for being
 * calibrated on a single window — this aggregator is the cadence that
 * prevents that class of mistake, not a license to repeat it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface CohortAggregate {
  /** Trade count in the bucket. */
  n: number;
  /** Count of trades with r_multiple > 0. */
  wins: number;
  /** Win-rate as percentage (0-100). 0 when n=0 (caller distinguishes via n). */
  win_rate_pct: number;
  /** Mean r_multiple. 0 when n=0. */
  mean_r: number;
  /** Sum of r_multiples — useful for "did this cohort contribute net positive?" */
  sum_r: number;
}

export interface CohortBucket {
  /** Bucket label — e.g. "trend" for regime, "v5_15m" for prompt_version,
   *  "70-74" for confidence range, etc. */
  value: string;
  stats: CohortAggregate;
}

export interface CohortDimensionReport {
  /** Dimension label — e.g. "regime", "prompt_version", "side". */
  label: string;
  /** Buckets sorted by n descending (largest cohort first). */
  buckets: CohortBucket[];
}

export interface DecayFlag {
  /** Which dimension+value showed decay (e.g. regime=trend). */
  dimension: string;
  value: string;
  recent_mean_r: number;
  prior_mean_r: number;
  recent_wr_pct: number;
  prior_wr_pct: number;
  recent_n: number;
  prior_n: number;
  /** Positive = mean R dropped (prior − recent). */
  mean_drop: number;
  /** Positive = WR dropped, in percentage points. */
  wr_drop_pp: number;
}

export interface ShadowGateCandidate {
  /** Dimension+value that's losing money. */
  dimension: string;
  value: string;
  n: number;
  mean_r: number;
  /** Operator-facing recommendation text. */
  rationale: string;
}

export interface CohortReport {
  /** ISO timestamp of when the report was built. */
  generated_at: string;
  /** "live" | "walk_forward" | "all" — controls which llm_decisions rows are pulled. */
  source: string;
  /** Half-window length in days for decay comparison. */
  days: number;
  /** Min n required in each half-window for a decay flag to qualify. */
  min_n: number;
  /** Total closed-trade cohort rows that survived the r_multiple filter. */
  total_trades: number;
  /** Subset of total_trades that carry entry_zone attribution
   *  (paper_positions.entry_reason populated since 2026-05-18). */
  trades_with_zone_tags: number;
  /** Decisions skipped because trade_outcome.r_multiple was missing. */
  trades_skipped_no_r: number;
  /** Per-dimension cohort expectancy table. */
  dimensions: CohortDimensionReport[];
  /** Flagged decay cohorts — mean_drop ≥ 0.5R or wr_drop_pp ≥ 20pp. */
  decay_flags: DecayFlag[];
  /** All-time cohorts with n≥8 and mean R ≤ −0.3. Recommended LOG-ONLY
   *  shadow gates scoped per algo+prompt_version. */
  shadow_gate_candidates: ShadowGateCandidate[];
}

export interface CohortReportOptions {
  /** Decay-comparison half-window length in days. Default 14. */
  days?: number;
  /** llm_decisions source filter. Default "live". */
  source?: "live" | "walk_forward" | "all";
  /** Min trades per half-window for a decay comparison. Default 5. */
  minN?: number;
}

interface TradeOutcome {
  r_multiple?: number;
  exit_reason?: string;
}

interface CohortTrade {
  date: Date;
  regime: string;
  prompt_version: string;
  side: string;
  conf_bucket: string;
  session_bucket: string;
  zone: string;
  exit_reason: string;
  r: number;
}

function sessionBucket(utcHour: number): string {
  if (utcHour < 7) return "asia(0-7)";
  if (utcHour < 13) return "london(7-13)";
  if (utcHour < 21) return "ny(13-21)";
  return "late(21-24)";
}

function confidenceBucket(c: number | null): string {
  if (c == null) return "n/a";
  if (c < 70) return "<70";
  if (c < 75) return "70-74";
  return "75+";
}

function aggregate(ts: CohortTrade[]): CohortAggregate {
  const n = ts.length;
  if (n === 0) {
    return { n: 0, wins: 0, win_rate_pct: 0, mean_r: 0, sum_r: 0 };
  }
  let wins = 0;
  let sum = 0;
  for (const t of ts) {
    if (t.r > 0) wins++;
    sum += t.r;
  }
  return {
    n,
    wins,
    win_rate_pct: (wins / n) * 100,
    mean_r: sum / n,
    sum_r: sum,
  };
}

function groupBy<K extends string>(
  ts: CohortTrade[],
  key: (t: CohortTrade) => K
): Map<K, CohortTrade[]> {
  const m = new Map<K, CohortTrade[]>();
  for (const t of ts) {
    const k = key(t);
    m.set(k, [...(m.get(k) ?? []), t]);
  }
  return m;
}

const DIMENSIONS: { label: string; key: (t: CohortTrade) => string }[] = [
  { label: "regime", key: (t) => t.regime },
  { label: "prompt_version", key: (t) => t.prompt_version },
  { label: "side", key: (t) => t.side },
  { label: "confidence", key: (t) => t.conf_bucket },
  { label: "session", key: (t) => t.session_bucket },
  { label: "entry_zone", key: (t) => t.zone },
  { label: "exit_reason", key: (t) => t.exit_reason },
];

/** Decay-flag thresholds. Match the CLI's original 0.5R / 20pp values so
 *  the /reports surface and the cron log report the same decay events. */
const DECAY_MEAN_R_DROP_THRESHOLD = 0.5;
const DECAY_WR_DROP_PP_THRESHOLD = 20;

/** Shadow-gate-candidate thresholds. Cohorts that exceed these are
 *  *recommendations* (log-only first; only enforce after weeks of
 *  shadow evidence per the cohort-gate reversal lessons). */
const SHADOW_MIN_N = 8;
const SHADOW_MEAN_R_THRESHOLD = -0.3;

/**
 * Pure aggregation step — separated from the DB-query step so unit
 * tests can drive synthetic CohortTrade arrays through without mocking
 * Supabase. The 5-arg `now` parameter lets tests control the
 * recent/prior split boundary.
 */
export function aggregateCohortTrades(
  trades: CohortTrade[],
  opts: { days: number; minN: number; now: Date }
): Pick<
  CohortReport,
  "dimensions" | "decay_flags" | "shadow_gate_candidates"
> {
  // Per-dimension all-time stats.
  const dimensions: CohortDimensionReport[] = DIMENSIONS.map((dim) => {
    const groups = groupBy(trades, dim.key);
    const buckets: CohortBucket[] = [...groups]
      .map(([value, ts]) => ({ value, stats: aggregate(ts) }))
      .sort((a, b) => b.stats.n - a.stats.n);
    return { label: dim.label, buckets };
  });

  // Decay flags: last DAYS vs the DAYS before it.
  const nowMs = opts.now.getTime();
  const recentStart = nowMs - opts.days * 86_400_000;
  const priorStart = nowMs - 2 * opts.days * 86_400_000;
  const recent = trades.filter((t) => t.date.getTime() >= recentStart);
  const prior = trades.filter(
    (t) => t.date.getTime() >= priorStart && t.date.getTime() < recentStart
  );

  const decay_flags: DecayFlag[] = [];
  for (const dim of DIMENSIONS) {
    const recentMap = groupBy(recent, dim.key);
    const priorMap = groupBy(prior, dim.key);
    for (const [value, rts] of recentMap) {
      const pts = priorMap.get(value) ?? [];
      if (rts.length < opts.minN || pts.length < opts.minN) continue;
      const ra = aggregate(rts);
      const pa = aggregate(pts);
      const mean_drop = pa.mean_r - ra.mean_r;
      const wr_drop_pp = pa.win_rate_pct - ra.win_rate_pct;
      if (mean_drop >= DECAY_MEAN_R_DROP_THRESHOLD || wr_drop_pp >= DECAY_WR_DROP_PP_THRESHOLD) {
        decay_flags.push({
          dimension: dim.label,
          value,
          recent_mean_r: ra.mean_r,
          prior_mean_r: pa.mean_r,
          recent_wr_pct: ra.win_rate_pct,
          prior_wr_pct: pa.win_rate_pct,
          recent_n: ra.n,
          prior_n: pa.n,
          mean_drop,
          wr_drop_pp,
        });
      }
    }
  }

  // Shadow-gate candidates: all-time, n ≥ 8, mean R ≤ −0.3, exclude
  // exit_reason (an outcome, not an entry cohort).
  const shadow_gate_candidates: ShadowGateCandidate[] = [];
  for (const dim of DIMENSIONS) {
    if (dim.label === "exit_reason") continue;
    const groups = groupBy(trades, dim.key);
    for (const [value, ts] of groups) {
      const a = aggregate(ts);
      if (a.n >= SHADOW_MIN_N && a.mean_r <= SHADOW_MEAN_R_THRESHOLD) {
        shadow_gate_candidates.push({
          dimension: dim.label,
          value,
          n: a.n,
          mean_r: a.mean_r,
          rationale: `${dim.label}=${value} (n=${a.n}, meanR ${a.mean_r.toFixed(2)}) → propose LOG-ONLY gate scoped per algo+prompt_version; enforce only after shadow evidence`,
        });
      }
    }
  }

  return { dimensions, decay_flags, shadow_gate_candidates };
}

/**
 * Build the cohort report from Supabase + apply aggregation. The
 * generator query mirrors the CLI's logic verbatim so the /reports
 * surface and the cron log read the same data.
 *
 * Always returns a valid CohortReport — empty `trades` produces empty
 * dimensions/flags/candidates, NOT an error. Operator can read
 * "0 trades — awaiting deploy" state cleanly.
 */
export async function buildCohortReport(
  supabase: SupabaseClient,
  opts: CohortReportOptions = {}
): Promise<CohortReport> {
  const days = opts.days ?? 14;
  const source = opts.source ?? "live";
  const minN = opts.minN ?? 5;
  const generated_at = new Date().toISOString();

  let q = supabase
    .from("llm_decisions")
    .select(
      "created_at, bar_date, regime, prompt_version, decision, confidence, paper_position_id, trade_outcome, source"
    )
    .in("decision", ["enter_long", "enter_short"])
    .not("trade_outcome", "is", null)
    .order("created_at", { ascending: true });
  if (source !== "all") q = q.eq("source", source);
  const { data: decisions, error } = await q;
  if (error) throw new Error(`llm_decisions query failed: ${error.message}`);
  const rows = decisions ?? [];

  // Join cohort tags from paper_positions.entry_reason (present on
  // entries opened after the 2026-05-18 attribution commit).
  const posIds = rows
    .map((r) => r.paper_position_id as string | null)
    .filter((id): id is string => typeof id === "string");
  const tagsById = new Map<string, Record<string, unknown>>();
  if (posIds.length > 0) {
    const { data: positions, error: posErr } = await supabase
      .from("paper_positions")
      .select("id, entry_reason")
      .in("id", posIds);
    if (posErr) throw new Error(`paper_positions tags query failed: ${posErr.message}`);
    for (const p of positions ?? []) {
      tagsById.set(p.id as string, (p.entry_reason ?? {}) as Record<string, unknown>);
    }
  }

  let trades_skipped_no_r = 0;
  const trades: CohortTrade[] = [];
  for (const r of rows) {
    const outcome = (r.trade_outcome ?? {}) as TradeOutcome;
    if (typeof outcome.r_multiple !== "number") {
      trades_skipped_no_r++;
      continue;
    }
    const tags = r.paper_position_id
      ? (tagsById.get(r.paper_position_id as string) ?? {})
      : {};
    const barDate = new Date((r.bar_date as string) ?? (r.created_at as string));
    trades.push({
      date: new Date(r.created_at as string),
      regime: (r.regime as string) ?? "n/a",
      prompt_version: (r.prompt_version as string) ?? "n/a",
      side: r.decision === "enter_long" ? "long" : "short",
      conf_bucket: confidenceBucket(r.confidence as number | null),
      session_bucket: sessionBucket(barDate.getUTCHours()),
      zone: typeof tags.entry_zone === "string" ? tags.entry_zone : "untagged",
      exit_reason: outcome.exit_reason ?? "n/a",
      r: outcome.r_multiple,
    });
  }

  const trades_with_zone_tags = trades.filter((t) => t.zone !== "untagged").length;
  const { dimensions, decay_flags, shadow_gate_candidates } = aggregateCohortTrades(trades, {
    days,
    minN,
    now: new Date(),
  });

  return {
    generated_at,
    source,
    days,
    min_n: minN,
    total_trades: trades.length,
    trades_with_zone_tags,
    trades_skipped_no_r,
    dimensions,
    decay_flags,
    shadow_gate_candidates,
  };
}
