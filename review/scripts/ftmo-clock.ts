/**
 * FTMO item 3 — the platform clock and the commission, tested against FTMO fills on this machine.
 * Input: "funded account references/*.csv", the operator's friend's MT5 journal (gitignored; this script prints
 * counts only and writes nothing). Times in the journal are platform time.
 * Read with M30 pins: a trade's price must lie inside the M30 bar of its timestamp at the true offset.
 * Reproduce (needs the local CSVs): pnpm exec tsx review/scripts/ftmo-clock.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PriceBar } from "../../src/lib/market-data/types";
import { loadPinnedFile } from "./lib/pins";

const DIR = "funded account references";
const PINS: Record<string, string> = {
  XAUUSD: "scripts/canonical/data/xau-usd-m30-pinned.json",
  EURUSD: "scripts/canonical/data/eur-usd-m30-pinned.json",
  GBPUSD: "scripts/canonical/data/gbp-usd-m30-pinned.json",
  USDJPY: "scripts/canonical/data/usd-jpy-m30-pinned.json",
};
const SLACK: Record<string, number> = { XAUUSD: 1.0, EURUSD: 0.0003, GBPUSD: 0.0003, USDJPY: 0.03 };

interface Trade {
  open: number;
  close: number;
  symbol: string;
  lots: number;
  openPrice: number;
  closePrice: number;
  commission: number;
}

function parseTime(raw: string): number {
  const [d, t] = raw.split(" ");
  const [y, m, dd] = d.split("-").map(Number);
  const [h, mi, s] = t.split(":").map(Number);
  return Date.UTC(y, m - 1, dd, h, mi, s);
}

function parseRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted;
    } else if (ch === "," && !quoted) {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function loadTrades(): Trade[] {
  const seen = new Set<string>();
  const out: Trade[] = [];
  for (const f of readdirSync(resolve(process.cwd(), DIR)).filter((x) => x.endsWith(".csv"))) {
    const lines = readFileSync(resolve(process.cwd(), DIR, f), "utf-8").split(/\r?\n/).filter((l) => l.trim());
    for (const line of lines.slice(1)) {
      const c = parseRow(line);
      if (seen.has(c[0]) || !/^\d{4}-/.test(c[1] ?? "")) {
        continue;
      }
      seen.add(c[0]);
      out.push({
        open: parseTime(c[1]),
        close: parseTime(c[8]),
        symbol: c[4].replace(/[^A-Z]/g, "").slice(0, 6),
        lots: Number(c[3]),
        openPrice: Number(c[5]),
        closePrice: Number(c[9]),
        commission: Math.abs(Number(c[11])),
      });
    }
  }
  return out;
}

function inside(bars: Map<number, PriceBar>, ms: number, price: number, slack: number): boolean | null {
  const bar = bars.get(Math.floor(ms / 1_800_000) * 1_800_000);
  return bar ? price >= bar.low - slack && price <= bar.high + slack : null;
}

function main(): void {
  const trades = loadTrades();
  const bars = Object.fromEntries(
    Object.entries(PINS).map(([s, f]) => [s, new Map(loadPinnedFile(f).bars.map((b) => [Date.parse(b.date), b]))])
  );
  const gold = trades.filter((t) => t.symbol === "XAUUSD");
  for (const off of [0, 1, 2, 3]) {
    const fits = gold.filter((t) => {
      const a = inside(bars.XAUUSD, t.open - off * 3_600_000, t.openPrice, SLACK.XAUUSD);
      const b = inside(bars.XAUUSD, t.close - off * 3_600_000, t.closePrice, SLACK.XAUUSD);
      return a === true && b === true;
    });
    console.log(`gold, GMT+${off}: ${fits.length} of ${gold.length} trades have both prices inside their bars`);
  }
  const marginWeek = trades.filter((t) => t.open >= Date.UTC(2026, 2, 8) && t.open < Date.UTC(2026, 2, 29));
  for (const off of [2, 3]) {
    let legs = 0;
    let inLegs = 0;
    for (const t of marginWeek) {
      const b = bars[t.symbol];
      for (const [ms, price] of [[t.open, t.openPrice], [t.close, t.closePrice]] as const) {
        legs++;
        if (b && inside(b, ms - off * 3_600_000, price, SLACK[t.symbol]) === true) {
          inLegs++;
        }
      }
    }
    console.log(`week(s) of 8-29 March 2026, GMT+${off}: ${inLegs} of ${legs} legs inside (${marginWeek.length} trades)`);
  }
  const exact = gold.filter((t) => Math.abs(t.commission - t.lots * 100 * t.openPrice * 0.000014) < 0.0101).length;
  console.log(`commission equals 0.0014% of entry notional: ${exact} of ${gold.length} gold trades`);
}

main();
