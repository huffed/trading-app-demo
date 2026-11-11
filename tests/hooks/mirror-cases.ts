/**
 * Cases for guard-bash.sh rule 6: running the script that turns mirroring on (DEBT D-33).
 * Kept apart from cases.ts so both files stay under the target size limit. Nothing here is executed.
 */

const mirrorScript = "scripts/canonical/enable-broker-mirror.ts";

/** guard-bash.sh must refuse these (exit 2): each runs, or could run, the script */
export const MIRROR_BLOCKED: string[] = [
  "pnpm dlx tsx M",
  "pnpm exec tsx M",
  "npx tsx M",
  "tsx M",
  "bun run M",
  "FOO=1 pnpm dlx tsx M",
  "sudo -n tsx M",
  "env FOO=1 tsx M",
  "node --import tsx M",
  `tsx "M"`,
  "cd scripts/canonical && tsx enable-broker-mirror.ts",
  "bash -c 'pnpm dlx tsx M'",
  `node -e 'import("./M")'`,
  `python3 -c "import subprocess; subprocess.run(['tsx', 'M'])"`,
  "echo $(tsx M)",
  "echo M | xargs pnpm dlx tsx",
  `printf '%s\\n' M | while read -r f; do tsx "$f"; done`,
  `f=enable-broker-mirror; tsx scripts/canonical/$f.ts`,
  // the review of #331: more runners, a runner by its path, vitest, a glob, a name across lines, the host
  "pnpx tsx M",
  "bunx tsx M",
  "timeout 60 tsx M",
  "node_modules/.bin/tsx M",
  "./node_modules/.bin/tsx M",
  "Tsx M",
  "pnpm exec vitest run M",
  "tsx scripts/canonical/enable-broker*.ts",
  "tsx scripts/canonical/enable-\\\nbroker-mirror.ts",
  "FOO=1 \\\ntsx M",
  "ssh qt 'cd /opt/quanttrader && pnpm exec tsx M'",
  // the second review of #331: eslint loading it, runners behind quotes, flags and wrappers (a pre-approved
  // prettier --config or --plugin loading it is refused by rule 7 first: module-flag-cases.ts)
  "npx eslint -c M .",
  'NODE_OPTIONS="--no-warnings --dns-result-order=ipv4first" pnpm dlx tsx M',
  '"$PWD/node_modules/.bin/tsx" M',
  '"./node_modules/.bin/tsx" M',
  "FOO=1 \\\nBAR=2 pnpm dlx tsx M",
  "cd scripts/canonical && \\\nenv X=1 tsx enable-broker-mirror.ts",
  "printf '%s\\0' M | xargs -0 pnpm dlx tsx",
  "printf '%s\\n' M | xargs -I{} pnpm dlx tsx {}",
  "find . -name enable-broker-mirror.ts -exec pnpm dlx tsx {} \\;",
  "nice -n 10 tsx M",
  "sudo -u ops tsx M",
  `awk 'BEGIN{system("tsx M")}'`,
  "node_modules/.bin/vite --config M",
  "node_modules/.bin/vitest run --config M",
  "corepack pnpm dlx tsx M",
  // the third review of #331: a runner inside a VAR= value, git -c, man -P, eslint -f
  'GIT_EDITOR="tsx M" git commit',
  "git -c diff.external=tsx diff --no-index /dev/null M",
  'man -P "tsx M" ls',
  "npx eslint -f ./M .",
  // a known false positive, kept closed: a test filter that names the script, beside a runner
  "pnpm exec vitest run tests/hooks/hooks.test.ts -t enable-broker-mirror",
].map((c) => c.replaceAll("M", mirrorScript));

/** guard-bash.sh must allow these (exit 0): reading or naming the script, and running another one */
export const MIRROR_ALLOWED: string[] = [
  `cat ${mirrorScript}`,
  `sed -n 150,170p ${mirrorScript}`,
  `grep -n live_trading_enabled ${mirrorScript}`,
  `git log --oneline -- ${mirrorScript}`,
  `pnpm exec eslint ${mirrorScript}`,
  `pnpm exec prettier --check ${mirrorScript}`,
  `git commit -m "docs: ${mirrorScript} stays refused"`,
  `cat > /tmp/note.md <<'EOF'\nthe script \`${mirrorScript}\` stays refused\nEOF`,
  "pnpm dlx tsx scripts/canonical/m1-progress.ts",
  `npx tsc --noEmit ${mirrorScript}`,
  `npx eslint ${mirrorScript}`,
  `pnpm prettier --check ${mirrorScript}`,
  `git commit -m "docs: ${mirrorScript} stays refused\nrun it with pnpm only after P19"`,
];
