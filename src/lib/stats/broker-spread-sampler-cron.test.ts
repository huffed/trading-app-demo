/**
 * B.1.8 — CRON-readiness contract test for the broker spread sampler
 * cron wrapper (`scripts/broker-spread-sampler-cron.sh`).
 *
 * Mirrors the SG.9.1 + Stage 4.7.2 pattern. Locks the wrapper's
 * structural + behavioral preconditions without spawning the live
 * MetaApi call (which would burn rate-limit quota on every test run).
 *
 * Coverage (5 tests):
 *
 *  Structural:
 *   - Script exists at the expected path + is executable
 *   - Bash syntax is valid (no parse errors via `bash -n`)
 *
 *  Behavioral preconditions:
 *   - Wrapper references the canonical capture-broker-spread.ts path
 *   - Cron expression in README matches the wrapper's documented hourly pattern
 *   - JSONL output path documented in .gitignore (samples are append-only data, not source)
 */
import { execSync } from "child_process";
import { accessSync, constants, readFileSync, statSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

// __dirname = src/lib/stats — repo root is 3 levels up.
const REPO_ROOT = resolve(__dirname, "../../..");
const WRAPPER_PATH = resolve(REPO_ROOT, "scripts/broker-spread-sampler-cron.sh");
const CAPTURE_SCRIPT = resolve(REPO_ROOT, "scripts/canonical/capture-broker-spread.ts");
const README_PATH = resolve(REPO_ROOT, "scripts/README.md");
const GITIGNORE_PATH = resolve(REPO_ROOT, ".gitignore");

describe("broker-spread-sampler-cron.sh — B.1.8 CRON-readiness", () => {
  it("script exists at the expected path + is executable", () => {
    expect(statSync(WRAPPER_PATH).isFile()).toBe(true);
    accessSync(WRAPPER_PATH, constants.X_OK);
  });

  it("bash syntax is valid (no parse errors via `bash -n`)", () => {
    expect(() => execSync(`bash -n ${WRAPPER_PATH}`, { encoding: "utf-8" })).not.toThrow();
  });

  it("wrapper references the canonical capture-broker-spread.ts path + the script exists", () => {
    const src = readFileSync(WRAPPER_PATH, "utf-8");
    expect(src).toContain("scripts/canonical/capture-broker-spread.ts");
    expect(statSync(CAPTURE_SCRIPT).isFile()).toBe(true);
  });

  it("cron cadence in README matches the wrapper's documented hourly pattern", () => {
    const readme = readFileSync(README_PATH, "utf-8");
    const wrapperSrc = readFileSync(WRAPPER_PATH, "utf-8");
    // Both must reference the `0 * * * *` cron expression (hourly).
    expect(readme).toMatch(/0 \* \* \* \* .*broker-spread-sampler-cron\.sh/);
    expect(wrapperSrc).toMatch(/0 \* \* \* \*/);
  });

  it("JSONL output path documented in .gitignore (samples are append-only data, not source)", () => {
    const gitignore = readFileSync(GITIGNORE_PATH, "utf-8");
    expect(gitignore).toContain("scripts/broker-spread-samples.jsonl");
  });
});
