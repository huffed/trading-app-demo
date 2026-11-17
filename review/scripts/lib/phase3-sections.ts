/**
 * Phase 3 sections: the bias-run tables, the regime-variable correlations and
 * the 2026 description on the refreshed pin.
 */
import { brief, r3, say, type Brief, type Trade } from "./phase3-lib";
import { biasRuns, sessions, type Run, type Sess } from "./phase3-market";
import {
  REGIME_KEYS,
  bestKey,
  corrTable,
  regimeVars,
  type Corr,
  type Period,
} from "./phase3-regime-vars";
import { nSum, periodStats, type PeriodStats, type Unions } from "./phase3-tables";
import { REVIEW_PINS, loadPinnedFile, mergeBars, sessionDaily } from "./pins";
import type { PriceBar } from "../../../src/lib/market-data/types";

interface RunRow extends Run {
  L_on: PeriodStats;
  L_off: PeriodStats;
  S_on: PeriodStats;
  LS_on: PeriodStats;
  L_on_after40: Brief;
}
type RunAgg = Record<string, Brief & { runs: number; sessions: number }>;
export function runSections(
  unions: Unions,
  sess: Sess[],
  runs: Run[]
): {
  runRows: RunRow[];
  runAgg: Record<string, RunAgg>;
  outside: Record<string, Brief>;
  afterBear: Brief;
  biasShare: Record<string, number>;
} {
  const longRuns = runs.filter((r) => r.sessions >= 15);
  const inRun = (ts: Trade[], r: Run): Trade[] =>
    ts.filter((t) => t.entry_date >= r.start && t.entry_date <= r.end);
  const afterRun = (ts: Trade[], r: Run, k: number): Trade[] => {
    const endI = Math.min(sess.length - 1, r.end_i + k);
    return ts.filter((t) => t.entry_date > r.end && t.entry_date <= sess[endI].date);
  };
  const stats = (name: string, r: Run): PeriodStats =>
    periodStats(unions[name], r.start, `${r.end}~`);
  const runRows: RunRow[] = longRuns.map((r) => ({
    ...r,
    L_on: stats("L_on", r),
    L_off: stats("L_off", r),
    S_on: stats("S_on", r),
    LS_on: stats("LS_on", r),
    L_on_after40: brief(afterRun(unions.L_on, r, 40)),
  }));
  say(`\n== bias runs ≥15 sessions (${String(longRuns.length)} of ${String(runs.length)} runs) ==`);
  say(
    "bias     start       end         sess  gold%   mdd%  | L_on n/sumR | L_off n/sumR | S_on n/sumR | LS_on n/sumR | L_on next40 n/sumR"
  );
  for (const r of runRows) {
    say(
      `${r.bias.padEnd(8)} ${r.start.slice(0, 10)}  ${r.end.slice(0, 10)}  ${String(r.sessions).padStart(4)} ${String(r.gold_ret_pct).padStart(6)} ${String(r.gold_mdd_pct).padStart(6)}  | ${nSum(r.L_on)} | ${nSum(r.L_off)} | ${nSum(r.S_on)} | ${nSum(r.LS_on)} | ${nSum(r.L_on_after40)}`
    );
  }
  const agg = (bias: Run["bias"]): RunAgg => {
    const rs = longRuns.filter((r) => r.bias === bias),
      out: RunAgg = {};
    for (const name of Object.keys(unions)) {
      out[name] = {
        runs: rs.length,
        sessions: rs.reduce((a, r) => a + r.sessions, 0),
        ...brief(rs.flatMap((r) => inRun(unions[name], r))),
      };
    }
    return out;
  };
  const runAgg = { bearish: agg("bearish"), bullish: agg("bullish") };
  const outside: Record<string, Brief> = {};
  for (const name of Object.keys(unions)) {
    const inside = new Set(longRuns.flatMap((r) => inRun(unions[name], r)));
    outside[name] = brief(unions[name].filter((t) => !inside.has(t)));
  }
  const afterBear = brief(
    longRuns.filter((r) => r.bias === "bearish").flatMap((r) => afterRun(unions.L_on, r, 40))
  );
  say(
    `\nAGG inside bearish runs ≥15: ${JSON.stringify(runAgg.bearish)}\nAGG inside bullish runs ≥15: ${JSON.stringify(runAgg.bullish)}\nOUTSIDE any run ≥15 (the choppy stretches): ${JSON.stringify(outside)}\nL_on in the 40 sessions after a bearish run ≥15 ends: ${JSON.stringify(afterBear)}`
  );
  const count = (b: Run["bias"]): number =>
    longRuns.filter((r) => r.bias === b).reduce((a, r) => a + r.sessions, 0);
  const biasShare = {
    bullish: r3(sess.filter((s) => s.bias === "bullish").length / sess.length),
    bearish: r3(sess.filter((s) => s.bias === "bearish").length / sess.length),
    sessions_in_bearish_runs_ge15: count("bearish"),
    sessions_in_bullish_runs_ge15: count("bullish"),
    sessions: sess.length,
  };
  return { runRows, runAgg, outside, afterBear, biasShare };
}
function showCorr(title: string, c: Record<string, Corr>): void {
  say(`\n${title}`);
  const sorted = Object.entries(c).sort(
    (a, b) => Math.abs(b[1].spearman) - Math.abs(a[1].spearman)
  );
  for (const [k, v] of sorted) {
    say(
      `  ${k.padEnd(18)} spearman=${String(v.spearman).padStart(7)} pearson=${String(v.pearson).padStart(7)} periods=${String(v.n_periods)}`
    );
  }
}
export function regimeSections(
  sess: Sess[],
  periods: { yrs: Period[]; qs: Period[] },
  yearly: Record<string, PeriodStats>,
  lOn: Trade[]
): Record<string, unknown> {
  const yearRows = periods.yrs.map((p) => ({
    key: p.key,
    regime: regimeVars(sess, p.from, p.to),
    ...yearly[p.key],
  }));
  const rowsOf = (
    rs: typeof yearRows,
    useSum: boolean
  ): { regime: (typeof rs)[number]["regime"]; mean_r: number; n: number }[] =>
    rs.map((r) => ({ regime: r.regime, mean_r: useSum ? r.sum_r : r.mean_r, n: r.n }));
  const yearCorr = corrTable(rowsOf(yearRows, false), 1),
    yearCorrSum = corrTable(rowsOf(yearRows, true), 1);
  const looBest: Record<string, number> = {};
  for (let i = 0; i < yearRows.length; i++) {
    const rest = yearRows.filter((_, j) => j !== i);
    const best = bestKey(corrTable(rowsOf(rest, false), 1));
    looBest[best] = (looBest[best] ?? 0) + 1;
  }
  const qRows = periods.qs.map((p) => ({
    key: p.key,
    regime: regimeVars(sess, p.from, p.to),
    ...periodStats(lOn, p.from, p.to),
  }));
  const qCorr = corrTable(rowsOf(qRows, false), 5);
  const next = qRows.slice(0, -1).map((r, i) => ({
    regime: r.regime,
    mean_r: qRows[i + 1].mean_r,
    sum_r: qRows[i + 1].sum_r,
    n: qRows[i + 1].n,
  }));
  const qPred = corrTable(next, 5),
    qPredSum = corrTable(
      next.map((r) => ({ regime: r.regime, mean_r: r.sum_r, n: 0 })),
      0
    );
  say(
    `\n== regime variables ==\nyear   ${REGIME_KEYS.map((k) => k.padStart(12)).join("")}   | L_on meanR   n`
  );
  for (const r of yearRows) {
    say(
      `${r.key.padEnd(6)} ${REGIME_KEYS.map((k) => String(r.regime[k]).padStart(12)).join("")}   | ${r.mean_r.toFixed(3).padStart(7)} ${String(r.n).padStart(4)}`
    );
  }
  showCorr("yearly, coincident, vs mean R (n=12 years)", yearCorr);
  showCorr("yearly, coincident, vs sum R", yearCorrSum);
  say(`leave-one-year-out best variable counts: ${JSON.stringify(looBest)}`);
  showCorr("quarterly, coincident, vs mean R (quarters with ≥5 trades)", qCorr);
  showCorr("quarterly, PREDICTIVE: variable in Q vs mean R in Q+1 (≥5 trades in Q+1)", qPred);
  showCorr("quarterly, PREDICTIVE: variable in Q vs sum R in Q+1 (all quarters)", qPredSum);
  return {
    regime_yearly: yearRows,
    corr_yearly_mean_r: yearCorr,
    corr_yearly_sum_r: yearCorrSum,
    loo_best: looBest,
    regime_quarterly: qRows,
    corr_quarterly_mean_r: qCorr,
    corr_quarterly_predictive_mean_r: qPred,
    corr_quarterly_predictive_sum_r: qPredSum,
  };
}
export function describe2026(dStart: PriceBar[]): Run[] {
  const runsR = biasRuns(
    sessions(sessionDaily(mergeBars(dStart, loadPinnedFile(REVIEW_PINS.d).bars)))
  ).filter((r) => r.start >= "2026-01-01");
  const lines = runsR.map(
    (r) =>
      `${r.bias} ${r.start.slice(0, 10)}→${r.end.slice(0, 10)} ${String(r.sessions)} sessions, gold ${String(r.gold_ret_pct)}%`
  );
  say(
    `\n== 2026 bias runs on the refreshed session dailies (description only) ==\n${lines.join("\n")}`
  );
  return runsR;
}
