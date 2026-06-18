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

  // NaN guard: a NaN observed value with an active criterion fails loudly.
  // Without this guard, `NaN < threshold` and `NaN > threshold` both return
  // false, so zero-trade / boundary-empty algos silently pass criteria they
  // have no evidence to support.
  const failsMin = (observed: number, threshold: number | undefined, label: string, fmt: (n: number) => string): void => {
    if (threshold === undefined) return;
    if (Number.isNaN(observed)) { failed.push(`${label} NaN (no observation) < ${threshold}`); return; }
    if (observed < threshold) failed.push(`${label} ${fmt(observed)} < ${threshold}`);
  };
  const failsMax = (observed: number, threshold: number | undefined, label: string, fmt: (n: number) => string): void => {
    if (threshold === undefined) return;
    if (Number.isNaN(observed)) { failed.push(`${label} NaN (no observation) > ${threshold}`); return; }
    if (observed > threshold) failed.push(`${label} ${fmt(observed)} > ${threshold}`);
  };

  failsMin(observed.total_return, entry.min_total_return, "total_return", (n) => String(n));
  failsMin(observed.win_rate, entry.min_win_rate, "win_rate", (n) => `${n}%`);
  failsMax(observed.max_static_dd, entry.max_static_dd, "static_dd", (n) => `${n}%`);
  failsMax(observed.max_daily_dd, entry.max_daily_dd, "daily_dd", (n) => `${n}%`);
  failsMin(observed.mean_r_ci_lower, entry.min_mean_r_ci_lower, "mean_r_ci_lower", (n) => n.toFixed(3));
  failsMax(observed.bonferroni_p_value, entry.max_bonferroni_p_value, "bonferroni_p", (n) => n.toFixed(4));
  failsMax(Math.abs(observed.oos_r_delta_pct), entry.max_oos_r_delta_pct, "|oos_r_delta|", (n) => `${n.toFixed(1)}%`);
  failsMin(observed.held_out_trades, entry.min_held_out_trades, "held_out_trades", (n) => String(n));
  return {
    algo_name: algoName,
    has_preregistration: true,
    expires_at: entry.expires_at,
    passed: failed.length === 0,
    failed_criteria: failed,
  };
}
