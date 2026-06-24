/**
 * F2.5 — Aggregate verdict + persistence for the F2 search-robustness audit.
 *
 * Reads the 4 sub-gate result files (F2.1-F2.4) and produces a single
 * aggregate verdict + summary file for a given candidate. The aggregate
 * gate is pre-registered: candidate passes F2 iff ≥3/4 sub-gates PASS.
 *
 * Missing sub-gate files → that sub-gate counts as FAIL (conservative;
 * audit must be COMPLETE to claim aggregate PASS). The verdict file
 * records WHICH sub-gates were missing so the operator can see whether
 * the FAIL is signal or incomplete audit.
 *
 * Output: scripts/canonical/robustness-audit-<survivor-id>.json
 *   (id derived from algorithm row OR from --id env var; default is
 *    the v3 survivor's algorithm_id 33b705b9-...)
 *
 * Wall clock: <1s.
 *
 * Usage:
 *   pnpm dlx tsx scripts/canonical/robustness-aggregate.ts
 *
 * Env:
 *   CANDIDATE_ID      default "33b705b9-7442-4c73-8d97-4a88ecacb9a1" (v3 survivor)
 *   CANDIDATE_NAME    default "LayerB: XAU/USD Engulfing-Long 4h | rr3_lb6_r06_rf0_af0"
 *   GATE_THRESHOLD    default 3 (≥3/4 sub-gates pass → aggregate PASS)
 *   MULTI_CUT_JSON    default scripts/canonical/robustness-multi-cut-results.json
 *   LEAVE_N_OUT_JSON  default scripts/canonical/robustness-leave-n-out-results.json
 *   BOOTSTRAP_JSON    default scripts/canonical/robustness-bootstrap-bars-results.json
 *   ALT_OBJ_JSON      default scripts/canonical/robustness-alt-objective-results.json
 *   WF_KFOLD_JSON     default scripts/canonical/wf-vs-kfold-equivalence-results.json  (informational; not in F2 gate)
 *   OUTPUT_JSON       default scripts/canonical/robustness-audit-<CANDIDATE_ID>.json
 *   PERSIST           default 1
 */
import { existsSync, readFileSync, writeFileSync } from "fs";

// .env.local loader
{
  try {
    const raw = readFileSync(".env.local", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.replace(/^['"]|['"]$/g, "");
    }
  } catch {}
}

const CANDIDATE_ID = process.env.CANDIDATE_ID ?? "33b705b9-7442-4c73-8d97-4a88ecacb9a1";
const CANDIDATE_NAME =
  process.env.CANDIDATE_NAME ?? "LayerB: XAU/USD Engulfing-Long 4h | rr3_lb6_r06_rf0_af0";
const GATE_THRESHOLD = Math.max(1, Number(process.env.GATE_THRESHOLD ?? 3));
const MULTI_CUT_JSON =
  process.env.MULTI_CUT_JSON ?? "scripts/canonical/robustness-multi-cut-results.json";
const LEAVE_N_OUT_JSON =
  process.env.LEAVE_N_OUT_JSON ?? "scripts/canonical/robustness-leave-n-out-results.json";
const BOOTSTRAP_JSON =
  process.env.BOOTSTRAP_JSON ?? "scripts/canonical/robustness-bootstrap-bars-results.json";
const ALT_OBJ_JSON =
  process.env.ALT_OBJ_JSON ?? "scripts/canonical/robustness-alt-objective-results.json";
const WF_KFOLD_JSON =
  process.env.WF_KFOLD_JSON ?? "scripts/canonical/wf-vs-kfold-equivalence-results.json";
const OUTPUT_JSON =
  process.env.OUTPUT_JSON ?? `scripts/canonical/robustness-audit-${CANDIDATE_ID}.json`;
const PERSIST = process.env.PERSIST !== "0";

interface SubGateResult {
  sub_gate: string;
  verdict: "PASS" | "FAIL";
  [key: string]: unknown;
}

function readSubGate(path: string): SubGateResult | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as SubGateResult;
    if (parsed.verdict !== "PASS" && parsed.verdict !== "FAIL") {
      console.warn(`[aggregate] ${path}: missing/invalid 'verdict' field; treating as FAIL`);
      return { ...parsed, verdict: "FAIL" };
    }
    return parsed;
  } catch (err) {
    console.warn(`[aggregate] failed to read ${path}: ${(err as Error).message}; treating as missing`);
    return null;
  }
}

interface SubGateSummary {
  label: string;
  path: string;
  present: boolean;
  verdict: "PASS" | "FAIL" | "MISSING";
  excerpt: Record<string, unknown> | null;
}

function summarise(label: string, path: string, result: SubGateResult | null): SubGateSummary {
  if (result === null) {
    return { label, path, present: false, verdict: "MISSING", excerpt: null };
  }
  // Strip large array fields for the excerpt — keep verdict + scalar/short fields only.
  const excerpt: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result)) {
    if (Array.isArray(v) && v.length > 5) {
      excerpt[k] = `<array length ${v.length}>`;
    } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      // One-level deep flatten
      const subExcerpt: Record<string, unknown> = {};
      for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) {
        if (Array.isArray(vv) && vv.length > 5) {
          subExcerpt[kk] = `<array length ${vv.length}>`;
        } else {
          subExcerpt[kk] = vv;
        }
      }
      excerpt[k] = subExcerpt;
    } else {
      excerpt[k] = v;
    }
  }
  return {
    label,
    path,
    present: true,
    verdict: result.verdict,
    excerpt,
  };
}

function main(): void {
  console.log(`F2.5 aggregate verdict for ${CANDIDATE_NAME}`);
  console.log(`  candidate id : ${CANDIDATE_ID}`);
  console.log(`  gate threshold : ≥${GATE_THRESHOLD}/4 sub-gates PASS`);
  console.log("");

  const multiCut = readSubGate(MULTI_CUT_JSON);
  const leaveNOut = readSubGate(LEAVE_N_OUT_JSON);
  const bootstrap = readSubGate(BOOTSTRAP_JSON);
  const altObj = readSubGate(ALT_OBJ_JSON);
  const wfKfold = readSubGate(WF_KFOLD_JSON);

  const subGates = [
    summarise("F2.1 multi-cut-oos", MULTI_CUT_JSON, multiCut),
    summarise("F2.2 leave-n-out", LEAVE_N_OUT_JSON, leaveNOut),
    summarise("F2.3 bootstrap-bars", BOOTSTRAP_JSON, bootstrap),
    summarise("F2.4 alt-objective", ALT_OBJ_JSON, altObj),
  ];
  const wfKfoldSummary = summarise("F.6a wf-vs-kfold (info)", WF_KFOLD_JSON, wfKfold);

  const passCount = subGates.filter((g) => g.verdict === "PASS").length;
  const missingCount = subGates.filter((g) => g.verdict === "MISSING").length;
  const failCount = subGates.filter((g) => g.verdict === "FAIL").length;

  const aggregateVerdict: "PASS" | "FAIL" = passCount >= GATE_THRESHOLD ? "PASS" : "FAIL";

  console.log("Sub-gate verdicts:");
  for (const g of subGates) {
    const marker = g.verdict === "PASS" ? "✓" : g.verdict === "FAIL" ? "✗" : "?";
    console.log(`  ${marker} ${g.label.padEnd(28)} ${g.verdict.padEnd(8)} ${g.present ? "" : "(file missing)"}`);
  }
  console.log("");
  console.log(`F.6a (informational, not in F2 gate):`);
  console.log(`  ${wfKfoldSummary.verdict === "PASS" ? "✓" : wfKfoldSummary.verdict === "FAIL" ? "✗" : "?"} ${wfKfoldSummary.label.padEnd(28)} ${wfKfoldSummary.verdict.padEnd(8)} ${wfKfoldSummary.present ? "" : "(file missing)"}`);
  console.log("");
  console.log(`F2 AGGREGATE VERDICT: ${aggregateVerdict}`);
  console.log(`  PASS count : ${passCount}/4`);
  console.log(`  FAIL count : ${failCount}/4`);
  console.log(`  MISSING count : ${missingCount}/4`);
  if (missingCount > 0) {
    console.log(`  ⚠ ${missingCount} sub-gate(s) missing → audit INCOMPLETE; verdict counts missing as fail`);
  }

  const output = {
    aggregate_verdict: aggregateVerdict,
    candidate_id: CANDIDATE_ID,
    candidate_name: CANDIDATE_NAME,
    gate_threshold: GATE_THRESHOLD,
    pass_count: passCount,
    fail_count: failCount,
    missing_count: missingCount,
    audit_complete: missingCount === 0,
    sub_gates: subGates,
    informational: {
      wf_vs_kfold: wfKfoldSummary,
    },
    next_action:
      aggregateVerdict === "PASS"
        ? "Operator re-stamps G.6 packet §6 Decision 1 = A; un-pause SQL fires"
        : "Operator decides: archive candidate (status='archived') then H.4a label re-engineering; OR keep-as-draft + re-run search after H.4a",
    generated_at: new Date().toISOString(),
  };

  if (PERSIST) {
    writeFileSync(OUTPUT_JSON, JSON.stringify(output, null, 2));
    console.log("");
    console.log(`Persisted ${OUTPUT_JSON}`);
  } else {
    console.log("");
    console.log("(PERSIST=0 — verdict only, no file written)");
  }
}

main();
