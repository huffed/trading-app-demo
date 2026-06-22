/**
 * Stage 4.7.2 — CRON-readiness contract test for the monthly validate-algo
 * cron wrapper (`scripts/validate-algo-monthly-cron.sh`).
 *
 * The wrapper is operationally load-bearing for the B.6 continuous-
 * validation cadence: it's the monthly tick that catches engine
 * regressions + slides the rolling 12-month OOS holdout forward.
 *
 * Locked contracts (5 tests):
 *
 *  Structural:
 *   - Script exists at the expected path + is executable
 *   - Bash syntax is valid (no parse errors via `bash -n`)
 *
 *  Behavioral preconditions:
 *   - OOS_CUTOFF derivation works on the current host (BSD `date -v-12m`
 *     or GNU `date -d "12 months ago"`) and produces a YYYY-MM-DD format
 *   - Script's documented exit codes match the validate-algo.ts contract
 *   - Wrapper references the CORRECT validate-algo.ts script path (no
 *     drift if the canonical validator moves)
 *
 * The full PERSIST=1 fleet run is NOT exercised by this test — that
 * would take ~minutes and write to production Supabase. The contract
 * tested here is "the wrapper's prelude is correct"; the underlying
 * validate-algo.ts behavior is tested by its own unit + integration
 * tests (B.2.25/26/27 + portfolio-backtest-*).
 */
import { execSync } from "child_process";
import { accessSync, constants, readFileSync, statSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

// __dirname = src/lib/stats — repo root is 3 levels up.
const REPO_ROOT = resolve(__dirname, "../../..");
const WRAPPER_PATH = resolve(REPO_ROOT, "scripts/validate-algo-monthly-cron.sh");
const VALIDATE_ALGO_PATH = resolve(REPO_ROOT, "scripts/canonical/validate-algo.ts");

describe("validate-algo-monthly-cron.sh — Stage 4.7.2 CRON-readiness", () => {
  it("script exists at the expected path + is executable", () => {
    const stat = statSync(WRAPPER_PATH);
    expect(stat.isFile()).toBe(true);
    // Executable bit set (owner X = 0o100). On macOS the wrapper was
    // chmod +x'd at creation; the test guards against a future PR
    // dropping the bit (which would silently break cron invocation).
    accessSync(WRAPPER_PATH, constants.X_OK);
  });

  it("bash syntax is valid (no parse errors via `bash -n`)", () => {
    // bash -n parses the file without executing — catches typos in
    // control flow that would otherwise only surface at cron-fire time
    // (when the operator's not watching the console).
    expect(() => execSync(`bash -n ${WRAPPER_PATH}`, { encoding: "utf-8" })).not.toThrow();
  });

  it("OOS_CUTOFF derivation works on the current host (BSD or GNU date arithmetic)", () => {
    // Mirrors the wrapper's `date -u -v-12m +%Y-%m-%d || date -u -d "12 months ago" +%Y-%m-%d`.
    // Whichever branch succeeds, the output must match YYYY-MM-DD.
    const output = execSync(
      `date -u -v-12m +%Y-%m-%d 2>/dev/null || date -u -d '12 months ago' +%Y-%m-%d 2>/dev/null`,
      { encoding: "utf-8" }
    ).trim();
    expect(output).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("wrapper references the canonical validate-algo.ts path (no drift if validator moves)", () => {
    // Source-level meta-test: the wrapper must invoke
    // `scripts/canonical/validate-algo.ts` (not a stale copy). If a
    // future refactor moves the canonical script, the wrapper updates
    // here AND the canonical path test below.
    const src = readFileSync(WRAPPER_PATH, "utf-8");
    expect(src).toContain("scripts/canonical/validate-algo.ts");
    // Also verify the canonical script actually exists at that path
    expect(statSync(VALIDATE_ALGO_PATH).isFile()).toBe(true);
  });

  it("wrapper documents exit codes matching validate-algo.ts contract", () => {
    // The wrapper's header documents:
    //   0 — fleet run completed
    //   non-zero — validate-algo threw mid-run
    // Plus the script EXITS with validate-algo's RC on failure (no swallowing).
    // Source contains: `exit $RC` (preserves the inner script's exit code).
    const src = readFileSync(WRAPPER_PATH, "utf-8");
    expect(src).toContain("exit $RC");
    // And the success path emits the "rc=0" log line for operator review
    expect(src).toMatch(/rc=0/);
  });
});
