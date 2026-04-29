/**
 * Compute the friend's actual P&L from his FTMO trade CSV. Anchors
 * expectations: "what does this style actually deliver?" so we know
 * whether our 0.77%/mo calibrated walk-forward is competitive,
 * conservative, or way under reality.
 *
 * Output:
 *   - Total P&L
 *   - Date range
 *   - Win/loss/WR
 *   - Per-symbol breakdown
 *   - Implied monthly return at common FTMO account sizes ($10K, $25K,
 *     $50K, $100K, $200K) so we can spot which one he was on
 *   - Rolling max drawdown (P&L curve from zero)
 *
 * Run: npx tsx scripts/friend-pnl-summary.ts
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const REFERENCES_DIR = "funded account references";

interface Trade {
  ticket: string;
  openUtc: Date;
  closeUtc: Date;
  type: "buy" | "sell";
  symbol: string;
  volume: number;
  profit: number;
  swap: number;
  commission: number;
  net: number;
  pips: number;
  durationSec: number;
}

function parseTrades(): Trade[] {
  const dir = join(process.cwd(), REFERENCES_DIR);
  const files = readdirSync(dir).filter((f) => f.endsWith(".csv"));
  const out: Trade[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    for (let i = 1; i < lines.length; i++) {
      const cells: string[] = [];
      let cur = "";
      let inQuote = false;
      for (const ch of lines[i]) {
        if (ch === '"') {
          inQuote = !inQuote;
          continue;
        }
        if (ch === "," && !inQuote) {
          cells.push(cur);
          cur = "";
          continue;
        }
        cur += ch;
      }
      cells.push(cur);
      if (cells.length < 14) continue;
      const [
        ticket,
        open,
        type,
        volume,
        symbol,
        ,
        ,
        ,
        close,
        ,
        swap,
        commission,
        profit,
        pips,
        duration,
      ] = cells;
      if (!ticket || seen.has(ticket)) continue;
      seen.add(ticket);
      const profitNum = Number(profit) || 0;
      const swapNum = Number(swap) || 0;
      const commissionNum = Number(commission) || 0;
      out.push({
        ticket,
        openUtc: new Date(open + "Z"),
        closeUtc: new Date(close + "Z"),
        type: type as "buy" | "sell",
        symbol,
        volume: Number(volume) || 0,
        profit: profitNum,
        swap: swapNum,
        commission: commissionNum,
        net: profitNum + swapNum + commissionNum,
        pips: Number(pips) || 0,
        durationSec: Number(duration) || 0,
      });
    }
  }
  return out.sort((a, b) => a.openUtc.getTime() - b.openUtc.getTime());
}

function fmt(n: number): string {
  return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
}

function pct(n: number): string {
  return `${n.toFixed(2)}%`;
}

function main() {
  const trades = parseTrades();
  if (trades.length === 0) {
    console.log("No trades parsed.");
    return;
  }

  const wins = trades.filter((t) => t.net > 0);
  const losses = trades.filter((t) => t.net <= 0);
  const totalNet = trades.reduce((s, t) => s + t.net, 0);
  const totalGross = trades.reduce((s, t) => s + t.profit, 0);
  const totalCommissions = trades.reduce((s, t) => s + t.commission, 0);
  const totalSwaps = trades.reduce((s, t) => s + t.swap, 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.net, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.net, 0) / losses.length : 0;
  const biggestWin = wins.reduce((m, t) => Math.max(m, t.net), 0);
  const biggestLoss = losses.reduce((m, t) => Math.min(m, t.net), 0);

  const start = trades[0].openUtc;
  const end = trades[trades.length - 1].closeUtc;
  const days = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  const months = days / 30;

  console.log(`Friend's actual trade history`);
  console.log(`========================================\n`);
  console.log(`Period       : ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)} (${days.toFixed(0)} days, ${months.toFixed(1)} months)`);
  console.log(`Trades       : ${trades.length} (${wins.length} wins, ${losses.length} losses)`);
  console.log(`Win rate     : ${pct((wins.length / trades.length) * 100)}\n`);

  console.log(`P&L`);
  console.log(`  Gross P&L  : ${fmt(totalGross)}`);
  console.log(`  Commission : ${fmt(totalCommissions)}`);
  console.log(`  Swap       : ${fmt(totalSwaps)}`);
  console.log(`  Net P&L    : ${fmt(totalNet)}\n`);

  console.log(`Trade dynamics`);
  console.log(`  Avg win    : ${fmt(avgWin)}`);
  console.log(`  Avg loss   : ${fmt(avgLoss)}`);
  console.log(`  Biggest win: ${fmt(biggestWin)}`);
  console.log(`  Biggest L  : ${fmt(biggestLoss)}`);
  if (avgLoss !== 0) {
    console.log(`  Win/loss   : ${(Math.abs(avgWin / avgLoss)).toFixed(2)}× (avg-win-to-avg-loss ratio)`);
  }
  console.log();

  console.log(`Per-symbol breakdown`);
  const bySymbol = new Map<string, { count: number; wins: number; net: number }>();
  for (const t of trades) {
    const slot = bySymbol.get(t.symbol) ?? { count: 0, wins: 0, net: 0 };
    slot.count++;
    if (t.net > 0) slot.wins++;
    slot.net += t.net;
    bySymbol.set(t.symbol, slot);
  }
  for (const [sym, s] of bySymbol) {
    const wr = (s.wins / s.count) * 100;
    console.log(`  ${sym.padEnd(8)} ${String(s.count).padStart(3)} trades  WR ${wr.toFixed(0)}%  net ${fmt(s.net)}`);
  }
  console.log();

  // Implied returns at common FTMO account sizes
  console.log(`Implied monthly return per account size:`);
  const accountSizes = [10_000, 25_000, 50_000, 100_000, 200_000];
  for (const acc of accountSizes) {
    const totalReturnPct = (totalNet / acc) * 100;
    const monthlyPct = totalReturnPct / Math.max(months, 0.1);
    console.log(`  $${acc.toLocaleString().padStart(8)}: total ${pct(totalReturnPct).padStart(7)}, monthly ${pct(monthlyPct).padStart(7)}`);
  }
  console.log();

  // Rolling drawdown
  let runningPnl = 0;
  let peak = 0;
  let maxDdAbs = 0;
  for (const t of trades) {
    runningPnl += t.net;
    if (runningPnl > peak) peak = runningPnl;
    const dd = peak - runningPnl;
    if (dd > maxDdAbs) maxDdAbs = dd;
  }
  console.log(`Drawdown`);
  console.log(`  Max DD (abs): ${fmt(-maxDdAbs)}`);
  for (const acc of accountSizes) {
    console.log(`  Max DD vs $${acc.toLocaleString().padStart(7)}: ${pct((maxDdAbs / acc) * 100)}`);
  }
}

main();
