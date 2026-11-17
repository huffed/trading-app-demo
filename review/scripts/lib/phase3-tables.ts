/**
 * Phase 3 tables: per-period trade statistics, the bias-at-entry split and
 * the age-of-run tables.
 */
import {
  brief,
  maxDdPct,
  meanR,
  pf,
  r2,
  say,
  sumR,
  wr,
  type Brief,
  type Trade,
} from "./phase3-lib";
import type { RunPos } from "./phase3-market";

export type Unions = Record<string, Trade[]>;
export type Annot = (t: Trade) => RunPos;
const AGE_BUCKETS: [number, number, string][] = [
  [1, 2, "1-2"],
  [3, 5, "3-5"],
  [6, 10, "6-10"],
  [11, 20, "11-20"],
  [21, 40, "21-40"],
  [41, 9999, "41+"],
];

export interface PeriodStats extends Brief {
  pf: number;
  max_dd_pct: number;
  zero_months: number;
  longest_gap_days: number;
}
export function periodStats(ts: Trade[], from: string, to: string): PeriodStats {
  const f = ts
    .filter((t) => t.entry_date >= from && t.entry_date < to)
    .sort((a, b) => a.entry_date.localeCompare(b.entry_date));
  const months = new Set<string>();
  for (let d = new Date(from); d.toISOString() < to; d.setUTCMonth(d.getUTCMonth() + 1)) {
    months.add(d.toISOString().slice(0, 7));
  }
  const traded = new Set(f.map((t) => t.entry_date.slice(0, 7)));
  let gap = 0,
    prev = Date.parse(from);
  for (const t of f) {
    gap = Math.max(gap, (Date.parse(t.entry_date) - prev) / 86_400_000);
    prev = Date.parse(t.entry_date);
  }
  gap = Math.max(gap, (Math.min(Date.parse(to), Date.now()) - prev) / 86_400_000);
  return {
    ...brief(f),
    pf: r2(pf(f)),
    max_dd_pct: r2(maxDdPct(f)),
    zero_months: [...months].filter((m) => !traded.has(m)).length,
    longest_gap_days: Math.round(gap),
  };
}
export function fmtRow(label: string, p: PeriodStats): string {
  return `${label.padEnd(8)} n=${String(p.n).padStart(3)} WR=${p.wr.toFixed(1).padStart(5)}% meanR=${p.mean_r.toFixed(3).padStart(7)} sumR=${p.sum_r.toFixed(1).padStart(7)} PF=${String(p.pf).padStart(5)} pnl=$${String(p.pnl).padStart(7)} DD=${p.max_dd_pct.toFixed(1).padStart(5)}% zeroMo=${String(p.zero_months).padStart(2)} gap=${String(p.longest_gap_days).padStart(3)}d`;
}
export const nSum = (b: Brief): string =>
  `${String(b.n).padStart(3)}/${b.sum_r.toFixed(1).padStart(6)}`;

function ageTable(ts: Trade[], label: string, annot: Annot): Record<string, Brief> {
  const out: Record<string, Brief> = {};
  say(`\n== ${label}: by age of the bias run at entry (sessions since the flip; ex ante) ==`);
  for (const [lo, hi, key] of AGE_BUCKETS) {
    const f = ts.filter((t) => {
      const a = annot(t).age;
      return a >= lo && a <= hi;
    });
    out[key] = brief(f);
    say(
      `  age ${key.padEnd(6)} n=${String(f.length).padStart(4)} meanR=${meanR(f).toFixed(3).padStart(7)} sumR=${sumR(f).toFixed(1).padStart(7)} WR=${wr(f).toFixed(1)}%`
    );
  }
  out.run_total_lt15_hindsight = brief(ts.filter((t) => annot(t).total < 15));
  out.run_total_ge15_hindsight = brief(ts.filter((t) => annot(t).total >= 15));
  say(
    `  hindsight: run shorter than 15 sessions ${JSON.stringify(out.run_total_lt15_hindsight)}; 15 or longer ${JSON.stringify(out.run_total_ge15_hindsight)}`
  );
  return out;
}
export function biasSections(
  unions: Unions,
  annot: Annot
): {
  split: Record<string, Record<string, Brief>>;
  ageTables: Record<string, Record<string, Brief>>;
} {
  const split: Record<string, Record<string, Brief>> = {};
  for (const name of ["L_off", "S_off"]) {
    split[name] = {};
    for (const b of ["bullish", "bearish", "neutral"] as const) {
      split[name][b] = brief(unions[name].filter((t) => annot(t).bias === b));
    }
    say(`\n== ${name} trades by SMA20 bias at entry == ${JSON.stringify(split[name])}`);
  }
  const ageTables: Record<string, Record<string, Brief>> = {
    "L_on (bullish runs)": ageTable(unions.L_on, "L_on (bullish runs)", annot),
    "S_on (bearish runs)": ageTable(unions.S_on, "S_on (bearish runs)", annot),
    "L_off under a BEARISH bias (what the filter removes)": ageTable(
      unions.L_off.filter((t) => annot(t).bias === "bearish"),
      "L_off trades entered under a BEARISH bias (what the filter removes)",
      annot
    ),
    "L_off under a BULLISH bias": ageTable(
      unions.L_off.filter((t) => annot(t).bias === "bullish"),
      "L_off trades entered under a BULLISH bias",
      annot
    ),
  };
  return { split, ageTables };
}
