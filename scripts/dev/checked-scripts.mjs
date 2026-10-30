/**
 * Single source of truth for which files under scripts/ are checked.
 *
 * Live-path scripts (cron wrappers, deploy, VPS-run tooling, the verdict and
 * baseline scripts, data-pin tooling, operator diagnostics) are everything
 * under scripts/ that is not listed below. They are linted, type-checked and
 * formatted like src/.
 *
 * Research one-offs (superseded experiments and stress runs) are excluded from
 * ESLint and from `make env-check` by this list; tsc still type-checks them and
 * Prettier formats them when they change. docs/DEBT.md D-20 carries the target
 * date (2027-01-31) by which each is either brought under the same checks or
 * moved to scripts/archive/. Adding a script here needs a DEBT.md line.
 *
 * Rule (operator, 2026-10-29): a script whose output feeds a decision — a
 * baseline, a verdict, a roadmap gate — is live-path by definition and must not
 * be on this list. Nine such scripts were removed from it on 2026-10-30.
 *
 * `node scripts/dev/checked-scripts.mjs` prints the live-path TypeScript files
 * (one per line) for tools that cannot import this module (prettier, xargs).
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPT_IGNORE_GLOBS = [
  "scripts/archive/**",
  "scripts/ad-hoc/**",
  "scripts/.llm-replay-cache/**",
  "scripts/python/**",
];

export const RESEARCH_SCRIPTS = [
  "scripts/canonical/algo-search.ts",
  "scripts/canonical/augmented-variant-validate.ts",
  "scripts/canonical/bo-search.ts",
  "scripts/canonical/clone-augmented-family.ts",
  "scripts/canonical/compose-portfolio.ts",
  "scripts/canonical/comprehensive-daily-bias-sweep.ts",
  "scripts/canonical/e2-list-layer-b-targets.ts",
  "scripts/canonical/e2-list-passers.ts",
  "scripts/canonical/e2.15-l2-session-filter-test.ts",
  "scripts/canonical/e2.15-l4-partial-exit-posthoc-sim.ts",
  "scripts/canonical/e27.5-cell-coverage-augmented.ts",
  "scripts/canonical/feature-importance.ts",
  "scripts/canonical/feature-veto-validate.ts",
  "scripts/canonical/five-algo-expansion-stress.ts",
  "scripts/canonical/four-algo-with-short-stress.ts",
  "scripts/canonical/label-reengineering.ts",
  "scripts/canonical/multi-algo-ftmo-stress.ts",
  "scripts/canonical/per-regime-sweep.ts",
  "scripts/canonical/persist-bo-family.ts",
  "scripts/canonical/portfolio-realistic-sim.ts",
  "scripts/canonical/robustness-aggregate.ts",
  "scripts/canonical/robustness-alt-objective.ts",
  "scripts/canonical/robustness-bootstrap-bars.ts",
  "scripts/canonical/robustness-leave-n-out.ts",
  "scripts/canonical/robustness-multi-cut.ts",
  "scripts/canonical/stepwise-feature-augmentation.ts",
  "scripts/canonical/stress-test-ftmo-challenge-windows.ts",
  "scripts/canonical/verify-arb-daily-bias-ftmo.ts",
  "scripts/canonical/verify-ftmo-floor-not-peak-to-trough.ts",
  "scripts/canonical/verify-portfolio-daily-bias-ftmo.ts",
  "scripts/canonical/verify-single-algo-dd.ts",
  "scripts/canonical/vol-target-ab-validate.ts",
  "scripts/canonical/wf-vs-kfold-equivalence.ts",
];

const IGNORED_DIRS = new Set(["archive", "ad-hoc", ".llm-replay-cache", "python", "node_modules"]);

/** All live-path TypeScript files under scripts/, repo-relative, sorted. */
export function livePathScriptFiles(repoRoot) {
  const research = new Set(RESEARCH_SCRIPTS);
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (!IGNORED_DIRS.has(entry)) walk(full);
      } else if (entry.endsWith(".ts") || entry.endsWith(".mjs")) {
        const rel = relative(repoRoot, full);
        if (!research.has(rel)) out.push(rel);
      }
    }
  };
  walk(join(repoRoot, "scripts"));
  return out.sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  for (const f of livePathScriptFiles(repoRoot)) process.stdout.write(`${f}\n`);
}
