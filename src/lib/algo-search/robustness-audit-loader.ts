/**
 * F2 — Search-robustness audit loader. Pure-read of the persisted JSON
 * files written by the robustness-* drivers in scripts/canonical/.
 *
 * Server-only (fs.readFileSync). Called by the /reports Search tab
 * server action to surface F2 verdicts alongside Layer A/B state.
 *
 * Returns one RobustnessAudit per discoverable file. Files matching
 * `robustness-audit-*.json` (aggregate verdicts written by F2.5) are
 * primary; sub-gate files (multi-cut/leave-n-out/bootstrap-bars/alt-
 * objective) are returned as sub_gates within an audit and as orphan
 * entries when no aggregate has been generated yet.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, resolve as resolvePath } from "path";

export interface RobustnessSubGate {
  label: string;
  path: string;
  present: boolean;
  verdict: "PASS" | "FAIL" | "MISSING";
  /** Sub-gate's full result JSON (for tooltip/detail rendering). null when missing. */
  excerpt: Record<string, unknown> | null;
}

export interface RobustnessAudit {
  /** Filename without directory. e.g. "robustness-audit-33b705b9....json" */
  file: string;
  /** Mtime in ms (sort key — newest first). */
  mtime_ms: number;
  aggregate_verdict: "PASS" | "FAIL";
  candidate_id: string;
  candidate_name: string;
  gate_threshold: number;
  pass_count: number;
  fail_count: number;
  missing_count: number;
  audit_complete: boolean;
  sub_gates: RobustnessSubGate[];
  informational: {
    wf_vs_kfold: RobustnessSubGate | null;
  };
  next_action: string;
  generated_at: string;
}

const DEFAULT_CANONICAL_DIR = "scripts/canonical";
const AUDIT_FILENAME_RE = /^robustness-audit-.+\.json$/;

/** Resolve directory (process.env override → relative cwd). Existence
 *  check returns empty list rather than throwing — the FE tolerates
 *  "no audits yet" as a normal state. */
export function listRobustnessAudits(
  canonicalDir = process.env.ROBUSTNESS_AUDIT_DIR ?? DEFAULT_CANONICAL_DIR,
): RobustnessAudit[] {
  const dir = resolvePath(canonicalDir);
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir);
  const auditFiles = entries.filter((f) => AUDIT_FILENAME_RE.test(f));

  const audits: RobustnessAudit[] = [];
  for (const file of auditFiles) {
    const path = join(dir, file);
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as Partial<RobustnessAudit> & Record<string, unknown>;
      const mtime = statSync(path).mtimeMs;

      // Be lenient on shape — the aggregator output may evolve. Only require
      // aggregate_verdict + candidate_id; everything else gets defaults.
      const verdict = parsed.aggregate_verdict;
      if (verdict !== "PASS" && verdict !== "FAIL") continue;
      const candidateId = typeof parsed.candidate_id === "string" ? parsed.candidate_id : "";
      if (!candidateId) continue;

      audits.push({
        file,
        mtime_ms: mtime,
        aggregate_verdict: verdict,
        candidate_id: candidateId,
        candidate_name:
          typeof parsed.candidate_name === "string" ? parsed.candidate_name : candidateId,
        gate_threshold:
          typeof parsed.gate_threshold === "number" ? parsed.gate_threshold : 3,
        pass_count: typeof parsed.pass_count === "number" ? parsed.pass_count : 0,
        fail_count: typeof parsed.fail_count === "number" ? parsed.fail_count : 0,
        missing_count: typeof parsed.missing_count === "number" ? parsed.missing_count : 0,
        audit_complete: Boolean(parsed.audit_complete),
        sub_gates: Array.isArray(parsed.sub_gates)
          ? (parsed.sub_gates as RobustnessSubGate[])
          : [],
        informational:
          parsed.informational && typeof parsed.informational === "object"
            ? (parsed.informational as RobustnessAudit["informational"])
            : { wf_vs_kfold: null },
        next_action:
          typeof parsed.next_action === "string" ? parsed.next_action : "",
        generated_at:
          typeof parsed.generated_at === "string"
            ? parsed.generated_at
            : new Date(mtime).toISOString(),
      });
    } catch {
      // Skip malformed files silently — operator sees "0 audits" rather than
      // a broken FE for a single bad JSON.
      continue;
    }
  }

  // Newest first; ties broken by candidate_id for stability.
  audits.sort((a, b) => {
    if (b.mtime_ms !== a.mtime_ms) return b.mtime_ms - a.mtime_ms;
    return a.candidate_id.localeCompare(b.candidate_id);
  });

  return audits;
}
