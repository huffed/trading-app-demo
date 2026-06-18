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
import { z } from "zod";

/** B.2.7: distinguishes true pre-registration (criteria set BEFORE seeing
 *  the data) from post-hoc forward commitments (criteria locked AFTER
 *  initial validation, treated as a "do not relax this bar" promise for
 *  future re-runs). Reporting + interpretation differ between the two:
 *  - "true-prereg" entries can claim statistical novelty
 *  - "post-hoc-locked" entries cannot — they're discipline, not science */
export const RegistrationTypeSchema = z.enum(["true-prereg", "post-hoc-locked"]);
export type RegistrationType = z.infer<typeof RegistrationTypeSchema>;

/** B.2.8: Zod schema for a single prereg entry. Strict (`.strict()`)
 *  rejects unknown fields → typos in field names (e.g. `min_static_dd`
 *  instead of `max_static_dd`) fail the load loudly instead of silently
 *  being ignored. */
export const PreregisteredCriteriaSchema = z.object({
  hypothesis: z.string().min(1),
  registered_at: z.string().datetime({ offset: true }),
  expires_at: z.string().datetime({ offset: true }),
  /** B.2.7: must be declared explicitly. No silent default. */
  registration_type: RegistrationTypeSchema,
  min_total_return: z.number().optional(),
  min_win_rate: z.number().optional(),
  max_static_dd: z.number().optional(),
  max_daily_dd: z.number().optional(),
  min_mean_r_ci_lower: z.number().optional(),
  max_bonferroni_p_value: z.number().optional(),
  max_oos_r_delta_pct: z.number().optional(),
  min_held_out_trades: z.number().int().nonnegative().optional(),
}).strict();

export type PreregisteredCriteria = z.infer<typeof PreregisteredCriteriaSchema>;

export const PreregistrationFileSchema = z.record(z.string(), PreregisteredCriteriaSchema);
export type PreregistrationFile = z.infer<typeof PreregistrationFileSchema>;

/** Loads + validates the pre-registration file. THROWS on schema failure
 *  (typo in field name, missing required field, invalid type, etc.) so
 *  a malformed file can never silently disable criteria. */
export function loadPreregistrations(path: string): PreregistrationFile {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const result = PreregistrationFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(
      `Preregistration file ${path} failed schema validation: ${issues}${result.error.issues.length > 5 ? ` (+ ${result.error.issues.length - 5} more)` : ""}`
    );
  }
  return result.data;
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
  /** B.2.7: surfaces whether the registration is true-prereg (criteria
   *  set before seeing data) or post-hoc-locked (criteria set after,
   *  enforced as forward commitment). Affects interpretation: only
   *  true-prereg passes claim statistical novelty. */
  registration_type?: RegistrationType;
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
    registration_type: entry.registration_type,
    passed: failed.length === 0,
    failed_criteria: failed,
  };
}
