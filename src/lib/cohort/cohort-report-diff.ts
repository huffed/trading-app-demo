/**
 * Cohort-report diff — surfaces what changed between two consecutive
 * weekly cohort cron runs. SG.6.2 closure (2026-06-22 NIGHT LATE).
 *
 * Operator runs after the cohort-report cron fires; diffs the latest
 * dated JSON against the one before. Catches:
 *   - NEW decay flags (cohort decayed THIS week that wasn't decayed last)
 *   - DISAPPEARED decay flags (cohort recovered)
 *   - NEW shadow-gate candidates (cohort crossed the n≥8/meanR≤−0.3 line)
 *   - DISAPPEARED shadow-gate candidates (cohort improved or grew)
 *   - Trade-count growth (latest.total_trades − prior.total_trades)
 *
 * Identity key for "same flag/candidate" across two runs: `${dimension}:${value}`.
 *
 * Pure function — no FS, no DB. The CLI wrapper (`scripts/cohort-report-diff.ts`)
 * reads the dated JSON files + calls this helper. Tests drive synthetic
 * CohortReport pairs through without filesystem.
 *
 * Schema compatibility: only operates on the post-SG.6.1 CohortReport
 * shape (typed arrays). Pre-SG.6.1 dated files have a different schema
 * (nested Records) — the CLI wrapper rejects them with a clear error
 * pointing at the SG.6.1 boundary.
 */
import type {
  CohortReport,
  DecayFlag,
  ShadowGateCandidate,
} from "./cohort-report";

export interface CohortReportDiff {
  /** Prior file's generated_at — for the operator to see WHEN. */
  prior_generated_at: string;
  latest_generated_at: string;
  /** Latest total_trades − prior. Positive = new cohort data accumulated. */
  trade_growth: number;
  /** Decay flags present in latest but NOT in prior. ACTIONABLE: new decay. */
  new_decay_flags: DecayFlag[];
  /** Decay flags present in prior but NOT in latest. Cohort recovered OR
   *  fell out of the n≥min_n eligibility window. */
  disappeared_decay_flags: DecayFlag[];
  /** Shadow-gate candidates present in latest but NOT in prior. */
  new_shadow_candidates: ShadowGateCandidate[];
  /** Shadow-gate candidates present in prior but NOT in latest. */
  disappeared_shadow_candidates: ShadowGateCandidate[];
}

function decayKey(f: DecayFlag): string {
  return `${f.dimension}:${f.value}`;
}

function shadowKey(c: ShadowGateCandidate): string {
  return `${c.dimension}:${c.value}`;
}

/**
 * Diff two CohortReport snapshots. Pure function — same input → same output.
 *
 * Returns the lists of new/disappeared items. Both lists may be empty
 * (no change), which is the steady-state expected on quiet weeks.
 */
export function diffCohortReports(prior: CohortReport, latest: CohortReport): CohortReportDiff {
  const priorDecayKeys = new Set(prior.decay_flags.map(decayKey));
  const latestDecayKeys = new Set(latest.decay_flags.map(decayKey));
  const new_decay_flags = latest.decay_flags.filter((f) => !priorDecayKeys.has(decayKey(f)));
  const disappeared_decay_flags = prior.decay_flags.filter(
    (f) => !latestDecayKeys.has(decayKey(f))
  );

  const priorShadowKeys = new Set(prior.shadow_gate_candidates.map(shadowKey));
  const latestShadowKeys = new Set(latest.shadow_gate_candidates.map(shadowKey));
  const new_shadow_candidates = latest.shadow_gate_candidates.filter(
    (c) => !priorShadowKeys.has(shadowKey(c))
  );
  const disappeared_shadow_candidates = prior.shadow_gate_candidates.filter(
    (c) => !latestShadowKeys.has(shadowKey(c))
  );

  return {
    prior_generated_at: prior.generated_at,
    latest_generated_at: latest.generated_at,
    trade_growth: latest.total_trades - prior.total_trades,
    new_decay_flags,
    disappeared_decay_flags,
    new_shadow_candidates,
    disappeared_shadow_candidates,
  };
}

/**
 * True iff the diff contains no actionable changes — operator can skip
 * the review for that week. Useful as a cron-tail exit-code signal.
 */
export function isQuietDiff(diff: CohortReportDiff): boolean {
  return (
    diff.new_decay_flags.length === 0 &&
    diff.disappeared_decay_flags.length === 0 &&
    diff.new_shadow_candidates.length === 0 &&
    diff.disappeared_shadow_candidates.length === 0
  );
}
