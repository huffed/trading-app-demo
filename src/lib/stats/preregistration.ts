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

/** B.2.7 + B.2.32 (Stage 3.2, 2026-06-20): three registration kinds.
 *
 *  - `"true-prereg"` — criteria set BEFORE the data existed. Highest
 *    evidentiary status. The evaluation is genuinely held-out; passing
 *    is statistical novelty (subject to multiple-comparison correction).
 *
 *  - `"forward-pre-registered"` — criteria informed by historical
 *    analysis but EVALUATED only against data accumulated AFTER the
 *    `registered_at` timestamp. The historical analysis "snooped" the
 *    in-sample distribution, but the forward-only evaluation window is
 *    a clean held-out test. Between true-prereg and post-hoc on the
 *    evidence-strength spectrum.
 *
 *  - `"post-hoc-locked"` — criteria set AFTER seeing the full data + applied
 *    to BOTH past and future runs. NOT statistical novelty; it's a
 *    discipline commitment ("don't relax this bar even when next month's
 *    re-run nudges it"). Useful for operator hygiene; not publishable.
 *
 *  Evaluation semantics for all three are identical (same observed-vs-criteria
 *  comparison). Difference is in interpretation + reporting. */
export const RegistrationTypeSchema = z.enum([
  "true-prereg",
  "forward-pre-registered",
  "post-hoc-locked",
]);
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
 *  a malformed file can never silently disable criteria.
 *
 *  B.2.39 fix (2026-06-19 EVE): JSON.parse is now wrapped to distinguish
 *  JSON-syntax errors (raw file contains invalid JSON) from schema
 *  validation errors (JSON parses but doesn't match the expected shape).
 *  Previously a missing closing brace bubbled up as the V8 default
 *  `SyntaxError: Unexpected end of JSON input` with no path context — the
 *  operator couldn't tell whether the issue was in the prereg JSON or
 *  somewhere else in the validator pipeline.
 *
 *  B.2.34 (Stage 3.2, 2026-06-20) — DESIGN DECISION RECORDED HERE.
 *  The "throw mid-run on any schema failure" behaviour is INTENTIONAL +
 *  KEPT. Rejected alternative: catch per-algo + warn + fall back to default
 *  criteria for the bad entry. Reasoning:
 *
 *  1. Typos are easier to fix when they fail loudly. Per-algo fallback
 *     would mask the typo until weeks later (when the operator notices
 *     the algo's ELIGIBLE verdict isn't being gated by the criteria they
 *     thought they registered).
 *  2. The operator now has a 50ms standalone smoke check —
 *     `pnpm dlx tsx scripts/canonical/validate-preregistration.ts` — that
 *     catches schema errors BEFORE committing to a long PERSIST=1 fleet
 *     run. The "throw mid-run on a long run" risk is bounded by running
 *     the smoke check first (or scheduling it as a pre-commit hook).
 *  3. Per-algo fallback would have to choose what "default criteria"
 *     means — an unconfigured algo currently flows through legacy step
 *     verdicts (step2/3/6). That's NOT a default criteria set; it's a
 *     different code path. Conflating "registered but broken" with
 *     "unregistered" would produce confusing operator-facing verdicts.
 *
 *  Escape hatch: if a future need arises (e.g. a giant prereg file where
 *  one bad entry blocks ~30 valid entries), introduce
 *  `STRICT_PREREG=0` env that switches to per-algo skip-with-warn mode.
 *  Until that need surfaces, default-throw stays. */
export function loadPreregistrations(path: string): PreregistrationFile {
  // B.2.45 (Stage 3, 2026-06-19 EVE): TOCTOU-resilient — readFileSync is
  // wrapped in try/catch so a file deleted between existsSync and
  // readFileSync (or unreadable due to permissions) surfaces a focused
  // error rather than an uncaught ENOENT. existsSync stays as a fast-path
  // for the common "file legitimately absent" case.
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Preregistration file ${path} exists but could not be read: ${detail}. ` +
      `Check file permissions or whether the file was deleted between existence-check and read.`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Preregistration file ${path} contains invalid JSON: ${detail}. ` +
      `Open the file and verify it parses (e.g. \`pnpm dlx tsx -e "JSON.parse(require('fs').readFileSync('${path}','utf8'))"\`).`
    );
  }
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

/** B.2.17 + B.2.46 (Stage 3, 2026-06-19 EVE): malformed dates surface as
 *  a `console.warn` BEFORE silently returning null. Previously a typo in
 *  `expires_at` (e.g. "2027-31-12" instead of "2027-12-31") would skip
 *  the entry without operator notice — the algo would silently fall back
 *  to default criteria, and the operator wouldn't realise the prereg
 *  was effectively dead. */
export function getPreregistration(
  file: PreregistrationFile,
  algoName: string,
  now: Date
): PreregisteredCriteria | null {
  const entry = file[algoName];
  if (!entry) return null;
  const expires = new Date(entry.expires_at);
  if (Number.isNaN(expires.getTime())) {
    console.warn(
      `[preregistration] ${algoName}: malformed expires_at="${entry.expires_at}" — entry SKIPPED (algo falls back to defaults). Fix the date or remove the entry.`
    );
    return null;
  }
  // Also validate registered_at — it's not used for expiry math but a
  // malformed value indicates broken provenance (when was this locked?).
  const registered = new Date(entry.registered_at);
  if (Number.isNaN(registered.getTime())) {
    console.warn(
      `[preregistration] ${algoName}: malformed registered_at="${entry.registered_at}" — entry will be used but provenance is unverifiable. Fix the timestamp.`
    );
  }
  if (expires.getTime() < now.getTime()) return null;
  return entry;
}

export interface PreregistrationCheck {
  algo_name: string;
  has_preregistration: boolean;
  expires_at?: string;
  /** B.2.7 + B.2.32: surfaces which registration kind this entry uses.
   *  Three values — see `RegistrationTypeSchema` jsdoc for evidence-
   *  strength implications. Only `true-prereg` passes can claim
   *  statistical novelty; `forward-pre-registered` passes claim clean
   *  held-out evidence (without the BEFORE-the-data property);
   *  `post-hoc-locked` passes claim only operator-discipline commitment. */
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
