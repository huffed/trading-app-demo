/**
 * Unit-level smoke test for `convictionMultiplierByTfAgreement`.
 * Verifies the curve at boundary cases and intermediate points.
 *
 * Curve (default max_multiplier = 4):
 *   firedTfs = 1, totalTfs = 1   → 1.0 (single-TF: no signal)
 *   firedTfs = 1, totalTfs = 3   → 1.0 (1 TF firing = baseline)
 *   firedTfs = 2, totalTfs = 3   → 2.5 (mid-range)
 *   firedTfs = 3, totalTfs = 3   → 4.0 (full agreement)
 *
 * Run: npx tsx scripts/smoke-conviction-tf-curve.ts
 */
import { convictionMultiplierByTfAgreement } from "../src/lib/algorithm/conviction-sizing";

interface Case {
  fired: number;
  total: number;
  expected: number;
  desc: string;
}

const CASES: Case[] = [
  { fired: 0, total: 0, expected: 1.0, desc: "no conditions" },
  { fired: 1, total: 1, expected: 1.0, desc: "single-TF strategy (no scaling)" },
  { fired: 1, total: 3, expected: 1.0, desc: "1 of 3 TFs (baseline)" },
  { fired: 2, total: 3, expected: 2.5, desc: "2 of 3 TFs (mid)" },
  { fired: 3, total: 3, expected: 4.0, desc: "3 of 3 TFs (max)" },
  { fired: 1, total: 4, expected: 1.0, desc: "1 of 4 TFs (baseline)" },
  { fired: 4, total: 4, expected: 4.0, desc: "4 of 4 TFs (max)" },
  { fired: 2, total: 4, expected: 2.0, desc: "2 of 4 TFs (1/3 of way up)" },
];

let failed = 0;
console.log("Conviction multiplier — TF agreement curve\n");
console.log("fired/total  expected   actual    case");
console.log("---------------------------------------");
for (const c of CASES) {
  const actual = convictionMultiplierByTfAgreement(c.fired, c.total);
  const ok = Math.abs(actual - c.expected) < 1e-6;
  if (!ok) failed++;
  const flag = ok ? "✓" : "✗";
  console.log(
    `${String(c.fired).padStart(3)}/${String(c.total).padEnd(3)}  ${c.expected.toFixed(2).padStart(8)}  ${actual.toFixed(2).padStart(7)}    ${flag} ${c.desc}`
  );
}
console.log();

// Custom max_multiplier — verify the curve scales with the cap.
const custom = convictionMultiplierByTfAgreement(3, 3, 8);
const customExpected = 8;
const customOk = Math.abs(custom - customExpected) < 1e-6;
console.log(
  `Custom max=8, full agreement: expected ${customExpected}, got ${custom.toFixed(2)} ${customOk ? "✓" : "✗"}`
);
if (!customOk) failed++;

console.log();
if (failed > 0) {
  console.error(`FAIL: ${failed} case(s) wrong`);
  process.exit(1);
}
console.log(`All ${CASES.length + 1} cases passed.`);
