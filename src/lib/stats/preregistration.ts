/** Pre-registered acceptance criteria.
 *
 *  Locks the ship/no-ship bar PER ALGO BEFORE the data is re-run under
 *  any new gate or config. Prevents the failure mode: "post-hoc relax
 *  the criteria to keep the candidate alive" (we did this twice in
 *  STEPS 3 and 6 — the Phase B reshape catches it from happening again).
 *
 *  Workflow:
 *    1. Decide criteria for a candidate (e.g. "step2 PASS + CI lower > 0 + p<bonferroni").
 *    2. Write entry to scripts/canonical/preregistration.json with registered_at + expires_at.
 *    3. Run the validator. If algo has a non-expired entry, ONLY those criteria gate ship.
 *    4. To change criteria for an already-registered algo: explicit re-registration with
 *       new registered_at — leaves trail in git diff so post-hoc tweaks are visible.
 *
 *  An algo with NO pre-registration falls back to default criteria. The
 *  fallback exists so we can add the loader without blocking existing
 *  validation; algos that matter eventually get registered. */

import { readFileSync, existsSync } from "fs";

export interface PreregisteredCriteria {
  /** Free-form text explaining the hypothesis ("WR ≥ 40% on FTMO challenge"). */
  hypothesis: string;
  /** ISO-8601. Registered BEFORE data was re-run. */
  registered_at: string;
  /** ISO-8601. After this, the registration is stale; validator re-prompts for fresh criteria. */
  expires_at: string;
  /** Optional step-2 floor on point-estimate stats. */
  min_total_return?: number;
  min_win_rate?: number;
  max_static_dd?: number;
  max_daily_dd?: number;
  /** Bootstrap-CI lower-bound floor on mean R. Tightens "edge exists" to "edge exists at 95% CI". */
  min_mean_r_ci_lower?: number;
  /** Bonferroni-corrected p-value ceiling on "mean R > 0". */
  max_bonferroni_p_value?: number;
  /** Out-of-sample R-delta tolerance vs in-sample. */
  max_oos_r_delta_pct?: number;
  /** Minimum held-out trade count (Phase B drops the SMALL_N exception by default). */
  min_held_out_trades?: number;
}

export type PreregistrationFile = Record<string, PreregisteredCriteria>;

export function loadPreregistrations(path: string): PreregistrationFile {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as PreregistrationFile;
}

export function getPreregistration(
  file: PreregistrationFile,
  algoName: string,
  now: Date
): PreregisteredCriteria | null {
  const entry = file[algoName];
  if (!entry) return null;
  const expires = new Date(entry.expires_at);
  if (Number.isNaN(expires.getTime())) return null;
  if (expires.getTime() < now.getTime()) return null;
  return entry;
}

export interface PreregistrationCheck {
  algo_name: string;
  has_preregistration: boolean;
  expires_at?: string;
  passed: boolean;
  failed_criteria: string[];
}

export interface ObservedStats {
  total_return: number;
  win_rate: number;
  max_static_dd: number;
  max_daily_dd: number;
  mean_r_ci_lower: number;
  bonferroni_p_value: number;
  oos_r_delta_pct: number;
  held_out_trades: number;
}

/** Compare observed stats against pre-registered criteria. Returns the
 *  list of failed criteria (empty = passes). Algos without a registration
 *  return {has_preregistration: false, passed: true} — they're not
 *  blocked, but the verdict carries the "unregistered" tag so the
 *  caller can apply lighter trust. */
export function checkPreregistration(
  algoName: string,
  observed: ObservedStats,
  preregs: PreregistrationFile,
  now: Date
): PreregistrationCheck {
  const entry = getPreregistration(preregs, algoName, now);
  if (!entry) {
    return { algo_name: algoName, has_preregistration: false, passed: true, failed_criteria: [] };
  }
  const failed: string[] = [];
  if (entry.min_total_return !== undefined && observed.total_return < entry.min_total_return) {
    failed.push(`total_return ${observed.total_return} < ${entry.min_total_return}`);
  }
  if (entry.min_win_rate !== undefined && observed.win_rate < entry.min_win_rate) {
    failed.push(`win_rate ${observed.win_rate}% < ${entry.min_win_rate}%`);
  }
  if (entry.max_static_dd !== undefined && observed.max_static_dd > entry.max_static_dd) {
    failed.push(`static_dd ${observed.max_static_dd}% > ${entry.max_static_dd}%`);
  }
  if (entry.max_daily_dd !== undefined && observed.max_daily_dd > entry.max_daily_dd) {
    failed.push(`daily_dd ${observed.max_daily_dd}% > ${entry.max_daily_dd}%`);
  }
  if (entry.min_mean_r_ci_lower !== undefined && observed.mean_r_ci_lower < entry.min_mean_r_ci_lower) {
    failed.push(`mean_r_ci_lower ${observed.mean_r_ci_lower.toFixed(3)} < ${entry.min_mean_r_ci_lower}`);
  }
  if (entry.max_bonferroni_p_value !== undefined && observed.bonferroni_p_value > entry.max_bonferroni_p_value) {
    failed.push(`bonferroni_p ${observed.bonferroni_p_value.toFixed(4)} > ${entry.max_bonferroni_p_value}`);
  }
  if (entry.max_oos_r_delta_pct !== undefined && Math.abs(observed.oos_r_delta_pct) > entry.max_oos_r_delta_pct) {
    failed.push(`|oos_r_delta| ${Math.abs(observed.oos_r_delta_pct).toFixed(1)}% > ${entry.max_oos_r_delta_pct}%`);
  }
  if (entry.min_held_out_trades !== undefined && observed.held_out_trades < entry.min_held_out_trades) {
    failed.push(`held_out_trades ${observed.held_out_trades} < ${entry.min_held_out_trades}`);
  }
  return {
    algo_name: algoName,
    has_preregistration: true,
    expires_at: entry.expires_at,
    passed: failed.length === 0,
    failed_criteria: failed,
  };
}
