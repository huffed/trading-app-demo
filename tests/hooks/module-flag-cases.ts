/**
 * Cases for guard-bash rule 7's module flags: prettier and vitest are pre-approved, and both import and run the
 * file a --config, --plugin, --setupFiles or --globalSetup flag names (vitest's -c too), so such a flag would let
 * an allowed check run any file in the repo (DEBT D-22, the review of #331). Nothing here is executed.
 */

/** guard-bash.sh must refuse these (exit 2) with the module-flag reason */
export const MODULE_FLAG_BLOCKED: readonly string[] = [
  "pnpm exec prettier --check --config scripts/x.ts package.json",
  "pnpm exec prettier --check --config=scripts/x.ts package.json",
  'pnpm exec prettier --check "--config" scripts/x.ts package.json',
  "pnpm exec prettier --check --plugin=./scripts/x.ts package.json",
  "npx prettier --check --plugin ./scripts/x.ts .",
  "pnpm exec vitest run --config scripts/x.ts",
  "pnpm exec vitest run -c scripts/x.ts",
  "pnpm exec vitest run --setupFiles scripts/x.ts tests/unit",
  "pnpm exec vitest run --globalSetup=scripts/x.ts",
  // the shapes the review of #331 found, on the script that turns mirroring on (rule 7 refuses them before rule 6)
  "pnpm exec prettier --check --config scripts/canonical/enable-broker-mirror.ts package.json",
  "pnpm exec prettier --check --plugin=./scripts/canonical/enable-broker-mirror.ts package.json",
];

/** guard-bash.sh must allow these (exit 0): the checks with the repo's own config, found by themselves */
export const MODULE_FLAG_ALLOWED: readonly string[] = [
  "pnpm exec prettier --check src/lib/format.ts",
  "pnpm exec prettier -c src/lib/format.ts",
  "pnpm exec vitest run tests/hooks/hooks.test.ts",
  "pnpm exec vitest run tests/ops -t config",
];
