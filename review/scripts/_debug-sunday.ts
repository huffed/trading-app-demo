import { loadDeployedMembers, runSiblingAware } from "./lib/harness";
import { CANONICAL_PINS, loadPinnedFile, sessionDaily } from "./lib/pins";
(async () => {
  const h4 = loadPinnedFile(CANONICAL_PINS.h4).bars; const daily = sessionDaily(loadPinnedFile(CANONICAL_PINS.d).bars);
  const members = await loadDeployedMembers();
  const run = runSiblingAware(members, h4, daily, 100_000, { uniformRisk: 0.42 });
  const u = run.union as Array<{ entry_date: string; algo: string; pnl: number }>;
  const isSundayOpen = (d: string) => { const x = new Date(d); return x.getUTCDay() === 0 && x.getUTCHours() >= 21; };
  const sun = u.filter((t) => isSundayOpen(t.entry_date));
  const byAlgo: Record<string, number> = {}; for (const t of sun) byAlgo[t.algo] = (byAlgo[t.algo] ?? 0) + 1;
  console.log(`union n=${u.length}; signals on the Sunday-open bar (21:00/22:00 UTC): ${sun.length} (${(100 * sun.length / u.length).toFixed(1)}%), pnl share ${(100 * sun.reduce((a, t) => a + t.pnl, 0) / u.reduce((a, t) => a + t.pnl, 0)).toFixed(1)}%`, byAlgo);
})();
