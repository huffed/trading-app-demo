/**
 * E2.27 — reproducible assertions for the Monte Carlo challenge simulator
 * (`lib/pinned-eval.ts` buildDailyPath + mcChallenge). Run:
 *   pnpm dlx tsx scripts/canonical/verify-mc-challenge.ts
 * Exits non-zero on failure. Covers: deterministic pass/fail/DL known
 * answers, floating-MAE-only ML, tail-vs-outcome censoring monotonicity,
 * and seed reproducibility.
 */
import { buildDailyPath, mcChallenge } from "./lib/pinned-eval";
import type { BacktestTrade } from "../../src/lib/market-data/types";
let fail = 0;
const check = (name: string, actual: number, expected: number, tol: number): void => {
  const ok = Math.abs(actual - expected) <= tol;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${actual.toFixed(2)} (expect ~${expected})`);
  if (!ok) fail++;
};
const up = Array.from({ length: 500 }, () => ({ realizedRet: 0.001, openMaeRet: 0 }));
const r1 = mcChallenge(up, 1000, 21, 10, 10, 5, 1);
check("deterministic-up P(pass)", r1.pass_rate_pct, 100, 0.01);
check("deterministic-up months p50", r1.months_p50, 4.6, 0.15);
check("deterministic-up ML", r1.ml_p99, 0, 0.001);
const dn = Array.from({ length: 500 }, () => ({ realizedRet: -0.002, openMaeRet: 0 }));
const r2 = mcChallenge(dn, 1000, 21, 10, 10, 5, 2);
check("deterministic-down P(pass)", r2.pass_rate_pct, 0, 0.01);
check("deterministic-down fail_ml%", r2.fail_ml_pct, 100, 0.01);
const dl = Array.from({ length: 100 }, (_, i) => ({ realizedRet: i === 50 ? -0.06 : 0, openMaeRet: 0 }));
check("dl-spike fail_dl%", mcChallenge(dl, 1000, 21, 10, 10, 5, 3).fail_dl_pct, 100, 0.01);
const fl = Array.from({ length: 200 }, (_, i) => ({ realizedRet: 0, openMaeRet: i >= 100 && i < 110 ? 0.03 : 0 }));
check("floating-only tail ml_p99", mcChallenge(fl, 500, 21, 10, 30, Number.POSITIVE_INFINITY, 4, 400).ml_p99, 3, 0.2);
const mixTrades: BacktestTrade[] = [];
let day = Date.parse("2020-01-01T00:00:00Z");
const lcg = ((): (() => number) => { let s = 7; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();
for (let i = 0; i < 300; i++) {
  const win = lcg() < 0.4;
  mixTrades.push({ entry_date: new Date(day).toISOString(), exit_date: new Date(day + 3 * 86400000).toISOString(), entry_price: 100, exit_price: 100, side: "long", pnl: win ? 250 : -100, mae: win ? 40 : 110, equity_at_entry: 10000 });
  day += Math.floor(2 + lcg() * 5) * 86400000;
}
const days = buildDailyPath(mixTrades);
const tailP99 = mcChallenge(days, 2000, 21, 10, 30, Number.POSITIVE_INFINITY, 5).ml_p99;
const outcP99 = mcChallenge(days, 2000, 21, 10, 10, 5, 5).ml_p99;
console.log(`censoring monotonicity: tail ${tailP99.toFixed(2)} >= outcome ${outcP99.toFixed(2)} → ${tailP99 >= outcP99 - 0.01 ? "PASS" : "FAIL"}`);
if (tailP99 < outcP99 - 0.01) fail++;
const a = mcChallenge(days, 500, 21, 10, 10, 5, 9).pass_rate_pct;
const b = mcChallenge(days, 500, 21, 10, 10, 5, 9).pass_rate_pct;
console.log(`seed reproducibility: ${a === b ? "PASS" : "FAIL"}`);
if (a !== b) fail++;
console.log(fail === 0 ? "\nALL MC ASSERTIONS PASS" : `\n${fail} FAILURE(S)`);
process.exit(fail ? 1 : 0);
