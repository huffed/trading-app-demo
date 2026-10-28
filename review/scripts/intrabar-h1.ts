/**
 * Phase 1.2 — intrabar resolution. For every baseline trade (deployed rules,
 * $100K, solo runs on pinned H4), reconstruct the engine's SL/TP and replay
 * the exit on H1 bars: which level is touched first? How often do SL and TP
 * both sit inside one 4h bar (where the engine assumes stop-wins-ties) or one
 * H1 bar (still ambiguous)? Mean R under the engine's rule vs H1-pessimistic
 * vs H1-optimistic. Reproduce: pnpm dlx tsx review/scripts/intrabar-h1.ts
 */
import { writeFileSync } from "node:fs";
import { dateIndexOf, loadDeployedMembers, mean, nominalR, reconstructGeometry, runSiblingAware } from "./lib/harness";
import { CANONICAL_PINS, REVIEW_PINS, loadPinnedFile, mergeBars, sessionDaily } from "./lib/pins";
import type { BacktestTrade, PriceBar } from "../../src/lib/market-data/types";

const RISK = 0.42, CAP = 100_000;
const H4_MS = 4 * 3600_000;

type Res = "sl" | "tp" | "ambiguous" | "none";
function walkH1(h1: PriceBar[], startMs: number, sl: number, tp: number, side: "long" | "short", maxMs: number): { res: Res; at?: string; ambiguousBars: number } {
  let i = h1.findIndex((b) => Date.parse(b.date) >= startMs);
  if (i < 0) return { res: "none", ambiguousBars: 0 };
  let ambiguousBars = 0;
  for (; i < h1.length; i++) {
    const b = h1[i];
    if (Date.parse(b.date) > maxMs) break;
    const hitSl = side === "long" ? b.low <= sl : b.high >= sl;
    const hitTp = side === "long" ? b.high >= tp : b.low <= tp;
    if (hitSl && hitTp) { ambiguousBars++; return { res: "ambiguous", at: b.date, ambiguousBars }; }
    if (hitSl) return { res: "sl", at: b.date, ambiguousBars };
    if (hitTp) return { res: "tp", at: b.date, ambiguousBars };
  }
  return { res: "none", ambiguousBars };
}

async function main() {
  const h4 = loadPinnedFile(CANONICAL_PINS.h4).bars;
  const daily = sessionDaily(loadPinnedFile(CANONICAL_PINS.d).bars);
  const h1 = mergeBars(loadPinnedFile(CANONICAL_PINS.h1).bars, loadPinnedFile(REVIEW_PINS.h1).bars);
  const idx = dateIndexOf(h4);
  const members = await loadDeployedMembers();
  const run = runSiblingAware(members, h4, daily, CAP, { uniformRisk: RISK });
  const out: Record<string, unknown> = {};
  let totals = { n: 0, slOrTp: 0, same4hBar: 0, h1Ambiguous: 0, disagree: 0, noGeom: 0 };
  const rEngine: number[] = [], rPess: number[] = [], rOpt: number[] = [];
  const perAlgo: Record<string, unknown> = {};
  for (const m of members) {
    const trades = run.soloTrades.get(m.label)!;
    const rr = m.rules.take_profit?.type === "rr_multiple" ? m.rules.take_profit.value : 3;
    let c = { n: trades.length, slOrTp: 0, same4hBar: 0, h1Ambiguous: 0, disagree: 0, noGeom: 0, engineTp: 0, h1Tp: 0 };
    for (const t of trades) {
      const g = reconstructGeometry(t, m.rules, h4, idx);
      if (!g) { c.noGeom++; continue; }
      const isPriceExit = t.exit_reason === "stop_loss_hit" || t.exit_reason === "take_profit_hit";
      if (!isPriceExit) continue;
      c.slOrTp++;
      // engine R in nominal terms, and the counterfactuals as ±rr / −1
      const rE = nominalR(t, CAP, RISK);
      rEngine.push(rE);
      // The engine records exit_date as a DATE (YYYY-MM-DD) while entry_date is
      // the signal bar's ISO timestamp — find the exit 4h bar as the first bar
      // after entry, on or before the end of the exit day, that touches a level.
      const startMs = Date.parse(t.entry_date) + H4_MS; // entry at the signal bar's close
      const exitDayEndMs = Date.parse(t.exit_date.length === 10 ? `${t.exit_date}T23:59:59Z` : t.exit_date) + H4_MS;
      let exitBarIdx = -1;
      for (let j = g.idx + 1; j < h4.length && Date.parse(h4[j].date) <= exitDayEndMs; j++) {
        const b = h4[j];
        const hitSl = t.side === "long" ? b.low <= g.sl : b.high >= g.sl;
        const hitTp = t.side === "long" ? b.high >= g.tp : b.low <= g.tp;
        if (hitSl || hitTp) { exitBarIdx = j; if (hitSl && hitTp) c.same4hBar++; break; }
      }
      const maxMs = exitBarIdx >= 0 ? Date.parse(h4[exitBarIdx].date) + H4_MS : exitDayEndMs;
      const w = walkH1(h1, startMs, g.sl, g.tp, t.side, maxMs);
      const engineRes: Res = t.exit_reason === "take_profit_hit" ? "tp" : "sl";
      if (engineRes === "tp") c.engineTp++;
      if (w.res === "ambiguous") { c.h1Ambiguous++; rPess.push(-1); rOpt.push(rr); }
      else if (w.res === "none") { rPess.push(rE); rOpt.push(rE); }
      else { if (w.res === "tp") c.h1Tp++; if (w.res !== engineRes) c.disagree++; rPess.push(w.res === "tp" ? rr : -1); rOpt.push(w.res === "tp" ? rr : -1); }
    }
    perAlgo[m.label] = c;
    totals = { n: totals.n + c.n, slOrTp: totals.slOrTp + c.slOrTp, same4hBar: totals.same4hBar + c.same4hBar, h1Ambiguous: totals.h1Ambiguous + c.h1Ambiguous, disagree: totals.disagree + c.disagree, noGeom: totals.noGeom + c.noGeom };
    console.log(`${m.label.padEnd(24)} n=${c.n} price-exits=${c.slOrTp} both-levels-in-exit-4h-bar=${c.same4hBar} H1-ambiguous=${c.h1Ambiguous} H1-disagrees-with-engine=${c.disagree} engineTP=${c.engineTp} h1TP=${c.h1Tp} noGeom=${c.noGeom}`);
  }
  console.log(`\nTOTAL price-exits=${totals.slOrTp}: SL&TP inside the same 4h exit bar ${totals.same4hBar} (${(100 * totals.same4hBar / totals.slOrTp).toFixed(1)}%); still ambiguous at H1 ${totals.h1Ambiguous} (${(100 * totals.h1Ambiguous / totals.slOrTp).toFixed(1)}%); H1 first-touch disagrees with engine ${totals.disagree} (${(100 * totals.disagree / totals.slOrTp).toFixed(1)}%)`);
  console.log(`mean R (nominal, price-exits only): engine ${mean(rEngine).toFixed(4)} | H1-resolved pessimistic ${mean(rPess).toFixed(4)} | H1-resolved optimistic ${mean(rOpt).toFixed(4)}  (counterfactuals use ±rr/−1 gross R, so compare the SPREAD not the level)`);
  out.per_algo = perAlgo; out.totals = totals; out.mean_r = { engine: mean(rEngine), h1_pessimistic: mean(rPess), h1_optimistic: mean(rOpt) };
  out.meta = { capital: CAP, risk: RISK, h1_bars: h1.length, h1_last: h1[h1.length - 1].date, generated_at: new Date().toISOString() };
  writeFileSync("review/results/intrabar-h1.json", JSON.stringify(out, null, 1));
  console.log("→ review/results/intrabar-h1.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
