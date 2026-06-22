/**
 * SG.9.1 — CRON-readiness contract test for the broker health snapshot
 * cron wrapper (`scripts/broker-health-snapshot-cron.sh`).
 *
 * The wrapper drives `snapshot-broker-health.ts` which writes back to
 * `broker_connections.last_synced_at`/`account_snapshot`/`last_error`.
 * The /reports Brokers tab reads from those fields, so a regression
 * here silently breaks SG.9's observability surface.
 *
 * Locked contracts (5 tests):
 *
 *  Structural:
 *   - Script exists at the expected path + is executable
 *   - Bash syntax is valid (no parse errors via `bash -n`)
 *
 *  Behavioral preconditions:
 *   - Wrapper references the canonical script path (no drift on rename)
 *   - Wrapper exits non-zero ONLY on catastrophic failure (per-connection
 *     failures are data, not script failures) — documented via exit-code
 *     semantics in the header
 *   - Cron expression in README matches the script's documented cadence
 *
 * The full live-broker call isn't exercised here — that would require
 * real MetaApi creds + would burn rate-limit budget every test run.
 * The TS script's behavior is tested at integration-time when the
 * operator runs the wrapper manually.
 */
import { execSync } from "child_process";
import { accessSync, constants, readFileSync, statSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

// __dirname = src/lib/stats — repo root is 3 levels up.
const REPO_ROOT = resolve(__dirname, "../../..");
const WRAPPER_PATH = resolve(REPO_ROOT, "scripts/broker-health-snapshot-cron.sh");
const SNAPSHOT_SCRIPT = resolve(REPO_ROOT, "scripts/canonical/snapshot-broker-health.ts");
const README_PATH = resolve(REPO_ROOT, "scripts/README.md");

describe("broker-health-snapshot-cron.sh — SG.9.1 CRON-readiness", () => {
  it("script exists at the expected path + is executable", () => {
    expect(statSync(WRAPPER_PATH).isFile()).toBe(true);
    accessSync(WRAPPER_PATH, constants.X_OK);
  });

  it("bash syntax is valid (no parse errors via `bash -n`)", () => {
    expect(() => execSync(`bash -n ${WRAPPER_PATH}`, { encoding: "utf-8" })).not.toThrow();
  });

  it("wrapper references the canonical snapshot-broker-health.ts path + the script exists", () => {
    const src = readFileSync(WRAPPER_PATH, "utf-8");
    expect(src).toContain("scripts/canonical/snapshot-broker-health.ts");
    expect(statSync(SNAPSHOT_SCRIPT).isFile()).toBe(true);
  });

  it("wrapper exit-code semantics documented (per-connection failures ≠ script failure)", () => {
    const src = readFileSync(WRAPPER_PATH, "utf-8");
    // The header must explicitly document that per-connection failures
    // are first-class data, not script failures. Catches a regression
    // that re-introduces "fail loudly on any per-connection error" —
    // would break the observability contract (operator's Brokers tab
    // would lose its alert data when ANY broker is down).
    expect(src).toMatch(/first-class data|FIRST-CLASS DATA/);
    // Exit-code propagation preserved via `exit $RC` on catastrophic
    expect(src).toContain("exit $RC");
  });

  it("cron cadence in README matches the wrapper's documented every-6h pattern", () => {
    const readme = readFileSync(README_PATH, "utf-8");
    const wrapperSrc = readFileSync(WRAPPER_PATH, "utf-8");
    // Both must reference the `0 */6 * * *` cron expression
    expect(readme).toMatch(/0 \*\/6 \* \* \* .*broker-health-snapshot-cron\.sh/);
    expect(wrapperSrc).toMatch(/0 \*\/6 \* \* \*/);
  });
});
