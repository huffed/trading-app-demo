/**
 * Cases for guard-bash rule 7's short lists. `pnpm exec prettier --check *`, `pnpm exec vitest run *` and
 * `pnpm exec tsc --noEmit *` are pre-approved, and each has flags that import a file, run a program or write one,
 * so such a command may take only flags known to do none of that (DEBT D-22; the reviews of #331 and #335 found
 * the shapes below, several of them run against the installed prettier 3.8.3 and vitest 4.1.5). Nothing here is
 * executed.
 */

/** guard-bash.sh must refuse these (exit 2) with the pre-approved-tool reason */
export const MODULE_FLAG_BLOCKED: readonly string[] = [
  // prettier: a config or plugin it imports, its experimental CLI's config path, a cache it writes anywhere
  "pnpm exec prettier --check --config scripts/x.ts package.json",
  "pnpm exec prettier --check --config=scripts/x.ts package.json",
  'pnpm exec prettier --check "--config" scripts/x.ts package.json',
  "pnpm exec prettier --check --plugin=./scripts/x.ts package.json",
  "npx prettier --check --plugin ./scripts/x.ts .",
  "pnpm exec prettier --check --experimental-cli --no-cache --config-path scripts/dev/fence-check.mjs package.json",
  "pnpm exec prettier --check --cache --cache-location tests/golden/x.golden.json package.json",
  "PRETTIER_EXPERIMENTAL_CLI=1 pnpm exec prettier --check package.json",
  "pnpm exec prettier --check --config scripts/canonical/enable-broker-mirror.ts package.json",
  "pnpm exec prettier --check --plugin=./scripts/canonical/enable-broker-mirror.ts package.json",
  // vitest: a config, reporter, environment, diff module or VCS provider it imports, Node flags, a file it writes
  "pnpm exec vitest run --config scripts/x.ts",
  "pnpm exec vitest run -c scripts/x.ts",
  "pnpm exec vitest run -vc scripts/x.ts",
  "pnpm exec vitest run --reporter ./scripts/x.ts",
  "pnpm exec vitest run --reporter=./scripts/x.ts",
  "pnpm exec vitest run --environment ./scripts/x.ts",
  "pnpm exec vitest run --diff ./scripts/x.ts",
  "pnpm exec vitest run --experimental.vcsProvider ./scripts/x.ts",
  "pnpm exec vitest run --execArgv=--import=./scripts/x.ts",
  "pnpm exec vitest run --coverage.enabled --coverage.provider=custom --coverage.customProviderModule=./x.ts",
  "pnpm exec vitest run --outputFile.json=tests/golden/x.golden.json",
  "NODE_OPTIONS=--import=./scripts/x.mjs pnpm exec vitest run",
  "pnpm exec vitest run \\\n--config scripts/x.ts",
  // tsc: files it writes
  "pnpm exec tsc --noEmit --generateTrace /tmp/trace",
  "pnpm exec tsc --noEmit --generateCpuProfile /tmp/profile.cpuprofile",
];

/** guard-bash.sh must allow these (exit 0): the checks as they are run, with the repo's own config */
export const MODULE_FLAG_ALLOWED: readonly string[] = [
  "pnpm exec prettier --check src/lib/format.ts",
  "pnpm exec prettier -c src/lib/format.ts",
  "pnpm exec prettier --check --log-level warn --ignore-unknown src docs",
  "npx --no-install prettier --check tests/hooks/hooks.test.ts",
  "pnpm exec vitest run tests/hooks/hooks.test.ts",
  'pnpm exec vitest run tests/hooks/hooks.test.ts -t "rule 7"',
  'pnpm exec vitest run tests/hooks/hooks.test.ts -t "--config scripts/x.ts"',
  "pnpm exec vitest run tests/ops -t config --reporter=verbose",
  "pnpm exec vitest run tests/unit --reporter verbose --bail 1 --silent",
  "pnpm exec tsc --noEmit -p tsconfig.json",
  "pnpm exec tsc --noEmit --pretty false",
];
