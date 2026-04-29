/**
 * Smoke test for the multi-TF confluence templates added to the search
 * grid. Enumerates all candidates the grid produces, filters to the new
 * `multi_tf_*` templates, and validates each rule object against the
 * production `algorithmRulesSchema`.
 *
 * This catches the realistic bug class for this PR: a template builder
 * emits a rule object that fails Zod validation downstream when the
 * search engine tries to persist it. Walk-forward validation requires
 * fresh price data and is gated by the Twelve Data daily credit cap;
 * schema validation is offline and confirms the templates are
 * structurally sound.
 *
 * Run: npx tsx scripts/smoke-multi-tf-templates.ts
 */
import { enumerateCandidates } from "../src/lib/algorithm/combinatorial-search/grid";
import { algorithmRulesSchema } from "../src/lib/validators/algorithm";

function main() {
  const candidates = enumerateCandidates({ capital: 20_000, monthly_target_pct: 10 });
  const multiTf = candidates.filter((c) => c.template_name.startsWith("multi_tf_"));

  console.log(`Total candidates enumerated     : ${candidates.length}`);
  console.log(`Multi-TF candidates             : ${multiTf.length}\n`);

  if (multiTf.length === 0) {
    console.error("FAIL: no multi_tf_* candidates surfaced from the grid.");
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;
  console.log("label                                       tfs                   logic    n");
  console.log("------------------------------------------------------------------------------");
  for (const c of multiTf) {
    const tfs = Array.from(
      new Set(
        c.rules.entry_conditions
          .map((cond) => ("timeframe" in cond ? cond.timeframe : null))
          .filter((t): t is string => t !== null)
      )
    ).join(",");
    const logic = c.rules.entry_logic;
    const logicStr =
      typeof logic === "object" && logic !== null && "type" in logic
        ? `${logic.type}`
        : String(logic ?? "all");
    const n =
      typeof logic === "object" && logic !== null && "type" in logic && logic.type === "n_of_m"
        ? logic.n
        : "-";

    const parsed = algorithmRulesSchema.safeParse(c.rules);
    if (parsed.success) {
      passed++;
      console.log(
        `${c.label.padEnd(43)}  ${tfs.padEnd(20)}  ${logicStr.padEnd(7)}  ${n}  ✓`
      );
    } else {
      failed++;
      console.log(
        `${c.label.padEnd(43)}  ${tfs.padEnd(20)}  ${logicStr.padEnd(7)}  ${n}  ✗`
      );
      const issues = parsed.error.issues.slice(0, 3);
      for (const issue of issues) {
        console.log(`    └─ ${issue.path.join(".")}: ${issue.message}`);
      }
    }
  }

  console.log();
  console.log(`Schema validation: ${passed} passed, ${failed} failed (out of ${multiTf.length})`);

  // Per-template sanity — each named template should produce at least one
  // candidate. If allowed_timeframes is too narrow we'd silently get zero
  // candidates and never know.
  const byTemplate = new Map<string, number>();
  for (const c of multiTf) {
    byTemplate.set(c.template_name, (byTemplate.get(c.template_name) ?? 0) + 1);
  }
  console.log("\nPer-template candidate counts:");
  for (const [name, count] of byTemplate) {
    console.log(`  ${name.padEnd(28)}  ${count}`);
  }

  if (failed > 0) process.exit(1);
}

main();
