/**
 * Validator-output helpers — pure functions extracted from
 * `scripts/canonical/validate-algo.ts` so the contracts can be regression-
 * tested without spawning the script.
 *
 * Extracted at B.2.25/26/27 (2026-06-22 NIGHT LATE). The original logic
 * was inline at validate-algo.ts:420-422 (family rationale) and
 * validate-algo.ts:954-966 (prereg expiry classification). Behavior is
 * preserved verbatim; the script now imports these helpers.
 *
 * Each helper carries the punch-item annotation it locks down:
 *  - B.2.4 → buildBonferroniFamilyRationale (B.2.26 regression test)
 *  - B.2.9 → classifyPreregExpiry (B.2.27 regression test)
 *
 * For B.2.25 (computed_at must come from args.now, never a hardcoded
 * literal): the contract lives in analyzeStats() which isn't extracted
 * yet. Source-level meta-test in validator-output.test.ts scans
 * validate-algo.ts for `computed_at: "<literal>"` patterns.
 */
import type { PreregisteredCriteria } from "./preregistration";

/**
 * Bonferroni family-rationale string. Default case (testsPerAlgo=1)
 * documents the "single composite ship hypothesis" framing; non-default
 * documents strict cross-test correction. Format preserves the values
 * inside the string so an operator + a hostile critic can reproduce the
 * MCC denominator from the JSONB output alone.
 *
 * Locked in B.2.26 test: format must include `n=<n>` and (if non-default)
 * `tests_per_algo=<k>` plus the multiplied total.
 */
export function buildBonferroniFamilyRationale(
  nCandidates: number,
  testsPerAlgo: number
): string {
  if (testsPerAlgo === 1) {
    return `n=${nCandidates} (one mean-R test per algo; step verdicts + pre-reg are a single composite ship hypothesis, not independent significance tests)`;
  }
  const effectiveNTests = nCandidates * testsPerAlgo;
  return `n=${nCandidates} × tests_per_algo=${testsPerAlgo} = ${effectiveNTests} (strict cross-test family-wise correction)`;
}

export interface PreregExpiryClassification {
  /** Algo-name + "(expired Xd ago)" strings — these have silently fallen
   *  back to legacy step verdicts. Re-register or remove. */
  expired: string[];
  /** Algo-name + "(expires in Xd)" strings — heads-up window. */
  expiringSoon: string[];
}

/**
 * Classify deployed-algo pre-registrations by expiry status. Returns
 * pre-formatted operator-facing strings ready for console output.
 *
 *  - Only algos in `deployedAlgoNames` are considered (orphan entries
 *    for retired algos are silently skipped — they're not actionable).
 *  - Malformed `expires_at` is silently skipped (loadPreregistrations
 *    handles loud errors at parse time; this layer just classifies
 *    valid entries).
 *  - `expiringSoon` = (0, warnDays) exclusive — same window as the
 *    standalone `validate-preregistration` script's default.
 *
 * Locked in B.2.27 test: deployed-only filter + warn-window partition +
 * orphan + malformed-date skip semantics.
 */
export function classifyPreregExpiry(
  preregs: Record<string, PreregisteredCriteria>,
  deployedAlgoNames: Set<string>,
  now: Date,
  warnDays: number
): PreregExpiryClassification {
  const expired: string[] = [];
  const expiringSoon: string[] = [];
  for (const [algoName, entry] of Object.entries(preregs)) {
    if (!deployedAlgoNames.has(algoName)) continue; // orphan — skip
    const expires = new Date(entry.expires_at);
    if (Number.isNaN(expires.getTime())) continue; // malformed — skip
    const daysToExpiry = (expires.getTime() - now.getTime()) / 86_400_000;
    if (daysToExpiry < 0) {
      expired.push(`${algoName} (expired ${Math.abs(Math.round(daysToExpiry))}d ago)`);
    } else if (daysToExpiry < warnDays) {
      expiringSoon.push(`${algoName} (expires in ${Math.round(daysToExpiry)}d)`);
    }
  }
  return { expired, expiringSoon };
}
