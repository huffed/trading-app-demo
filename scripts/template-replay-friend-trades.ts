/**
 * Template-overlap replay against the friend's actual FTMO trades.
 *
 * Tests the exact production multi-TF templates as a unit: at each of
 * his entry timestamps, do the template's conditions fire (with the
 * template's n_of_m logic, direction-aligned to his trade)?
 *
 * Acceptance criterion (`feedback_replay_actual_trades.md`):
 *   ≥30% template hit rate before claiming a clone.
 *
 * Reports per-template:
 *   - hit rate (fired direction-aligned at his entry)
 *   - win rate on hits (does the template's filter improve over baseline?)
 *   - TF-agreement distribution (1/2/3 distinct TFs firing)
 *
 * Run: npx tsx scripts/template-replay-friend-trades.ts
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { fetchDailyPrices } from "../src/lib/market-data/prices";
import type { BarInterval } from "../src/lib/market-data/interval";
import type { PriceBar } from "../src/lib/market-data/types";
import { evaluatePatternCondition } from "../src/lib/patterns/evaluate";
import type { PatternCondition } from "../src/types/algorithm";

// Manual env loader.
{
  try {
    const raw = readFileSync(".env.local", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.replace(/^['"]|['"]$/g, "");
    }
  } catch {
    /* ignore */
  }
}

const REFERENCES_DIR = "funded account references";
const BROKER_TZ_OFFSET_MINUTES = 120;

interface Trade {
  ticket: string;
  openUtc: Date;
  type: "buy" | "sell";
  symbol: string;
  appSymbol: string;
  profit: number;
  isWin: boolean;
}

function brokerTimestampToUtc(raw: string): Date {
  const [date, time] = raw.split(" ");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm, ss] = time.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm, ss) - BROKER_TZ_OFFSET_MINUTES * 60_000);
}

function mt5ToAppSymbol(mt5: string): string {
  const upper = mt5.toUpperCase();
  if (upper.length === 6) return `${upper.slice(0, 3)}/${upper.slice(3)}`;
  return upper;
}

function loadTrades(): Trade[] {
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
      const [ticket, open, type, , symbol, , , , , , , , profit] = cells;
      if (!open || !type || !symbol || seen.has(ticket)) continue;
      seen.add(ticket);
      const profitNum = Number(profit);
      out.push({
        ticket,
        openUtc: brokerTimestampToUtc(open),
        type: type as "buy" | "sell",
        symbol,
        appSymbol: mt5ToAppSymbol(symbol),
        profit: profitNum,
        isWin: profitNum > 0,
      });
    }
  }
  return out.sort((a, b) => a.openUtc.getTime() - b.openUtc.getTime());
}

function findBarIndex(bars: PriceBar[], targetMs: number): number {
  let last = -1;
  for (let i = 0; i < bars.length; i++) {
    const t = new Date(bars[i].date).getTime();
    if (Number.isFinite(t) && t <= targetMs) last = i;
    else break;
  }
  return last;
}

interface Template {
  name: string;
  /** Build the condition list for the given direction (long → bullish). */
  build: (dir: "bullish" | "bearish") => PatternCondition[];
  /** Minimum conditions firing to count as "template fires". */
  n: number;
}

const TEMPLATES: Template[] = [
  // Currently shipped templates — for the baseline.
  {
    name: "multi_tf_engulf_bos",
    n: 2,
    build: (dir) => [
      { type: "pattern", pattern: "daily_bias", direction: dir, ma_period: 20, timeframe: "1d" },
      { type: "pattern", pattern: "engulfing", direction: dir, timeframe: "4h" },
      { type: "pattern", pattern: "bos", lookback: 5, direction: dir, timeframe: "1h" },
    ],
  },
  {
    name: "multi_tf_pin_fvg",
    n: 2,
    build: (dir) => [
      { type: "pattern", pattern: "daily_bias", direction: dir, ma_period: 20, timeframe: "1d" },
      { type: "pattern", pattern: "pin_bar", direction: dir, timeframe: "4h" },
      { type: "pattern", pattern: "fvg", direction: dir, timeframe: "1h" },
    ],
  },
  {
    name: "multi_tf_confluence_5",
    n: 3,
    build: (dir) => [
      { type: "pattern", pattern: "daily_bias", direction: dir, ma_period: 20, timeframe: "1d" },
      { type: "pattern", pattern: "engulfing", direction: dir, timeframe: "4h" },
      { type: "pattern", pattern: "pin_bar", direction: dir, timeframe: "4h" },
      { type: "pattern", pattern: "bos", lookback: 5, direction: dir, timeframe: "1h" },
      { type: "pattern", pattern: "liquidity_sweep", lookback: 5, direction: dir, timeframe: "1h" },
    ],
  },
  // Hypothetical 15m-anchored variants — friend states he enters at
  // 5m/15m, so the actual trigger TF is below the shipped templates'
  // 1h confirmation. Test whether moving the intraday confirmation
  // from 1h → 15m raises the hit rate against his trades.
  {
    name: "v2_15m_engulf_bos",
    n: 2,
    build: (dir) => [
      { type: "pattern", pattern: "daily_bias", direction: dir, ma_period: 20, timeframe: "1d" },
      { type: "pattern", pattern: "engulfing", direction: dir, timeframe: "1h" },
      { type: "pattern", pattern: "bos", lookback: 5, direction: dir, timeframe: "15m" },
    ],
  },
  {
    name: "v2_15m_pin_fvg",
    n: 2,
    build: (dir) => [
      { type: "pattern", pattern: "daily_bias", direction: dir, ma_period: 20, timeframe: "1d" },
      { type: "pattern", pattern: "pin_bar", direction: dir, timeframe: "1h" },
      { type: "pattern", pattern: "fvg", direction: dir, timeframe: "15m" },
    ],
  },
  {
    name: "v2_15m_pure_intraday",
    n: 2,
    build: (dir) => [
      { type: "pattern", pattern: "engulfing", direction: dir, timeframe: "15m" },
      { type: "pattern", pattern: "pin_bar", direction: dir, timeframe: "15m" },
      { type: "pattern", pattern: "bos", lookback: 5, direction: dir, timeframe: "15m" },
      { type: "pattern", pattern: "fvg", direction: dir, timeframe: "15m" },
    ],
  },
  // Momentum-continuation templates — direction-split feature dump
  // showed his wins enter on impulse IN trade direction (longs +0.18
  // ATR, shorts -0.72 ATR median 3-bar). daily_bias provides the
  // trend anchor; momentum is the entry trigger.
  {
    name: "v3_momentum_1h",
    n: 2,
    build: (dir) => [
      { type: "pattern", pattern: "daily_bias", direction: dir, ma_period: 20, timeframe: "1d" },
      { type: "pattern", pattern: "momentum", direction: dir, lookback: 3, timeframe: "1h" },
    ],
  },
  {
    name: "v3_momentum_15m",
    n: 2,
    build: (dir) => [
      { type: "pattern", pattern: "daily_bias", direction: dir, ma_period: 20, timeframe: "1d" },
      { type: "pattern", pattern: "momentum", direction: dir, lookback: 3, timeframe: "15m" },
    ],
  },
  {
    name: "v3_momentum_solo_1h",
    n: 1,
    build: (dir) => [
      { type: "pattern", pattern: "momentum", direction: dir, lookback: 3, timeframe: "1h" },
    ],
  },
];

interface TemplateEval {
  fired: boolean;
  conditionsMet: number;
  conditionsTotal: number;
  firedTfs: number;
  totalTfs: number;
}

function evaluateTemplate(
  template: Template,
  dir: "bullish" | "bearish",
  barsByTf: Map<string, { bars: PriceBar[]; idx: number }>,
  dailyBars: PriceBar[]
): TemplateEval | null {
  const conds = template.build(dir);
  let met = 0;
  const firedByTf = new Set<string>();
  const allTfs = new Set<string>();
  for (const cond of conds) {
    const tf = cond.timeframe.toLowerCase();
    allTfs.add(tf);
    const bundle = barsByTf.get(tf);
    if (!bundle) return null; // missing TF coverage — can't evaluate
    const fired = evaluatePatternCondition(cond, bundle.bars, bundle.idx, dailyBars);
    if (fired) {
      met++;
      firedByTf.add(tf);
    }
  }
  return {
    fired: met >= template.n,
    conditionsMet: met,
    conditionsTotal: conds.length,
    firedTfs: firedByTf.size,
    totalTfs: allTfs.size,
  };
}

async function main() {
  const trades = loadTrades();
  console.log(`Loaded ${trades.length} unique trades.`);

  // Fetch bars per (symbol, interval). Use fetchDailyPrices for fallback.
  const symbols = Array.from(new Set(trades.map((t) => t.appSymbol)));
  const intervals: BarInterval[] = ["1day", "4h", "1h", "15min"];

  console.log(`\nFetching bars for ${symbols.length} symbols × ${intervals.length} intervals...`);
  const symBars = new Map<string, Map<BarInterval, PriceBar[]>>();
  for (const symbol of symbols) {
    const map = new Map<BarInterval, PriceBar[]>();
    symBars.set(symbol, map);
    for (const iv of intervals) {
      try {
        const bars = await fetchDailyPrices(symbol, "full", iv);
        map.set(iv, bars);
        console.log(`  ${symbol} ${iv}: ${bars.length} bars`);
      } catch (err) {
        console.log(`  ${symbol} ${iv}: FAIL (${(err as Error).message})`);
      }
    }
  }

  // Per-template stats
  interface TemplateStats {
    coverable: number;
    fired: number;
    firedWins: number;
    firedLosses: number;
    tfAgreement: Map<number, { trades: number; wins: number }>;
  }
  const stats = new Map<string, TemplateStats>();
  for (const t of TEMPLATES) {
    stats.set(t.name, {
      coverable: 0,
      fired: 0,
      firedWins: 0,
      firedLosses: 0,
      tfAgreement: new Map(),
    });
  }

  for (const trade of trades) {
    const dir: "bullish" | "bearish" = trade.type === "buy" ? "bullish" : "bearish";
    const sb = symBars.get(trade.appSymbol);
    if (!sb) continue;
    const dailyBars = sb.get("1day") ?? [];
    if (dailyBars.length < 30) continue;

    const ms = trade.openUtc.getTime();
    // Build per-TF bundle (bars + idx) for the entry timestamp.
    const tfBundle = new Map<string, { bars: PriceBar[]; idx: number }>();
    const tfIntervalMap: Array<[string, BarInterval]> = [
      ["1d", "1day"],
      ["4h", "4h"],
      ["1h", "1h"],
      ["15m", "15min"],
    ];
    // Add whichever TFs are actually covered for this trade. Templates
    // requiring a TF that's missing return null from evaluateTemplate
    // (won't increment "coverable" for that template) — older trades
    // fall outside Yahoo's 15m / 60d window and the 15m-anchored
    // templates skip them while the 1h-anchored baseline still runs.
    for (const [tfLabel, iv] of tfIntervalMap) {
      const bars = sb.get(iv);
      if (!bars || bars.length < 30) continue;
      const idx = findBarIndex(bars, ms);
      if (idx < 5) continue;
      tfBundle.set(tfLabel, { bars, idx });
    }
    if (tfBundle.size === 0) continue;

    for (const t of TEMPLATES) {
      const ev = evaluateTemplate(t, dir, tfBundle, dailyBars);
      if (!ev) continue;
      const s = stats.get(t.name)!;
      s.coverable++;
      if (ev.fired) {
        s.fired++;
        if (trade.isWin) s.firedWins++;
        else s.firedLosses++;
      }
      const slot = s.tfAgreement.get(ev.firedTfs) ?? { trades: 0, wins: 0 };
      slot.trades++;
      if (trade.isWin) slot.wins++;
      s.tfAgreement.set(ev.firedTfs, slot);
    }
  }

  console.log("\n=== Template hit rate at his entries ===\n");
  console.log("template               coverable  fired  hit%   WR-on-hits  W/L");
  console.log("------------------------------------------------------------------");
  for (const t of TEMPLATES) {
    const s = stats.get(t.name)!;
    const hitPct = s.coverable > 0 ? (s.fired / s.coverable) * 100 : 0;
    const wrHits = s.fired > 0 ? (s.firedWins / s.fired) * 100 : 0;
    const tag = hitPct >= 30 ? "✓" : "✗";
    console.log(
      `${t.name.padEnd(22)} ${String(s.coverable).padStart(8)}  ${String(s.fired).padStart(5)}  ${hitPct.toFixed(1).padStart(4)}%   ${wrHits.toFixed(1).padStart(5)}%   ${s.firedWins}/${s.firedLosses}  ${tag}`
    );
  }
  console.log("\n(✓ ≥30% hit rate — clone-claim threshold from feedback_replay_actual_trades.md)\n");

  console.log("=== TF-agreement distribution per template (over all coverable trades) ===\n");
  for (const t of TEMPLATES) {
    const s = stats.get(t.name)!;
    if (s.coverable === 0) {
      console.log(`${t.name}: no coverage`);
      continue;
    }
    console.log(`${t.name}:`);
    const max = Math.max(...Array.from(s.tfAgreement.keys()));
    for (let n = 0; n <= max; n++) {
      const slot = s.tfAgreement.get(n);
      if (!slot) continue;
      const wr = slot.trades > 0 ? (slot.wins / slot.trades) * 100 : 0;
      console.log(
        `  ${n} TF firing: ${String(slot.trades).padStart(3)} trades, ${slot.wins} wins, WR ${wr.toFixed(1)}%`
      );
    }
    console.log();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
