import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { listRobustnessAudits } from "./robustness-audit-loader";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "robustness-audit-test-"));
}

function writeAuditFile(dir: string, filename: string, payload: object): void {
  writeFileSync(join(dir, filename), JSON.stringify(payload, null, 2));
}

const validAudit = {
  aggregate_verdict: "PASS" as const,
  candidate_id: "abc-1234",
  candidate_name: "LayerB: XAU/USD Engulfing-Long 4h | rr3_lb6_r06_rf0_af0",
  gate_threshold: 3,
  pass_count: 4,
  fail_count: 0,
  missing_count: 0,
  audit_complete: true,
  sub_gates: [
    { label: "F2.1 multi-cut", path: "x", present: true, verdict: "PASS" as const, excerpt: {} },
  ],
  informational: { wf_vs_kfold: null },
  next_action: "Operator re-stamps G.6",
  generated_at: "2026-06-24T11:00:00Z",
};

describe("listRobustnessAudits", () => {
  it("returns empty list for non-existent dir", () => {
    const result = listRobustnessAudits("/path/definitely/does/not/exist/xyz");
    expect(result).toEqual([]);
  });

  it("returns empty list for empty dir", () => {
    const dir = makeTempDir();
    try {
      expect(listRobustnessAudits(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads valid audit file", () => {
    const dir = makeTempDir();
    try {
      writeAuditFile(dir, "robustness-audit-abc.json", validAudit);
      const result = listRobustnessAudits(dir);
      expect(result).toHaveLength(1);
      expect(result[0].candidate_id).toBe("abc-1234");
      expect(result[0].aggregate_verdict).toBe("PASS");
      expect(result[0].sub_gates).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores files not matching robustness-audit-*.json", () => {
    const dir = makeTempDir();
    try {
      writeAuditFile(dir, "not-an-audit.json", validAudit);
      writeAuditFile(dir, "robustness-other-results.json", validAudit);
      expect(listRobustnessAudits(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips files missing aggregate_verdict", () => {
    const dir = makeTempDir();
    try {
      const { aggregate_verdict: _ignored, ...rest } = validAudit;
      writeAuditFile(dir, "robustness-audit-bad.json", rest);
      expect(listRobustnessAudits(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips files missing candidate_id", () => {
    const dir = makeTempDir();
    try {
      const { candidate_id: _ignored, ...rest } = validAudit;
      writeAuditFile(dir, "robustness-audit-bad.json", rest);
      expect(listRobustnessAudits(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips malformed JSON without throwing", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "robustness-audit-broken.json"), "{ not valid json");
      writeAuditFile(dir, "robustness-audit-ok.json", validAudit);
      const result = listRobustnessAudits(dir);
      expect(result).toHaveLength(1);
      expect(result[0].candidate_id).toBe("abc-1234");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns multiple audits sorted by mtime descending", () => {
    const dir = makeTempDir();
    try {
      writeAuditFile(dir, "robustness-audit-old.json", { ...validAudit, candidate_id: "old-1" });
      // Brief delay so mtimes differ deterministically (10ms suffices on every fs we ship on).
      const start = Date.now();
      while (Date.now() - start < 15) { /* tight spin */ }
      writeAuditFile(dir, "robustness-audit-new.json", { ...validAudit, candidate_id: "new-1" });
      const result = listRobustnessAudits(dir);
      expect(result).toHaveLength(2);
      expect(result[0].candidate_id).toBe("new-1");
      expect(result[1].candidate_id).toBe("old-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves FAIL verdicts (not silently dropped)", () => {
    const dir = makeTempDir();
    try {
      writeAuditFile(dir, "robustness-audit-fail.json", { ...validAudit, aggregate_verdict: "FAIL" });
      const result = listRobustnessAudits(dir);
      expect(result).toHaveLength(1);
      expect(result[0].aggregate_verdict).toBe("FAIL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
