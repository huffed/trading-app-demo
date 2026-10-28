import { dateIndexOf, loadDeployedMembers, reconstructGeometry, runSiblingAware } from "./lib/harness";
import { CANONICAL_PINS, REVIEW_PINS, loadPinnedFile, mergeBars, sessionDaily } from "./lib/pins";
(async () => {
  const h4 = loadPinnedFile(CANONICAL_PINS.h4).bars; const daily = sessionDaily(loadPinnedFile(CANONICAL_PINS.d).bars);
  const h1 = mergeBars(loadPinnedFile(CANONICAL_PINS.h1).bars, loadPinnedFile(REVIEW_PINS.h1).bars);
  const idx = dateIndexOf(h4); const members = await loadDeployedMembers();
  const m = members[4]; const run = runSiblingAware([m], h4, daily, 100_000, { uniformRisk: 0.42, siblingBlocking:false, riskPool:false, portfolioHalt:false, spreadGate:false, reEntryCooldown:false });
  const tr = run.soloTrades.get(m.label)!.slice(0, 6);
  for (const t of tr) {
    const g = reconstructGeometry(t, m.rules, h4, idx)!;
    const exitIdx = idx.get(t.exit_date); const eb = exitIdx !== undefined ? h4[exitIdx] : null;
    const startMs = Date.parse(t.entry_date) + 4*3600_000; const maxMs = Date.parse(t.exit_date) + 4*3600_000;
    const win = h1.filter((b) => Date.parse(b.date) >= startMs && Date.parse(b.date) <= maxMs);
    const touchSl = win.find((b) => b.low <= g.sl), touchTp = win.find((b) => b.high >= g.tp);
    console.log(`${t.entry_date} → ${t.exit_date} ${t.exit_reason} entry=${t.entry_price.toFixed(2)} exit=${t.exit_price.toFixed(2)} | recon SLd=${g.slDistance.toFixed(2)} SL=${g.sl.toFixed(2)} TP=${g.tp.toFixed(2)} | exit4h L/H=${eb?.low}/${eb?.high} | h1 in window=${win.length} firstSL=${touchSl?.date ?? "-"} firstTP=${touchTp?.date ?? "-"}`);
  }
})();
