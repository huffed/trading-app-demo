import { loadDeployedMembers, mean, nominalR, runSiblingAware } from "./lib/harness";
import { CANONICAL_PINS, loadPinnedFile, sessionDaily } from "./lib/pins";
(async () => {
  const h4 = loadPinnedFile(CANONICAL_PINS.h4).bars; const daily = sessionDaily(loadPinnedFile(CANONICAL_PINS.d).bars);
  const run = runSiblingAware(await loadDeployedMembers(), h4, daily, 100_000, { uniformRisk: 0.42 });
  const u = [...run.union].sort((a, b) => a.exit_date.localeCompare(b.exit_date) || a.entry_date.localeCompare(b.entry_date));
  const lag = (R: number[], k: number) => { const m = mean(R); let num = 0, den = 0; for (let i = 0; i < R.length; i++) { den += (R[i] - m) ** 2; if (i >= k) num += (R[i] - m) * (R[i - k] - m); } return num / den; };
  const R = u.map((t) => nominalR(t, 100_000, 0.42));
  // collapse sibling duplicates: same entry bar → one signal (average R)
  const byEntry = new Map<string, number[]>(); for (const t of u) { const k = t.entry_date; byEntry.set(k, [...(byEntry.get(k) ?? []), nominalR(t, 100_000, 0.42)]); }
  const dedup = [...byEntry.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, rs]) => mean(rs));
  console.log(`all trades n=${R.length}: ρ1=${lag(R, 1).toFixed(3)} ρ2=${lag(R, 2).toFixed(3)} | distinct entry bars n=${dedup.length}: ρ1=${lag(dedup, 1).toFixed(3)} ρ2=${lag(dedup, 2).toFixed(3)} ρ3=${lag(dedup, 3).toFixed(3)}; duplicate-entry share ${(100 * (1 - dedup.length / R.length)).toFixed(0)}%`);
  // yearly gold return vs yearly mean R
  const years: number[] = []; for (let y = 2015; y <= 2026; y++) years.push(y);
  const bars = h4; const closeAt = (y: number, end: boolean) => { const arr = bars.filter((b) => b.date.startsWith(String(y))); return end ? arr[arr.length - 1].close : arr[0].open; };
  const rows = years.map((y) => { const f = u.filter((t) => t.entry_date.startsWith(String(y))); return { y, gold_ret: 100 * (closeAt(y, true) / closeAt(y, false) - 1), mean_r: f.length ? mean(f.map((t) => nominalR(t, 100_000, 0.42))) : NaN, n: f.length }; });
  const xs = rows.map((r) => r.gold_ret), ys = rows.map((r) => r.mean_r);
  const mx = mean(xs), my = mean(ys); const corr = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0) * ys.reduce((a, y) => a + (y - my) ** 2, 0));
  console.log(rows.map((r) => `${r.y}: gold ${r.gold_ret.toFixed(0)}% meanR ${r.mean_r.toFixed(2)} n=${r.n}`).join(" | "));
  console.log(`corr(yearly gold return, yearly mean R) = ${corr.toFixed(2)}`);
})();
