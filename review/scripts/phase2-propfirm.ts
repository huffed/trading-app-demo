/**
 * Phase 2.6 — prop-firm simulation on EQUITY paths (floating MAE), per
 * candidate account size and risk per trade. Re-runs the deployed rules
 * (sibling-aware) through the engine at each (capital, risk) so the 0.01-lot
 * floor and compounding act as they would on a real account, then:
 *  - runUntilTarget: P(pass) and median months for Phase 1 (+10%) and Phase 2
 *    (+5%), both with the static −10% max-loss floor and −5% daily rule
 *    (UTC-day, floating-MAE proxy — see 02-validation.md caveats);
 *  - stressTest: worst 60-day-window max loss / daily loss;
 *  - mcChallenge: block-resampled (21 calendar-day blocks) distribution of
 *    the max-loss floor → P(ML > 5/8/10%), months (the library multiplies
 *    calendar days by 7/5 — reported raw AND corrected ÷1.4).
 * Reproduce: pnpm dlx tsx review/scripts/phase2-propfirm.ts   (~15 min)
 */
import { writeFileSync } from "node:fs";
import { buildDailyPath, mcChallenge, runUntilTarget, stressTest } from "../../scripts/canonical/lib/pinned-eval";
import { loadDeployedMembers, mean, nominalR, runSiblingAware, sd } from "./lib/harness";
import { CANONICAL_PINS, loadPinnedFile, sessionDaily } from "./lib/pins";

const CAPITALS = [10_000, 50_000, 100_000];
const RISKS = [0.2, 0.3, 0.42, 0.6, 0.8, 1.0];

async function main() {
  const h4 = loadPinnedFile(CANONICAL_PINS.h4).bars;
  const daily = sessionDaily(loadPinnedFile(CANONICAL_PINS.d).bars);
  const members = await loadDeployedMembers();
  const ref = runSiblingAware(members, h4, daily, 1_000_000, { uniformRisk: 0.42 }).union.length; // floor-free signal count
  const rows: Array<Record<string, number | string>> = [];
  console.log("capital  risk%   n  skip%  meanR   sdR  | P1 P(pass) med.mo | P2 P(pass) med.mo | P(funded) | stress worstML worstDL breach/windows | MC P(ML>5) P(ML>8) P(ML>10) ml_p95 mo_p50(raw/÷1.4)");
  for (const cap of CAPITALS) for (const risk of RISKS) {
    const t0 = Date.now();
    const run = runSiblingAware(members, h4, daily, cap, { uniformRisk: risk });
    const u = run.union;
    const rs = u.map((t) => nominalR(t, cap, risk));
    const p1 = runUntilTarget(u, cap, 10, 10, 5), p2 = runUntilTarget(u, cap, 5, 10, 5);
    const st = stressTest(u, cap);
    const mc = mcChallenge(buildDailyPath(u, cap), 10_000, 21, 10, 10, 5);
    const funded = (p1.pass_rate_pct / 100) * (p2.pass_rate_pct / 100) * 100;
    const row = { capital: cap, risk, n: u.length, skip_pct: 100 * (1 - u.length / ref), mean_r: mean(rs), sd_r: sd(rs), p1_pass_pct: p1.pass_rate_pct, p1_median_months: p1.median_months, p1_resolved: p1.resolved, p1_fail_ml: p1.fails_ml, p1_fail_dl: p1.fails_dl, p2_pass_pct: p2.pass_rate_pct, p2_median_months: p2.median_months, p_funded_pct: funded, stress_windows: st.windows, stress_breaches: st.fail_ml + st.fail_dl, stress_worst_ml: st.worst_ml, stress_worst_dl: st.worst_dl, mc_p_ml_gt5: 100 * mc.p_ml_gt(5), mc_p_ml_gt8: 100 * mc.p_ml_gt(8), mc_p_ml_gt10: 100 * mc.p_ml_gt(10), mc_fail_dl_pct: mc.fail_dl_pct, mc_ml_p50: mc.ml_p50, mc_ml_p95: mc.ml_p95, mc_months_p50_raw: mc.months_p50, mc_months_p50_corrected: mc.months_p50 / 1.4, ms: Date.now() - t0 };
    rows.push(row);
    console.log(`$${String(cap).padStart(6)} ${risk.toFixed(2).padStart(5)} ${String(u.length).padStart(4)} ${row.skip_pct.toFixed(1).padStart(5)} ${row.mean_r.toFixed(3).padStart(6)} ${row.sd_r.toFixed(2).padStart(5)} | ${p1.pass_rate_pct.toFixed(1).padStart(6)} ${p1.median_months.toFixed(1).padStart(6)} | ${p2.pass_rate_pct.toFixed(1).padStart(6)} ${p2.median_months.toFixed(1).padStart(6)} | ${funded.toFixed(1).padStart(6)} | ${st.worst_ml.toFixed(2).padStart(6)} ${st.worst_dl.toFixed(2).padStart(6)} ${String(st.fail_ml + st.fail_dl).padStart(3)}/${st.windows} | ${row.mc_p_ml_gt5.toFixed(1).padStart(5)} ${row.mc_p_ml_gt8.toFixed(1).padStart(5)} ${row.mc_p_ml_gt10.toFixed(1).padStart(5)} ${mc.ml_p95.toFixed(2).padStart(6)} ${mc.months_p50.toFixed(1)}/${(mc.months_p50 / 1.4).toFixed(1)}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    writeFileSync("review/results/phase2-propfirm.json", JSON.stringify({ floor_free_signals: ref, rows, generated_at: new Date().toISOString() }, null, 1));
  }
  console.log("→ review/results/phase2-propfirm.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
