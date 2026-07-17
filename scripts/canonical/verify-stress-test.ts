/**
 * E2.24.d — reproducible assertions for the fidelity `stressTest`
 * (`lib/pinned-eval.ts`). Lives in scripts/ because pinned-eval is a
 * verdict-harness lib outside the `src/**` vitest include; run manually:
 *   pnpm dlx tsx scripts/canonical/verify-stress-test.ts
 * Exits non-zero on any assertion failure.
 *
 * Covers: floating-inclusive ML for concurrent open positions (d.i),
 * no double-count when a position stops at its own MAE, de-compounding
 * to window-start capital (d.ii), and the legacy realized-only fallback.
 */
import { stressTest } from "./lib/pinned-eval";
import type { BacktestTrade } from "../../src/lib/market-data/types";

const CAP = 10_000;
let failures = 0;
function check(name: string, actual: number, expected: number, tol = 0.05): void {
  const ok = Math.abs(actual - expected) <= tol;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${actual.toFixed(2)} (expected ~${expected})`);
  if (!ok) failures++;
}

const t = (entry: string, exit: string, pnl: number, mae: number, eq = CAP): BacktestTrade => ({
  entry_date: entry, exit_date: exit, entry_price: 100, exit_price: 100, side: "long", pnl, mae, equity_at_entry: eq,
});

// (d.i) Two concurrent open positions, each MAE $300 (3%), both flat.
// Realized-only ML = 0; floating trough sees the concurrent 6%.
check("floating ML — 2 concurrent 3% MAE", stressTest([
  t("2015-01-05T00:00:00Z", "2015-01-20T00:00:00Z", 0, 300),
  t("2015-01-06T00:00:00Z", "2015-01-20T00:00:00Z", 0, 300),
  t("2015-04-05T00:00:00Z", "2015-04-06T00:00:00Z", 50, 10),
], CAP).worst_ml, 6.0);

// No double-count: single position stopped at its own MAE → floating ML
// equals the realized loss, not twice it.
check("no double-count — stopped at MAE", stressTest([
  t("2015-01-05T00:00:00Z", "2015-01-10T00:00:00Z", -300, 300),
  t("2015-04-05T00:00:00Z", "2015-04-06T00:00:00Z", 50, 10),
], CAP).worst_ml, 3.0);

// (d.ii) De-compounding: 12 monthly +1%-return trades all sized on $18k
// (pnl $180) must contribute ~1% each rescaled to $10k, not 1.8%.
const dc: BacktestTrade[] = [];
for (let m = 1; m <= 12; m++) dc.push(t(`2015-${String(m).padStart(2, "0")}-05T00:00:00Z`, `2015-${String(m).padStart(2, "0")}-06T00:00:00Z`, 180, 0, 18000));
check("de-compounded avg return/window", stressTest(dc, CAP).avg_return_pct, 2.0, 0.2);

// Legacy fallback: no mae/equity_at_entry → realized-only, un-rescaled.
check("legacy realized-only ML", stressTest([
  { entry_date: "2015-01-05T00:00:00Z", exit_date: "2015-01-10T00:00:00Z", entry_price: 100, exit_price: 97, side: "long", pnl: -300 },
  { entry_date: "2015-04-05T00:00:00Z", exit_date: "2015-04-06T00:00:00Z", entry_price: 100, exit_price: 100.5, side: "long", pnl: 50 },
], CAP).worst_ml, 3.0);

console.log(failures === 0 ? "\nALL STRESS-TEST ASSERTIONS PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
