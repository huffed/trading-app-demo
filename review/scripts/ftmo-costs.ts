/**
 * FTMO item 2 — Phase 2's headline restated with FTMO's overnight swap (first order: charged per trade on the
 * baseline trade list, no re-sizing, no path effects; Phase 6 puts it in the harness).
 *  Swap per trade = (nights it is open at a 17:00 New York rollover, Wednesday counted three times)
 *    × a fraction of the entry price, charged on the whole position, in R = units × fraction × price / SL distance.
 *  A (the operator's reading, the headline): 0.0156% of price a night.
 *  B: 0.0196%, what one real FTMO long paid on Tuesday 24 February 2026 (10.04 on 0.1 lot at 5,126.69).
 *  C: the fed funds rate plus a markup, annualised over 360 days: C-low is calibrated to A's reading in
 *     November 2026 (markup 1.72 points), C-high to B (markup 3.41 points). Neither markup reproduces both
 *     readings, so A to C is a range, not a model.
 * Reproduce: pnpm exec tsx review/scripts/ftmo-costs.ts
 */
import { writeFileSync } from "node:fs";
import { bootstrapStatBlock } from "../../src/lib/stats/bootstrap";
import { computeDeflatedSharpe, kurtosis, skewness } from "../../src/lib/stats/deflated-sharpe";
import type { BacktestTrade } from "../../src/lib/market-data/types";
import { closedKind, rollovers, SWAP_FRACTION, zoneOffsetMinutes } from "./lib/ftmo";
import { dateIndexOf, loadDeployedMembers, mean, nominalR, reconstructGeometry, runSiblingAware, sd } from "./lib/harness";
import { CANONICAL_PINS, loadPinnedFile, sessionDaily } from "./lib/pins";

const CAP = 100_000;
const RISK = 0.42;
const ITER = 10_000;
const H4_MS = 4 * 3_600_000;
const FED_FUNDS_ANNUAL: Record<number, number> = { 2015: 0.13, 2016: 0.4, 2017: 1.0, 2018: 1.83, 2019: 2.16, 2020: 0.38, 2021: 0.08, 2022: 1.68, 2023: 5.02, 2024: 5.14, 2025: 4.21 };
const FED_FUNDS_2026: Record<number, number> = { 1: 3.64, 2: 3.64, 3: 3.64, 4: 3.64, 5: 3.63, 6: 3.63, 7: 3.63, 8: 3.63, 9: 3.75, 10: 3.88 };
const MARKUP_LOW = SWAP_FRACTION * 100 * 360 - 3.88; // A's reading against October 2026's 3.88
const FRACTION_B = 10.04 / 10 / 5126.69;
const MARKUP_HIGH = FRACTION_B * 100 * 360 - 3.64; // B against February 2026's 3.64

type T = BacktestTrade & { algo: string };
interface Row {
  trade: T;
  units: number;
  nights: number;
  riskUsd: number;
  /** R per unit of "night × fraction": price / SL distance. */
  perNightPerFraction: number;
  night: number;
}

function fedFunds(ms: number): number {
  const d = new Date(ms);
  return d.getUTCFullYear() === 2026 ? FED_FUNDS_2026[d.getUTCMonth() + 1] ?? 3.88 : FED_FUNDS_ANNUAL[d.getUTCFullYear()] ?? 3.64;
}

const fractionC = (ms: number, markup: number): number => (fedFunds(ms) + markup) / 100 / 360;

async function main(): Promise<void> {
  const h4 = loadPinnedFile(CANONICAL_PINS.h4).bars;
  const daily = sessionDaily(loadPinnedFile(CANONICAL_PINS.d).bars);
  const idx = dateIndexOf(h4);
  const members = await loadDeployedMembers();
  const rulesOf = new Map(members.map((m) => [m.label, m.rules]));
  const run = runSiblingAware(members, h4, daily, CAP, { uniformRisk: RISK });
  const trades = ([...run.union] as T[]).sort((a, b) => a.exit_date.localeCompare(b.exit_date) || a.entry_date.localeCompare(b.entry_date));
  const lastBarOfDay = new Map<string, number>();
  for (const b of h4) {
    lastBarOfDay.set(b.date.slice(0, 10), Date.parse(b.date));
  }
  const rows: Row[] = trades.map((t) => {
    const g = reconstructGeometry(t, rulesOf.get(t.algo)!, h4, idx);
    if (!g) {
      throw new Error("geometry unresolved for " + t.algo + " " + t.entry_date);
    }
    const fill = Date.parse(t.entry_date) + H4_MS;
    let exitOpen = lastBarOfDay.get(t.exit_date.slice(0, 10)) ?? Date.parse(t.exit_date);
    for (let j = g.idx + 1; j < h4.length; j++) {
      const b = h4[j];
      if (b.date.slice(0, 10) > t.exit_date.slice(0, 10)) {
        break;
      }
      if (b.date.slice(0, 10) === t.exit_date.slice(0, 10) && (b.low <= g.sl || b.high >= g.tp)) {
        exitOpen = Date.parse(b.date);
        break;
      }
    }
    const charged = rollovers(fill, exitOpen);
    return {
      trade: t,
      units: charged.reduce((a, r) => a + r.units, 0),
      nights: charged.length,
      riskUsd: ((t.equity_at_entry ?? CAP) * RISK) / 100,
      perNightPerFraction: t.entry_price / g.slDistance,
      night: fill,
    };
  });

  const charge = (r: Row, fraction: (ms: number) => number): number => r.units * fraction(r.night) * r.perNightPerFraction;
  const adjusted = (fraction: (ms: number) => number, extraFraction = 0): T[] =>
    rows.map((r) => ({ ...r.trade, pnl: r.trade.pnl - (charge(r, fraction) + extraFraction * r.perNightPerFraction) * r.riskUsd }));
  const variants: Array<{ key: string; label: string; trades: T[] }> = [
    { key: "swap_free", label: "engine costs, no swap (Phase 2)", trades },
    { key: "A", label: "A: 0.0156% a night (operator, 18 Nov 2026), the headline", trades: adjusted(() => SWAP_FRACTION) },
    { key: "A_commission_rt", label: "A + commission 0.0014% round turn", trades: adjusted(() => SWAP_FRACTION, 0.000014) },
    { key: "A_commission_side", label: "A + commission 0.0014% per side (0.0028%)", trades: adjusted(() => SWAP_FRACTION, 0.000028) },
    { key: "B", label: "B: 0.0196% a night (FTMO long of 24 Feb 2026)", trades: adjusted(() => FRACTION_B) },
    { key: "C_low", label: "C: fed funds + 1.72 points, /360", trades: adjusted((ms) => fractionC(ms, MARKUP_LOW)) },
    { key: "C_high", label: "C: fed funds + 3.41 points, /360", trades: adjusted((ms) => fractionC(ms, MARKUP_HIGH)) },
  ];

  const dsrGrid = (R: number[]): Array<Record<string, number>> => {
    const sr = mean(R) / sd(R);
    const out: Array<Record<string, number>> = [];
    for (const n of [96, 300, 2000, 3300]) {
      for (const sig of [0.044, 0.06, 0.069, 0.1]) {
        const d = computeDeflatedSharpe({ observedSharpe: sr, returns: R, nTrials: n, trialSharpeStd: sig });
        out.push({ n_trials: n, sigma_sr: sig, dsr: d.deflatedSharpe, expected_max_sr: d.expectedMaxSharpe });
      }
    }
    return out;
  };
  const wr = (ts: T[]): number => (100 * ts.filter((t) => t.pnl > 0).length) / ts.length;
  const pf = (ts: T[]): number => ts.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0) / ts.filter((t) => t.pnl < 0).reduce((a, t) => a - t.pnl, 0);
  const maxDd = (ts: T[]): number => {
    let cum = 0;
    let peak = 0;
    let mdd = 0;
    for (const t of ts) {
      cum += t.pnl;
      peak = Math.max(peak, cum);
      mdd = Math.max(mdd, peak - cum);
    }
    return (100 * mdd) / CAP;
  };
  const results: Record<string, unknown> = {};
  for (const v of variants) {
    const R = v.trades.map((t) => nominalR(t, CAP, RISK));
    const ci = (fn: (s: T[]) => number, sample: T[]) => {
      const b = bootstrapStatBlock(sample, (s) => fn(s as T[]), { n_iterations: ITER, ci_level: 0.95, seed: 42 });
      return { point: b.point, lower: b.lower, upper: b.upper };
    };
    const mR = (ts: T[]): number => mean(ts.map((t) => nominalR(t, CAP, RISK)));
    const recent = v.trades.filter((t) => t.entry_date >= "2025-07-01");
    const years = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => 2015 + i).map((y) => {
        const f = v.trades.filter((t) => t.entry_date.startsWith(String(y)));
        return [String(y), { n: f.length, mean_r: mR(f) }];
      })
    );
    const grid = dsrGrid(R);
    const cell = (n: number, s: number): number => grid.find((g) => g.n_trials === n && g.sigma_sr === s)!.dsr;
    results[v.key] = {
      label: v.label,
      n: v.trades.length,
      mean_r: mean(R),
      sd_r: sd(R),
      skew: skewness(R),
      kurt: kurtosis(R),
      sr: mean(R) / sd(R),
      win_rate_pct: wr(v.trades),
      pf: pf(v.trades),
      max_dd_pct: maxDd(v.trades),
      total_r: R.reduce((a, b) => a + b, 0),
      ci_mean_r: ci(mR, v.trades),
      ci_mean_r_recent: ci(mR, recent),
      recent_n: recent.length,
      recent_mean_r: mR(recent),
      dsr: { "n3300_s0.060": cell(3300, 0.06), "n2000_s0.060": cell(2000, 0.06), "n3300_s0.069": cell(3300, 0.069), "n2000_s0.069": cell(2000, 0.069), "n3300_s0.044": cell(3300, 0.044), "n2000_s0.044": cell(2000, 0.044), "n96_s0.044": cell(96, 0.044), "n3300_s0.10": cell(3300, 0.1) },
      dsr_grid: grid,
      years,
    };
  }

  const units = rows.map((r) => r.units);
  const nightsHeld = rows.map((r) => r.nights);
  const swapR = rows.map((r) => charge(r, () => SWAP_FRACTION));
  const meta = {
    nights_held: { mean: mean(nightsHeld), max: Math.max(...nightsHeld), share_zero: nightsHeld.filter((n) => n === 0).length / nightsHeld.length },
    swap_units: { mean: mean(units) },
    swap_r_under_A: { mean: mean(swapR), median: [...swapR].sort((a, b) => a - b)[Math.floor(swapR.length / 2)], p95: [...swapR].sort((a, b) => a - b)[Math.floor(swapR.length * 0.95)] },
    price_over_sl_distance: { mean: mean(rows.map((r) => r.perNightPerFraction)) },
    fraction_a: SWAP_FRACTION,
    fraction_b: FRACTION_B,
    markup_low: MARKUP_LOW,
    markup_high: MARKUP_HIGH,
    swap_fraction_c_low_by_year: Object.fromEntries([2015, 2018, 2020, 2021, 2023, 2025, 2026].map((y) => [y, fractionC(Date.UTC(y, 5, 15), MARKUP_LOW)])),
    in_break_entries: rows.filter((r) => closedKind(r.night, "us") !== "open").length,
    ny_offset_check: zoneOffsetMinutes("America/New_York", Date.UTC(2026, 6, 1)),
  };
  writeFileSync("review/results/ftmo-costs.json", JSON.stringify({ meta, results, generated_at: new Date().toISOString() }, null, 1));
  console.log(JSON.stringify(meta, null, 1));
  const line = (k: string): string => {
    const r = results[k] as { label: string; mean_r: number; ci_mean_r: { lower: number; upper: number }; win_rate_pct: number; pf: number; max_dd_pct: number; sr: number; dsr: Record<string, number>; recent_mean_r: number };
    return `${k.padEnd(18)} meanR ${r.mean_r.toFixed(4)} CI [${r.ci_mean_r.lower.toFixed(3)}, ${r.ci_mean_r.upper.toFixed(3)}] SR ${r.sr.toFixed(3)} WR ${r.win_rate_pct.toFixed(1)} PF ${r.pf.toFixed(2)} DD ${r.max_dd_pct.toFixed(1)}% recent ${r.recent_mean_r.toFixed(3)} | DSR n3300/s.06 ${r.dsr["n3300_s0.060"].toFixed(3)} n2000/s.06 ${r.dsr["n2000_s0.060"].toFixed(3)} s.069 ${r.dsr["n3300_s0.069"].toFixed(3)}-${r.dsr["n2000_s0.069"].toFixed(3)} s.044 ${r.dsr["n3300_s0.044"].toFixed(3)}-${r.dsr["n2000_s0.044"].toFixed(3)} n96 ${r.dsr["n96_s0.044"].toFixed(3)}`;
  };
  for (const v of variants) {
    console.log(line(v.key));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
