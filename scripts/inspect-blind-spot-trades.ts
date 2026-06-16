/* eslint-disable no-console */
/**
 * S1.5 priority #4 — investigate the 24% blind spot.
 *
 * Per project_friend_replay_2026_06, 9 of friend's 38 FTMO trades (24%)
 * had ZERO of our 8 pattern primitives fire in his direction at entry.
 * 3 winners + 6 losers. The roadmap question: what was he reading on
 * those trades that we don't detect?
 *
 * This script extends `replay-friend-trades.ts`: for each trade where
 * `allPrimitivesAlignedCount === 0`, dump rich context (entry bar +
 * surrounding 10 bars + daily context + structural notes) so the
 * operator can manually decide whether a missing-detector hypothesis
 * is worth building.
 *
 * Computed structural features per trade (not classified yet — we
 * surface raw data, let the inspector pattern-match):
 *   - Distance to nearest psychological "round" level (00 / 50 increments)
 *   - Recent 1h ATR + 1h ATR percentile (was vol low/high?)
 *   - Recent 24h high/low/range — was entry near a 24h extreme?
 *   - Daily VWAP-ish (rolling 24h OHLC4 mean) — was entry above/below?
 *   - Session boundary distance (was entry within ±1h of London / NY open?)
 *   - Entry vs prior 5-bar range (mid / extreme / breakout)
 *
 * Output:
 *   scripts/inspect-blind-spot-trades-<stamp>.json (raw)
 *   stdout: per-trade context blocks for manual inspection
 *
 * Usage:
 *   pnpm dlx tsx scripts/inspect-blind-spot-trades.ts
 */
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { detectBos } from "../src/lib/patterns/bos";
import { detectChoch } from "../src/lib/patterns/choch";
import { detectDailyBias } from "../src/lib/patterns/daily-bias";
import { detectEqualLevels } from "../src/lib/patterns/equal-levels";
import { detectFvg } from "../src/lib/patterns/fvg";
import { detectLiquiditySweep } from "../src/lib/patterns/liquidity-sweep";
import { detectOrderBlock } from "../src/lib/patterns/order-block";
import { detectOte } from "../src/lib/patterns/ote";
import { loadCorpus } from "./llm-trader-backtest";

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
  volume: number;
  symbol: string;
  appSymbol: string;
  openPrice: number;
  profit: number;
  durationSec: number;
  isWin: boolean;
}

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    for (let i = 1; i < lines.length; i++) {
      const cells: string[] = [];
      let cur = "";
      let inQuote = false;
      for (const ch of lines[i]) {
        if (ch === '"') { inQuote = !inQuote; continue; }
        if (ch === "," && !inQuote) { cells.push(cur); cur = ""; continue; }
        cur += ch;
      }
      cells.push(cur);
      if (cells.length < 14) continue;
      const [ticket, open, type, volume, symbol, price, , , , , , , profit, , duration] = cells;
      if (!open || !type || !symbol) continue;
      const profitNum = Number(profit);
      out.push({
        ticket,
        openUtc: brokerTimestampToUtc(open),
        type: type as "buy" | "sell",
        volume: Number(volume),
        symbol,
        appSymbol: mt5ToAppSymbol(symbol),
        openPrice: Number(price),
        profit: profitNum,
        durationSec: Number(duration),
        isWin: profitNum > 0,
      });
    }
  }
  return out.sort((a, b) => a.openUtc.getTime() - b.openUtc.getTime());
}

function findBarIndex(bars: Bar[], targetMs: number): number {
  let last = -1;
  for (let i = 0; i < bars.length; i++) {
    const t = new Date(bars[i].date).getTime();
    if (Number.isFinite(t) && t <= targetMs) last = i;
    else break;
  }
  return last;
}

function aligned(direction: "bullish" | "bearish", bars: Bar[], i: number, dailyBars: Bar[]) {
  const tradeDay = bars[i].date.slice(0, 10);
  let dEnd = 0;
  for (let k = 0; k < dailyBars.length; k++) {
    if (dailyBars[k].date.slice(0, 10) <= tradeDay) dEnd = k + 1;
    else break;
  }
  const dailySlice = dailyBars.slice(0, dEnd);
  const bias = detectDailyBias(dailySlice, 20);
  const bos = detectBos(bars, i, 5);
  const ob = detectOrderBlock(bars, i, { lookback: 5 });
  const fvg = detectFvg(bars, i);
  const sweep = detectLiquiditySweep(bars, i, 5);
  const choch = detectChoch(bars, i, 5);
  const ote = detectOte(bars, i, 5);
  const eq = detectEqualLevels(bars, i, direction, { swingLookback: 5 });
  const hit = (det: { detected: boolean; details?: { direction?: string; bias?: string } }, key: "direction" | "bias") =>
    det.detected && det.details?.[key] === direction;
  return {
    daily_bias: hit(bias, "bias"),
    bos: hit(bos, "direction"),
    ob: hit(ob, "direction"),
    fvg: hit(fvg, "direction"),
    sweep: hit(sweep, "direction"),
    choch: hit(choch, "direction"),
    ote: hit(ote, "direction"),
    equal_levels: eq.detected,
  };
}

function atr14(bars: Bar[], end: number): number {
  if (end < 15) return 0;
  let sum = 0;
  for (let k = end - 13; k <= end; k++) {
    const prev = bars[k - 1];
    const cur = bars[k];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    sum += tr;
  }
  return sum / 14;
}

function atrPercentile(bars: Bar[], end: number, lookback = 200): number | null {
  if (end < lookback + 14) return null;
  const samples: number[] = [];
  for (let k = end - lookback; k <= end; k++) {
    samples.push(atr14(bars, k));
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const current = atr14(bars, end);
  const rank = sorted.findIndex((v) => v >= current);
  return rank < 0 ? 100 : Math.round((rank / sorted.length) * 100);
}

interface StructuralFeatures {
  /** Closest round-number level (e.g., 1.0500 for EUR/USD). Distance in pips. */
  nearestRoundDistPips: number;
  roundLevel: number;
  /** 14-bar ATR. Used as size reference. */
  atr14: number;
  /** ATR percentile over last 200 bars (0=lowest, 100=highest). */
  atrPctile: number | null;
  /** Position within last 24h (24 bars) range, 0=bottom 100=top. */
  pos24hRange: number;
  high24h: number;
  low24h: number;
  /** Entry price vs rolling 24-bar OHLC4 mean (a crude vwap proxy). */
  vwapPxDiffPct: number;
  /** Distance in minutes to nearest major session open (london=7utc, ny=13utc). */
  minsToLondon: number;
  minsToNy: number;
  /** Entry bar position vs prior 5-bar range: 0=low, 100=high, >100=breakout up, <0=breakdown. */
  pos5barRangePct: number;
}

function pipSize(symbol: string): number {
  if (symbol === "XAU/USD") return 0.1; // gold pip = $0.10
  if (symbol.endsWith("/JPY")) return 0.01;
  return 0.0001;
}

function roundLevel(symbol: string, price: number): { round: number; distPips: number } {
  let step: number;
  if (symbol === "XAU/USD") step = 5; // $5 increments — practical round levels for gold
  else if (symbol.endsWith("/JPY")) step = 0.5; // 50-pip
  else step = 0.005; // 50-pip
  const round = Math.round(price / step) * step;
  const distPips = Math.abs(price - round) / pipSize(symbol);
  return { round, distPips };
}

function structuralFeatures(bars: Bar[], i: number, symbol: string, entryPrice: number, entryUtc: Date): StructuralFeatures {
  const start = Math.max(0, i - 23);
  const window = bars.slice(start, i + 1);
  const high24h = Math.max(...window.map((b) => b.high));
  const low24h = Math.min(...window.map((b) => b.low));
  const pos24hRange = high24h === low24h ? 50 : ((entryPrice - low24h) / (high24h - low24h)) * 100;
  const vwapMean = window.reduce((s, b) => s + (b.open + b.high + b.low + b.close) / 4, 0) / window.length;
  const vwapPxDiffPct = vwapMean === 0 ? 0 : ((entryPrice - vwapMean) / vwapMean) * 100;
  const round = roundLevel(symbol, entryPrice);
  const fiveBar = bars.slice(Math.max(0, i - 4), i + 1);
  const fiveLo = Math.min(...fiveBar.map((b) => b.low));
  const fiveHi = Math.max(...fiveBar.map((b) => b.high));
  const pos5 = fiveHi === fiveLo ? 50 : ((entryPrice - fiveLo) / (fiveHi - fiveLo)) * 100;
  const hour = entryUtc.getUTCHours();
  const min = entryUtc.getUTCMinutes();
  const totalMins = hour * 60 + min;
  const minsToLondon = (totalMins - 7 * 60 + 1440) % 1440;
  const minsToNy = (totalMins - 13 * 60 + 1440) % 1440;
  return {
    nearestRoundDistPips: Math.round(round.distPips * 10) / 10,
    roundLevel: round.round,
    atr14: Math.round(atr14(bars, i) * 100000) / 100000,
    atrPctile: atrPercentile(bars, i),
    pos24hRange: Math.round(pos24hRange),
    high24h,
    low24h,
    vwapPxDiffPct: Math.round(vwapPxDiffPct * 100) / 100,
    minsToLondon: Math.min(minsToLondon, 1440 - minsToLondon),
    minsToNy: Math.min(minsToNy, 1440 - minsToNy),
    pos5barRangePct: Math.round(pos5),
  };
}

interface InspectionRow {
  trade: Trade;
  entryBarIndex: number;
  entryBar: Bar;
  bars: Bar[];
  features: StructuralFeatures;
  primitives: ReturnType<typeof aligned>;
}

async function main() {
  const trades = loadTrades();
  console.log(`Loaded ${trades.length} trades.\n`);

  const bySymbol = new Map<string, Trade[]>();
  for (const t of trades) {
    const arr = bySymbol.get(t.appSymbol) ?? [];
    arr.push(t);
    bySymbol.set(t.appSymbol, arr);
  }

  const allRows: InspectionRow[] = [];
  for (const [symbol, sTrades] of bySymbol) {
    console.log(`Loading ${symbol} 1h+1d corpora...`);
    const c1 = await loadCorpus("1h", symbol);
    const c4 = await loadCorpus("4h", symbol);
    const hourBars: Bar[] = c1.bars;
    const dailyBars: Bar[] = c4.dailyBars;
    console.log(`  ${hourBars.length} 1h bars, ${dailyBars.length} 1d bars`);
    for (const t of sTrades) {
      const idx = findBarIndex(hourBars, t.openUtc.getTime());
      if (idx < 25) continue;
      const dir: "bullish" | "bearish" = t.type === "buy" ? "bullish" : "bearish";
      const prims = aligned(dir, hourBars, idx, dailyBars);
      const aligned_count = Object.values(prims).filter(Boolean).length;
      if (aligned_count !== 0) continue;
      const window = hourBars.slice(Math.max(0, idx - 10), Math.min(hourBars.length, idx + 11));
      const feats = structuralFeatures(hourBars, idx, symbol, t.openPrice, t.openUtc);
      allRows.push({
        trade: t,
        entryBarIndex: idx,
        entryBar: hourBars[idx],
        bars: window,
        features: feats,
        primitives: prims,
      });
    }
  }

  console.log(`\n\n=== ${allRows.length} ZERO-primitive trades ===\n`);
  for (const r of allRows) {
    const t = r.trade;
    const f = r.features;
    const dir = t.type === "buy" ? "LONG" : "SHORT";
    const outcome = t.isWin ? "WIN" : "LOSS";
    console.log(`--- ${t.openUtc.toISOString().slice(0, 16)} UTC | ${t.appSymbol} ${dir} | ${outcome} ($${t.profit.toFixed(0)}) | dur=${Math.round(t.durationSec / 60)}min ---`);
    console.log(`  entry: ${t.openPrice}  bar: O=${r.entryBar.open} H=${r.entryBar.high} L=${r.entryBar.low} C=${r.entryBar.close}`);
    console.log(`  features:`);
    console.log(`    round level: ${f.roundLevel} (${f.nearestRoundDistPips} pips away)`);
    console.log(`    ATR14=${f.atr14}, ATR pctile=${f.atrPctile}, pos in 24h range: ${f.pos24hRange}% [${f.low24h}..${f.high24h}]`);
    console.log(`    vs 24h vwap: ${f.vwapPxDiffPct >= 0 ? "+" : ""}${f.vwapPxDiffPct}%`);
    console.log(`    pos in prior 5-bar: ${f.pos5barRangePct}% (>100=breakout-up, <0=breakdown)`);
    console.log(`    mins to London open: ${f.minsToLondon},  mins to NY open: ${f.minsToNy}`);
    console.log(`  bars ±10 around entry:`);
    const entryWindowIdx = r.bars.findIndex((b) => b.date === r.entryBar.date);
    for (let bi = 0; bi < r.bars.length; bi++) {
      const b = r.bars[bi];
      const tag = bi === entryWindowIdx ? "ENTRY  " : "       ";
      console.log(`    ${tag} ${b.date}  O=${b.open}  H=${b.high}  L=${b.low}  C=${b.close}`);
    }
    console.log("");
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/inspect-blind-spot-trades-${stamp}.json`;
  writeFileSync(outPath, JSON.stringify({ rows: allRows.map((r) => ({ ...r, bars: r.bars })) }, null, 2));
  console.log(`Saved: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
