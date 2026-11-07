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
];
