/**
 * Phase 1.8 — parameter sensitivity. Perturbs each deployed algo's parameters
 * one at a time (solo runs, $100K, pinned H4 2015→2026-07-09) and reports n,
 * mean R, WR, pnl. A real edge degrades smoothly; a fitted one falls off a
 * cliff. Reproduce: pnpm dlx tsx review/scripts/param-sensitivity.ts
 */
import { writeFileSync } from "node:fs";
import { loadDeployedMembers, mean, nominalR, runSiblingAware, type Member } from "./lib/harness";
import { CANONICAL_PINS, loadPinnedFile, sessionDaily } from "./lib/pins";
import type { AlgorithmRules } from "../../src/types/algorithm";

const RISK = 0.42, CAP = 100_000;
type Variant = { tag: string; rules: AlgorithmRules };

function variants(m: Member): Variant[] {
  const r = m.rules;
  const out: Variant[] = [{ tag: "base", rules: r }];
  const lb = r.stop_loss.lookback ?? 4;
  for (const d of [-2, -1, 1, 2]) if (lb + d >= 1) out.push({ tag: `lookback ${lb + d}`, rules: { ...r, stop_loss: { ...r.stop_loss, lookback: lb + d } } });
  const rr = r.take_profit.type === "rr_multiple" ? r.take_profit.value : 3;
  for (const d of [-1, -0.5, 0.5, 1]) if (rr + d >= 1) out.push({ tag: `rr ${rr + d}`, rules: { ...r, take_profit: { ...r.take_profit, value: rr + d } } });
  for (const v of [0.0, 0.05, 0.2]) out.push({ tag: `atr_buffer ${v}`, rules: { ...r, stop_loss: { ...r.stop_loss, value: v } } });
  for (const p of [15, 25, 30]) out.push({ tag: `sma ${p}`, rules: { ...r, entry_conditions: r.entry_conditions.map((c) => ((c as { pattern?: string }).pattern === "daily_bias" ? { ...c, ma_period: p } : c)) as AlgorithmRules["entry_conditions"] } });
  if (r.regime_filter?.enabled) for (const f of [0.2, 0.4]) out.push({ tag: `regime_floor ${f}`, rules: { ...r, regime_filter: { ...r.regime_filter, percentile_floor: f } } });
  if (r.adx_filter?.enabled) for (const a of [15, 25]) out.push({ tag: `adx_min ${a}`, rules: { ...r, adx_filter: { ...r.adx_filter, min_adx: a } } });
  if (r.regime_filter?.enabled) out.push({ tag: "regime_filter OFF", rules: { ...r, regime_filter: { ...r.regime_filter, enabled: false } } });
  if (r.adx_filter?.enabled) out.push({ tag: "adx_filter OFF", rules: { ...r, adx_filter: { ...r.adx_filter, enabled: false } } });
  out.push({ tag: "daily_bias OFF", rules: { ...r, entry_conditions: r.entry_conditions.filter((c) => (c as { pattern?: string }).pattern !== "daily_bias") as AlgorithmRules["entry_conditions"] } });
  return out;
}

async function main() {
  const h4 = loadPinnedFile(CANONICAL_PINS.h4).bars;
  const daily = sessionDaily(loadPinnedFile(CANONICAL_PINS.d).bars);
  const members = await loadDeployedMembers();
  const results: Record<string, Array<{ tag: string; n: number; mean_r: number; wr_pct: number; pnl: number }>> = {};
  for (const m of members) {
    results[m.label] = [];
    console.log(`\n== ${m.label} ==`);
    for (const v of variants(m)) {
      const run = runSiblingAware([{ label: m.label, rules: v.rules }], h4, daily, CAP, { uniformRisk: RISK, siblingBlocking: false, riskPool: false, portfolioHalt: false, spreadGate: false, reEntryCooldown: false });
      const tr = run.soloTrades.get(m.label)!;
      const rs = tr.map((t) => nominalR(t, CAP, RISK));
      const row = { tag: v.tag, n: tr.length, mean_r: mean(rs), wr_pct: tr.length ? (100 * tr.filter((t) => t.pnl > 0).length) / tr.length : 0, pnl: tr.reduce((a, t) => a + t.pnl, 0) };
      results[m.label].push(row);
      console.log(`  ${v.tag.padEnd(20)} n=${String(row.n).padStart(4)} meanR=${row.mean_r.toFixed(4)} WR=${row.wr_pct.toFixed(1)}% pnl=$${row.pnl.toFixed(0)}`);
    }
  }
  writeFileSync("review/results/param-sensitivity.json", JSON.stringify({ capital: CAP, risk: RISK, results, generated_at: new Date().toISOString() }, null, 1));
  console.log("\n→ review/results/param-sensitivity.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
