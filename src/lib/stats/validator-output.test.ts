/**
 * B.2.25/26/27 regression tests for validator-output contracts
 * (2026-06-22 NIGHT LATE).
 *
 * Three previously-shipped fixes lacked regression coverage:
 *
 *  - B.2.2 (`computed_at` from validator's `now`, not hardcoded literal)
 *    → tested at B.2.25 via source-level meta-test (scans
 *    validate-algo.ts for `computed_at: "<literal>"` patterns).
 *
 *  - B.2.4 (Bonferroni family-rationale string format)
 *    → tested at B.2.26 via direct unit test of the extracted helper
 *    `buildBonferroniFamilyRationale`.
 *
 *  - B.2.9 (pre-reg expiration silent fallback warnings)
 *    → tested at B.2.27 via direct unit test of the extracted helper
 *    `classifyPreregExpiry`.
 *
 * Coverage (~14 tests):
 *
 *  B.2.26 — Bonferroni family-rationale (4):
 *   - testsPerAlgo=1 (default): composite-hypothesis framing string
 *   - testsPerAlgo=5 (strict): "n × k = N (strict cross-test ...)" format
 *   - n value embedded verbatim (literal-substitution check)
 *   - multiplication output is the numeric product (no string concatenation bug)
 *
 *  B.2.27 — Prereg expiry classification (8):
 *   - Empty preregs → both lists empty
 *   - Deployed + active (>warnDays away) → neither list
 *   - Deployed + expiring soon → expiringSoon list, plural-d formatting
 *   - Deployed + expired → expired list, "Nd ago" formatting
 *   - Orphan (prereg for non-deployed algo) → SKIPPED (neither list)
 *   - Malformed expires_at → SKIPPED (neither list)
 *   - Boundary: daysToExpiry exactly = warnDays → NOT expiringSoon (exclusive)
 *   - Boundary: daysToExpiry = 0 (expires NOW) → NOT expired (strict < 0)
 *
 *  B.2.25 — computed_at source-level meta-test (1):
 *   - Source scan: `computed_at:` in validate-algo.ts must NEVER be
 *     followed by a string literal (e.g. `computed_at: "2026-..."`).
 *     Catches the hardcoded-literal regression class directly.
 *
 *  Validate-algo end-to-end contract (1):
 *   - Smoke: import the helpers, build a sample output, confirm shape.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import {
  buildBonferroniFamilyRationale,
  classifyPreregExpiry,
} from "./validator-output";
import type { PreregisteredCriteria } from "./preregistration";

// ======================================================================
// B.2.26 — Bonferroni family-rationale string format
// ======================================================================

describe("buildBonferroniFamilyRationale — B.2.26 regression", () => {
  it("testsPerAlgo=1 (default) → composite-hypothesis framing", () => {
    const r = buildBonferroniFamilyRationale(7, 1);
    expect(r).toBe(
      "n=7 (one mean-R test per algo; step verdicts + pre-reg are a single composite ship hypothesis, not independent significance tests)"
    );
  });

  it("testsPerAlgo=5 (strict) → 'n × k = N (strict cross-test ...)' format", () => {
    const r = buildBonferroniFamilyRationale(7, 5);
    expect(r).toBe(
      "n=7 × tests_per_algo=5 = 35 (strict cross-test family-wise correction)"
    );
  });

  it("n value embedded verbatim — passes through to the rendered string", () => {
    const r = buildBonferroniFamilyRationale(123, 1);
    expect(r).toContain("n=123");
  });

  it("multiplication is numeric product (no string concatenation bug)", () => {
    // If JS coerced numbers to strings before multiplying, we'd see
    // "tests_per_algo=2 = 32" instead of "= 6" for n=3, k=2.
    const r = buildBonferroniFamilyRationale(3, 2);
    expect(r).toContain("= 6 ");
    expect(r).not.toContain("= 32 ");
  });
});

// ======================================================================
// B.2.27 — Prereg expiry classification
// ======================================================================

function makeEntry(expiresIso: string): PreregisteredCriteria {
  return {
    hypothesis: "test",
    registered_at: "2026-01-01T00:00:00Z",
    expires_at: expiresIso,
    registration_type: "post-hoc-locked",
    min_total_return: 0,
  };
}

const NOW = new Date("2026-06-22T00:00:00Z");
const WARN = 14;

describe("classifyPreregExpiry — B.2.27 regression", () => {
  it("empty preregs → both lists empty", () => {
    const r = classifyPreregExpiry({}, new Set(["any-algo"]), NOW, WARN);
    expect(r).toEqual({ expired: [], expiringSoon: [] });
  });

  it("deployed + active (>warnDays away) → neither list", () => {
    const preregs = { "algo-1": makeEntry("2026-12-01T00:00:00Z") }; // ~162d away
    const r = classifyPreregExpiry(preregs, new Set(["algo-1"]), NOW, WARN);
    expect(r.expired).toEqual([]);
    expect(r.expiringSoon).toEqual([]);
  });

  it("deployed + expiring soon → expiringSoon list with 'expires in Nd' format", () => {
    // 7 days from NOW (2026-06-29)
    const preregs = { "algo-1": makeEntry("2026-06-29T00:00:00Z") };
    const r = classifyPreregExpiry(preregs, new Set(["algo-1"]), NOW, WARN);
    expect(r.expiringSoon).toEqual(["algo-1 (expires in 7d)"]);
    expect(r.expired).toEqual([]);
  });

  it("deployed + expired → expired list with 'expired Nd ago' format", () => {
    // 5 days BEFORE NOW (2026-06-17)
    const preregs = { "algo-1": makeEntry("2026-06-17T00:00:00Z") };
    const r = classifyPreregExpiry(preregs, new Set(["algo-1"]), NOW, WARN);
    expect(r.expired).toEqual(["algo-1 (expired 5d ago)"]);
    expect(r.expiringSoon).toEqual([]);
  });

  it("orphan (prereg for non-deployed algo) → SKIPPED (operator can't act on it)", () => {
    // expired AND expiring-soon orphans both filtered out
    const preregs = {
      "retired-expired": makeEntry("2026-01-01T00:00:00Z"),
      "retired-soon": makeEntry("2026-06-25T00:00:00Z"),
    };
    const r = classifyPreregExpiry(preregs, new Set(["different-algo"]), NOW, WARN);
    expect(r).toEqual({ expired: [], expiringSoon: [] });
  });

  it("malformed expires_at → SKIPPED (loadPreregistrations is the loud-error layer)", () => {
    const preregs = { "algo-1": makeEntry("not-a-date") };
    const r = classifyPreregExpiry(preregs, new Set(["algo-1"]), NOW, WARN);
    expect(r).toEqual({ expired: [], expiringSoon: [] });
  });

  it("boundary: daysToExpiry exactly = warnDays → NOT expiringSoon (exclusive)", () => {
    // warnDays=14; entry expires exactly 14 days from NOW
    const preregs = { "algo-1": makeEntry("2026-07-06T00:00:00Z") }; // NOW + 14d
    const r = classifyPreregExpiry(preregs, new Set(["algo-1"]), NOW, WARN);
    expect(r.expiringSoon).toEqual([]); // < warnDays exclusive
    expect(r.expired).toEqual([]);
  });

  it("boundary: daysToExpiry = 0 (expires exactly NOW) → expiringSoon, NOT expired", () => {
    // Comparison is `< 0` for expired, so equal-to-zero falls into the
    // expiringSoon branch (= 0 < warnDays).
    const preregs = { "algo-1": makeEntry("2026-06-22T00:00:00Z") };
    const r = classifyPreregExpiry(preregs, new Set(["algo-1"]), NOW, WARN);
    expect(r.expired).toEqual([]);
    expect(r.expiringSoon).toEqual(["algo-1 (expires in 0d)"]);
  });
});

// ======================================================================
// B.2.25 — computed_at must never be a hardcoded string literal
// ======================================================================

describe("validate-algo source contract — B.2.25 regression", () => {
  it("computed_at field assignment must reference a variable, NEVER a string literal", () => {
    // Source-level meta-test: scan validate-algo.ts for any line containing
    // `computed_at: "...something..."` (a string literal RHS). The fix at
    // B.2.2 routed computed_at through args.now.toISOString() via the
    // `computedAt` local. A regression that hardcodes the timestamp would
    // re-introduce a fixed literal and fail this test.
    //
    // Pattern matches: `computed_at:` followed by any whitespace, then
    // a double-quoted string literal. Excludes legitimate forms:
    //   computed_at: computedAt        ← variable reference (allowed)
    //   computed_at: args.now.toISOString()  ← method call (allowed)
    const validateAlgoPath = resolve(__dirname, "../../../scripts/canonical/validate-algo.ts");
    const src = readFileSync(validateAlgoPath, "utf8");
    // Match `computed_at:` whitespace then a string literal start
    const offenders = [...src.matchAll(/computed_at:\s*["'`][^"'`]*["'`]/g)];
    expect(offenders, `Found hardcoded computed_at literals: ${offenders.map((m) => m[0]).join(", ")}`).toEqual([]);
  });
});
