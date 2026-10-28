/**
 * Phase 1.6 — costs. Re-prices the baseline portfolio trades (deployed rules,
 * $100K, sibling-aware) under cost scenarios: the engine's own friction (0.4 bps
 * spread per side + 0.5 bps slippage per fill), the Dukascopy tick-model spread
 * by UTC hour (median and p95; shape transfers across brokers, level is
 * broker-specific — see spread-model-2026-09.json "honesty"), overnight swap on
 * multi-day holds (FTMO's XAUUSD swap not verified online; scenarios −$0.50 and
 * −$1.00 per oz per night, triple on Wednesday), and a $3/lot/side commission
 * scenario. Reproduce: pnpm dlx tsx review/scripts/costs.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dateIndexOf, loadDeployedMembers, mean, nominalR, reconstructGeometry, runSiblingAware } from "./lib/harness";
import { CANONICAL_PINS, loadPinnedFile, sessionDaily } from "./lib/pins";
import type { BacktestTrade } from "../../src/lib/market-data/types";

const RISK = 0.42, CAP = 100_000, H4_MS = 4 * 3600_000;
const model = JSON.parse(readFileSync("scripts/canonical/e2-results/spread-model-2026-09.json", "utf-8")) as { instruments: { XAUUSD: { overall_median_bps: number; overall_p95_bps: number; hours: Array<{ hour_utc: number; median_bps: number; p95_bps: number }> } } };
const hours = new Map(model.instruments.XAUUSD.hours.map((h) => [h.hour_utc, h]));

function nightsHeld(entryCloseMs: number, exitMs: number): { nights: number; wednesdays: number } {
  // rollover at 21:00 UTC (17:00 NY, summer) — count rollovers strictly inside the hold
  let nights = 0, wednesdays = 0;
  const d = new Date(entryCloseMs);
  d.setUTCHours(21, 0, 0, 0);
  if (d.getTime() <= entryCloseMs) d.setUTCDate(d.getUTCDate() + 1);
  for (let t = d.getTime(); t <= exitMs; t += 86_400_000) {
    const dow = new Date(t).getUTCDay();
    if (dow === 6 || dow === 0) continue;
    nights++;
    if (dow === 3) wednesdays++;
  }
  return { nights, wednesdays };
}

async function main() {
  const h4 = loadPinnedFile(CANONICAL_PINS.h4).bars;
  const daily = sessionDaily(loadPinnedFile(CANONICAL_PINS.d).bars);
  const idx = dateIndexOf(h4);
  const members = await loadDeployedMembers();
  const rulesByLabel = new Map(members.map((m) => [m.label, m.rules]));
  const run = runSiblingAware(members, h4, daily, CAP, { uniformRisk: RISK });
  const trades = run.union as Array<BacktestTrade & { algo: string }>;

  const scen = { engine: [] as number[], no_costs: [] as number[], spread_median_by_hour: [] as number[], spread_p95_by_hour: [] as number[], swap_050: [] as number[], swap_100: [] as number[], all_in_median_swap050: [] as number[], all_in_p95_swap100: [] as number[], commission_3_per_lot_side: [] as number[] };
  let holdNights: number[] = [], skipped = 0;
  const costUsd = { engine_friction: 0, spread_median: 0, spread_p95: 0, swap050: 0, swap100: 0, commission: 0 };
  for (const t of trades) {
    const g = reconstructGeometry(t, rulesByLabel.get(t.algo)!, h4, idx);
    if (!g) { skipped++; continue; }
    const riskUsd = ((t.equity_at_entry ?? CAP) * RISK) / 100;
    const qty = riskUsd / g.slDistance; // oz
    const notionalIn = qty * t.entry_price, notionalOut = qty * t.exit_price;
    const engineFriction = (notionalIn + notionalOut) * 0.4e-4 + (notionalIn + notionalOut) * 0.5e-4; // spread per side + slippage per fill
    const grossPnl = t.pnl + engineFriction; // engine pnl is net of its own friction model
    const entryHour = new Date(Date.parse(t.entry_date) + H4_MS).getUTCHours();
    const exitHour = (new Date(t.exit_date).getUTCHours() + 2) % 24; // mid-bar proxy
    const hIn = hours.get(entryHour)!, hOut = hours.get(exitHour)!;
    const spreadMedian = (notionalIn * hIn.median_bps + notionalOut * hOut.median_bps) * 0.5e-4; // half-spread per side
    const spreadP95 = (notionalIn * hIn.p95_bps + notionalOut * hOut.p95_bps) * 0.5e-4;
    const slip = (notionalIn + notionalOut) * 0.5e-4;
    const { nights, wednesdays } = nightsHeld(Date.parse(t.entry_date) + H4_MS, Date.parse(t.exit_date) + H4_MS);
    holdNights.push(nights);
    const swapNights = nights + 2 * wednesdays; // triple swap Wednesday
    const swap050 = qty * 0.5 * swapNights, swap100 = qty * 1.0 * swapNights;
    const commission = 2 * 3 * (qty / 100); // $3 per lot per side
    const r = (p: number) => p / riskUsd;
    scen.engine.push(r(t.pnl));
    scen.no_costs.push(r(grossPnl));
    scen.spread_median_by_hour.push(r(grossPnl - spreadMedian - slip));
    scen.spread_p95_by_hour.push(r(grossPnl - spreadP95 - slip));
    scen.swap_050.push(r(t.pnl - swap050));
    scen.swap_100.push(r(t.pnl - swap100));
    scen.all_in_median_swap050.push(r(grossPnl - spreadMedian - slip - swap050 - commission));
    scen.all_in_p95_swap100.push(r(grossPnl - spreadP95 - slip - swap100 - commission));
    scen.commission_3_per_lot_side.push(r(t.pnl - commission));
    costUsd.engine_friction += engineFriction; costUsd.spread_median += spreadMedian + slip; costUsd.spread_p95 += spreadP95 + slip; costUsd.swap050 += swap050; costUsd.swap100 += swap100; costUsd.commission += commission;
  }
  // period split (regime matters: $-stop widths scale with the gold price → oz per trade → swap $)
  const recentMask = trades.filter((t) => reconstructGeometry(t, rulesByLabel.get(t.algo)!, h4, idx)).map((t) => t.entry_date >= "2025-07-01");
  const split = (arr: number[]) => ({ all: mean(arr), recent: mean(arr.filter((_, i) => recentMask[i])), older: mean(arr.filter((_, i) => !recentMask[i])) });
  console.log(`\nperiod split (mean R): recent = entries since 2025-07-01 (n=${recentMask.filter(Boolean).length}), older (n=${recentMask.filter((x) => !x).length})`);
  for (const [k, v] of Object.entries(scen)) { const sp = split(v); console.log(`  ${k.padEnd(30)} all ${sp.all.toFixed(4)}  recent ${sp.recent.toFixed(4)}  older ${sp.older.toFixed(4)}`); }
  const n = scen.engine.length;
  const summary: Record<string, { mean_r: number; delta_vs_engine_r: number; total_r: number }> = {};
  for (const [k, v] of Object.entries(scen)) summary[k] = { mean_r: mean(v), delta_vs_engine_r: mean(v) - mean(scen.engine), total_r: v.reduce((a, b) => a + b, 0) };
  console.log(`baseline union (deployed, $100K, sibling-aware): n=${n} (geometry unresolved for ${skipped})`);
  console.log(`hold nights: mean ${mean(holdNights).toFixed(2)}, share ≥1 night ${(100 * holdNights.filter((x) => x >= 1).length / n).toFixed(0)}%, ≥5 nights ${(100 * holdNights.filter((x) => x >= 5).length / n).toFixed(0)}%`);
  console.log(`tick-model spread: overall median ${model.instruments.XAUUSD.overall_median_bps.toFixed(2)} bps, p95 ${model.instruments.XAUUSD.overall_p95_bps.toFixed(2)} bps (engine assumes 0.8 bps round trip); by hour (median bps): ` + [...hours.values()].map((h) => `${h.hour_utc}:${h.median_bps.toFixed(2)}`).join(" "));
  console.log("\nscenario".padEnd(32) + "mean R".padStart(9) + "Δ vs engine".padStart(13) + "   total cost $ over 2015→2026 (per $100K pool)");
  const costFor: Record<string, number> = { engine: costUsd.engine_friction, no_costs: 0, spread_median_by_hour: costUsd.spread_median, spread_p95_by_hour: costUsd.spread_p95, swap_050: costUsd.engine_friction + costUsd.swap050, swap_100: costUsd.engine_friction + costUsd.swap100, all_in_median_swap050: costUsd.spread_median + costUsd.swap050 + costUsd.commission, all_in_p95_swap100: costUsd.spread_p95 + costUsd.swap100 + costUsd.commission, commission_3_per_lot_side: costUsd.engine_friction + costUsd.commission };
  for (const [k, s] of Object.entries(summary)) console.log(k.padEnd(32) + s.mean_r.toFixed(4).padStart(9) + (s.delta_vs_engine_r >= 0 ? "+" : "").concat(s.delta_vs_engine_r.toFixed(4)).padStart(13) + `   $${costFor[k].toFixed(0)}`);
  writeFileSync("review/results/costs.json", JSON.stringify({ n, summary, cost_usd: costUsd, hold_nights: { mean: mean(holdNights), p50: holdNights.sort((a, b) => a - b)[Math.floor(n / 2)] }, generated_at: new Date().toISOString() }, null, 1));
  console.log("→ review/results/costs.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
