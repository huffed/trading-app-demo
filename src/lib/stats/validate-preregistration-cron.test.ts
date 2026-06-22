/**
 * SG.3 — CRON-readiness contract test for `validate-preregistration.ts`.
 *
 * The pre-reg expiration sweep cron (`scripts/prereg-expiration-cron.sh`)
 * relies on the validator's exit-code contract:
 *
 *   0 — all entries ACTIVE or EXPIRING SOON (warning-only)
 *   1 — JSON syntax / Zod schema failure (bad config)
 *   2 — STRICT_EXPIRED=1 + at least one EXPIRED entry (re-register or remove)
 *
 * Locking this contract because: cron flags any non-zero exit on the
 * operator's daily log review. A regression that changes 2 → 0 on
 * EXPIRED entries silently disables the actionable workflow that
 * closes SG.3.
 *
 * Coverage (4 tests):
 *   - STRICT_EXPIRED=1 + expired entry → exit 2 (cron-actionable path)
 *   - STRICT_EXPIRED unset + expired entry → exit 0 (warning-only path)
 *   - All-active entries → exit 0 regardless of STRICT_EXPIRED
 *   - JSON syntax error → exit 1 (bad config path)
 *
 * Uses `execSync` to spawn the actual script. Each spawn is ~3-4s of
 * tsx import overhead, so the test file adds ~12-16s to the suite.
 * Acceptable: this is the only end-to-end script-level test, and the
 * contract it locks is operationally load-bearing for SG.3.
 */
import { execSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { describe, expect, it } from "vitest";

// __dirname = src/lib/stats — repo root is 3 levels up.
const REPO_ROOT = resolve(__dirname, "../../..");
const SCRIPT_PATH = "scripts/canonical/validate-preregistration.ts";

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runScript(jsonContent: string, env: Record<string, string> = {}): SpawnResult {
  // Temp file per invocation so concurrent test runs don't collide.
  const tmpDir = mkdtempSync(join(tmpdir(), "prereg-cron-"));
  const jsonPath = join(tmpDir, "p.json");
  writeFileSync(jsonPath, jsonContent);
  try {
    const envPrefix = Object.entries({ PREREG_PATH: jsonPath, ...env })
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    const stdout = execSync(`${envPrefix} pnpm dlx tsx ${SCRIPT_PATH} 2>&1`, {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      exitCode: err.status ?? 1,
      stdout: typeof err.stdout === "string" ? err.stdout : err.stdout?.toString() ?? "",
      stderr: typeof err.stderr === "string" ? err.stderr : err.stderr?.toString() ?? "",
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Test data — all use post-hoc-locked + minimal criteria to focus on
// the expiry-classification path (lib tests cover criteria semantics).
const expiredEntry = JSON.stringify({
  "test-algo": {
    hypothesis: "expired test fixture",
    registered_at: "2025-01-01T00:00:00Z",
    expires_at: "2025-06-01T00:00:00Z", // past
    registration_type: "post-hoc-locked",
    min_total_return: 0,
  },
});

const activeEntry = JSON.stringify({
  "test-algo": {
    hypothesis: "active test fixture",
    registered_at: "2026-06-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z", // far future
    registration_type: "post-hoc-locked",
    min_total_return: 0,
  },
});

const malformedJson = "{ this is not valid JSON";

describe("validate-preregistration script — CRON-readiness contract (SG.3)", () => {
  // execSync spawns are slow; allow generous timeout per test.
  const SPAWN_TIMEOUT_MS = 30_000;

  it(
    "STRICT_EXPIRED=1 + expired entry → exit 2 (cron-actionable path)",
    () => {
      const r = runScript(expiredEntry, { STRICT_EXPIRED: "1" });
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toContain("EXPIRED");
      expect(r.stdout).toContain("STRICT_EXPIRED=1");
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    "STRICT_EXPIRED unset + expired entry → exit 0 (warning-only)",
    () => {
      const r = runScript(expiredEntry); // no STRICT_EXPIRED
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("EXPIRED");
      expect(r.stdout).toContain("STRICT_EXPIRED off");
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    "all-ACTIVE entries → exit 0 regardless of STRICT_EXPIRED",
    () => {
      const r = runScript(activeEntry, { STRICT_EXPIRED: "1" });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("ACTIVE");
      expect(r.stdout).toContain("Result: OK");
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    "JSON syntax error → exit 1 (bad config path; cron flags as urgent)",
    () => {
      const r = runScript(malformedJson, { STRICT_EXPIRED: "1" });
      expect(r.exitCode).toBe(1);
      // The script's loadPreregistrations throws with "invalid JSON" detail
      expect(r.stdout + r.stderr).toMatch(/invalid JSON|Fatal/);
    },
    SPAWN_TIMEOUT_MS
  );
});
