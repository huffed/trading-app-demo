/**
 * One-off analysis for A2: classify HH-long trades from beyr1223h by
 * range-position at entry. Asks "is there a clean cohort split for
 * HH-longs analogous to the LH-short upper-range gate?"
 */
import * as fs from "fs";
import { loadCorpus } from "./llm-trader-backtest";

const TRADES_PATH = "scripts/llm-trader-trades-anthropic-30m-30d-v3.jsonl";

interface Trade {
  side: "long" | "short";
  entry_price: number;
  entry_date: string;
  realized_pnl: number;
  hold_bars: number;
  entry_regime: string;
  exit_reason: string;
}

(async () => {
  const lines = fs.readFileSync(TRADES_PATH, "utf8").trim().split("\n").filter(Boolean);
  const trades: Trade[] = lines.map((l) => JSON.parse(l));
  const hhLongs = trades.filter((t) => t.entry_regime === "HH" && t.side === "long");

  console.log(`Loading 30m corpus...`);
  const corpus = await loadCorpus("30m");
  const bars = corpus.bars;
  console.log(`Loaded ${bars.length} bars`);
  console.log("");

  console.log(`HH-longs total: ${hhLongs.length}`);
  console.log(`Wins: ${hhLongs.filter((t) => t.realized_pnl > 0).length}`);
  console.log(`Losses: ${hhLongs.filter((t) => t.realized_pnl < 0).length}`);
  console.log(`Total P&L: $${hhLongs.reduce((s, t) => s + t.realized_pnl, 0).toFixed(0)}`);
  console.log("");

  console.log(
    `date             | $pnl   | outcome | hold | range_lo | range_hi | entry   | dist_lo% | dist_hi% | rng_pos%`
  );
  console.log(`-`.repeat(120));

  const rows: Array<{
    date: string;
    pnl: number;
    win: boolean;
    holdBars: number;
    rangeLo: number;
    rangeHi: number;
    entry: number;
    distFromLo: number;
    distFromHi: number;
    rangePos: number;
  }> = [];

  for (const t of hhLongs) {
    const idx = bars.findIndex((b) => b.date === t.entry_date);
    if (idx < 0) {
      console.log(`${t.entry_date}: bar not found`);
      continue;
    }
    const lookback = Math.min(20, idx + 1);
    const window = bars.slice(idx - lookback + 1, idx + 1);
    const hi = Math.max(...window.map((b) => b.high));
    const lo = Math.min(...window.map((b) => b.low));
    const entry = t.entry_price;
    const distFromLo = ((entry - lo) / entry) * 100;
    const distFromHi = ((hi - entry) / entry) * 100;
    const rangePos = ((entry - lo) / (hi - lo)) * 100;
    const win = t.realized_pnl > 0;

    rows.push({
      date: t.entry_date.slice(0, 16),
      pnl: t.realized_pnl,
      win,
      holdBars: t.hold_bars,
      rangeLo: lo,
      rangeHi: hi,
      entry,
      distFromLo,
      distFromHi,
      rangePos,
    });

    console.log(
      `${t.entry_date.slice(0, 16)} | $${t.realized_pnl.toFixed(0).padStart(5)} | ${win ? "WIN " : "LOSS"} | ${String(t.hold_bars).padStart(4)} | ${lo.toFixed(2).padStart(8)} | ${hi.toFixed(2).padStart(8)} | ${entry.toFixed(2).padStart(7)} | ${distFromLo.toFixed(2).padStart(7)} | ${distFromHi.toFixed(2).padStart(7)} | ${rangePos.toFixed(0).padStart(7)}`
    );
  }

  console.log("");
  console.log("Cohort splits — does any threshold cleanly separate W/L?");
  console.log("");

  // Try thresholds on dist_from_lo (mirror of LH-short dist_from_hi)
  console.log("Threshold: dist_from_low (i.e. how far ABOVE the range floor)");
  console.log("(Logic: HH-long winners might be those entering NEAR the low — pullback continuation)");
  console.log("");
  for (const thr of [0.2, 0.3, 0.5, 0.75, 1.0, 1.5, 2.0]) {
    const blocked = rows.filter((r) => r.distFromLo > thr);
    const passed = rows.filter((r) => r.distFromLo <= thr);
    if (blocked.length === 0 || passed.length === 0) continue;
    const blockedWins = blocked.filter((r) => r.win).length;
    const passedWins = passed.filter((r) => r.win).length;
    const blockedPnl = blocked.reduce((s, r) => s + r.pnl, 0);
    const passedPnl = passed.reduce((s, r) => s + r.pnl, 0);
    console.log(
      `dist_lo > ${thr}%: BLOCK ${blocked.length} (${blockedWins}W, $${blockedPnl.toFixed(0)}) | PASS ${passed.length} (${passedWins}W, $${passedPnl.toFixed(0)})`
    );
  }

  console.log("");
  console.log("Threshold: range_position (0% = range_lo, 100% = range_hi)");
  console.log("");
  for (const thr of [15, 20, 25, 28, 30, 32, 35, 40, 50, 65]) {
    const blocked = rows.filter((r) => r.rangePos > thr);
    const passed = rows.filter((r) => r.rangePos <= thr);
    if (blocked.length === 0 || passed.length === 0) continue;
    const blockedWins = blocked.filter((r) => r.win).length;
    const passedWins = passed.filter((r) => r.win).length;
    const blockedPnl = blocked.reduce((s, r) => s + r.pnl, 0);
    const passedPnl = passed.reduce((s, r) => s + r.pnl, 0);
    console.log(
      `range_pos > ${thr}%: BLOCK ${blocked.length} (${blockedWins}W, $${blockedPnl.toFixed(0)}) | PASS ${passed.length} (${passedWins}W, $${passedPnl.toFixed(0)})`
    );
  }

  console.log("");
  console.log("Win-vs-loss distribution stats:");
  const wins = rows.filter((r) => r.win);
  const losses = rows.filter((r) => !r.win);
  const stats = (arr: number[]) => {
    if (arr.length === 0) return "empty";
    const s = [...arr].sort((a, b) => a - b);
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    return `min=${s[0].toFixed(2)} med=${s[Math.floor(s.length / 2)].toFixed(2)} max=${s[s.length - 1].toFixed(2)} mean=${mean.toFixed(2)}`;
  };
  console.log(`  Wins (n=${wins.length}):`);
  console.log(`    dist_from_lo: ${stats(wins.map((r) => r.distFromLo))}`);
  console.log(`    dist_from_hi: ${stats(wins.map((r) => r.distFromHi))}`);
  console.log(`    range_pos:    ${stats(wins.map((r) => r.rangePos))}`);
  console.log(`  Losses (n=${losses.length}):`);
  console.log(`    dist_from_lo: ${stats(losses.map((r) => r.distFromLo))}`);
  console.log(`    dist_from_hi: ${stats(losses.map((r) => r.distFromHi))}`);
  console.log(`    range_pos:    ${stats(losses.map((r) => r.rangePos))}`);
})();
