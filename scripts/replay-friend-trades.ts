/**
 * For each of the friend's actual FTMO trades, replay our pattern
 * detectors at the bar nearest his entry timestamp and report whether
 * our 2-of-3 BOS+OrderBlock+daily_bias gate would have fired.
 *
 * Answers the question: "do his trades coincide with our pattern
 * signals?" If yes → his edge is execution / sizing / timing, not
 * signal selection. If no → he's reading something we don't detect.
 *
 * Run with: npx tsx scripts/replay-friend-trades.ts
 */
import { readFileSync, readdirSync } from "fs";
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

// Manual env loader (same pattern as analyze-friend-trades.ts)
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
// MT5 server time on FTMO is GMT+2 (winter) / GMT+3 (DST). Data spans
// 2026-02-13 → 2026-03-13, all pre-EU-DST so a flat +2 hour offset is
// correct. Same as the existing analyze-friend-trades.ts.
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

async function fetchBarsViaLoadCorpus(symbol: string, interval: "1h" | "1day"): Promise<Bar[]> {
  // Use the same loadCorpus the V1.2 mining + discovery pipeline uses —
  // OANDA primary with caching, no Twelve Data rate-limit issues.
  if (interval === "1day") {
    const c4 = await loadCorpus("4h", symbol);
    return c4.dailyBars.map((b) => ({ ...b }));
  }
  const c1 = await loadCorpus("1h", symbol);
  return c1.bars.map((b) => ({ ...b }));
}

// Legacy Twelve Data direct fetcher — kept for the env-variable fallback
// path. New default is fetchBarsViaLoadCorpus above.
async function fetchBars(
  symbol: string,
  interval: "1h" | "1day"
): Promise<Bar[]> {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) throw new Error("TWELVE_DATA_API_KEY missing");
  const size = interval === "1h" ? 5000 : 200;
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${interval}&outputsize=${size}&apikey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Twelve Data ${res.status} for ${symbol} ${interval}`);
  const data: { values?: Array<{
    datetime: string; open: string; high: string; low: string; close: string; volume: string;
  }>; status?: string; message?: string } = await res.json();
  if (data.status === "error") throw new Error(`Twelve Data error: ${data.message}`);
  if (!data.values?.length) throw new Error(`No data for ${symbol} ${interval}`);
  return data.values
    .map((v) => ({
      date: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
      volume: parseInt(v.volume) || 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Find the bar index whose date is the latest one ≤ targetTime. */
function findBarIndex(bars: Bar[], targetMs: number): number {
  let last = -1;
  for (let i = 0; i < bars.length; i++) {
    const t = new Date(bars[i].date).getTime();
    if (Number.isFinite(t) && t <= targetMs) last = i;
    else break;
  }
  return last;
}

interface PatternHit {
  daily_bias_bullish: boolean;
  daily_bias_bearish: boolean;
  bos_bullish: boolean;
  bos_bearish: boolean;
  ob_bullish: boolean;
  ob_bearish: boolean;
  fvg_bullish: boolean;
  fvg_bearish: boolean;
  sweep_bullish: boolean;
  sweep_bearish: boolean;
  choch_bullish: boolean;
  choch_bearish: boolean;
  ote_bullish: boolean;
  ote_bearish: boolean;
  equal_levels_bullish: boolean;
  equal_levels_bearish: boolean;
  /** Aligned to the trade's direction: count of patterns that match the
   *  side he was actually trading (buy → bullish patterns, sell → bearish). */
  alignedCount: number;
  /** Same alignment but for the BOS + OrderBlock + daily_bias 2-of-3
   *  combo specifically — that's the template our friend-clone v1 uses. */
  ourTemplateAlignedCount: number;
  /** Direction-aligned count over the 3 NEW primitives added since
   *  2026-04-29's 5%-overlap baseline: choch + ote + equal_levels. */
  newPrimitivesAlignedCount: number;
  /** Direction-aligned count over ALL 8 primitives. */
  allPrimitivesAlignedCount: number;
}

function evaluatePatterns(
  bars: Bar[],
  i: number,
  dailyBars: Bar[],
  direction: "bullish" | "bearish"
): PatternHit {
  // Daily bias: detector takes the WHOLE bar series and returns the
  // bias of the LATEST close. Slice the daily series up to the trade
  // day so we don't peek at future daily bars.
  const tradeDay = bars[i].date.slice(0, 10);
  let dEnd = 0;
  for (let k = 0; k < dailyBars.length; k++) {
    if (dailyBars[k].date.slice(0, 10) <= tradeDay) dEnd = k + 1;
    else break;
  }
  const dailySlice = dailyBars.slice(0, dEnd);
  const biasResult = detectDailyBias(dailySlice, 20);
  const biasBull = biasResult.detected && biasResult.details?.bias === "bullish";
  const biasBear = biasResult.detected && biasResult.details?.bias === "bearish";

  const bosResult = detectBos(bars, i, 5);
  const bosBull = bosResult.detected && bosResult.details?.direction === "bullish";
  const bosBear = bosResult.detected && bosResult.details?.direction === "bearish";

  const obResult = detectOrderBlock(bars, i, { lookback: 5 });
  const obBull = obResult.detected && obResult.details?.direction === "bullish";
  const obBear = obResult.detected && obResult.details?.direction === "bearish";

  const fvgResult = detectFvg(bars, i);
  const fvgBull = fvgResult.detected && fvgResult.details?.direction === "bullish";
  const fvgBear = fvgResult.detected && fvgResult.details?.direction === "bearish";

  const sweepResult = detectLiquiditySweep(bars, i, 5);
  const sweepBull = sweepResult.detected && sweepResult.details?.direction === "bullish";
  const sweepBear = sweepResult.detected && sweepResult.details?.direction === "bearish";

  // ----- New primitives added since 2026-04-29 baseline ChoCh, OTE, equal_levels -----
  const chochResult = detectChoch(bars, i, 5);
  const chochBull = chochResult.detected && chochResult.details?.direction === "bullish";
  const chochBear = chochResult.detected && chochResult.details?.direction === "bearish";

  const oteResult = detectOte(bars, i, 5);
  const oteBull = oteResult.detected && oteResult.details?.direction === "bullish";
  const oteBear = oteResult.detected && oteResult.details?.direction === "bearish";

  const eqBull = detectEqualLevels(bars, i, "bullish", { swingLookback: 5 }).detected;
  const eqBear = detectEqualLevels(bars, i, "bearish", { swingLookback: 5 }).detected;

  const isBull = direction === "bullish";
  const aligned = [
    isBull ? biasBull : biasBear,
    isBull ? bosBull : bosBear,
    isBull ? obBull : obBear,
    isBull ? fvgBull : fvgBear,
    isBull ? sweepBull : sweepBear,
  ].filter(Boolean).length;
  const ourTemplate = [
    isBull ? biasBull : biasBear,
    isBull ? bosBull : bosBear,
    isBull ? obBull : obBear,
  ].filter(Boolean).length;
  const newPrimitives = [
    isBull ? chochBull : chochBear,
    isBull ? oteBull : oteBear,
    isBull ? eqBull : eqBear,
  ].filter(Boolean).length;
  const allPrimitives = aligned + newPrimitives;

  return {
    daily_bias_bullish: biasBull,
    daily_bias_bearish: biasBear,
    bos_bullish: bosBull,
    bos_bearish: bosBear,
    ob_bullish: obBull,
    ob_bearish: obBear,
    fvg_bullish: fvgBull,
    fvg_bearish: fvgBear,
    sweep_bullish: sweepBull,
    sweep_bearish: sweepBear,
    choch_bullish: chochBull,
    choch_bearish: chochBear,
    ote_bullish: oteBull,
    ote_bearish: oteBear,
    equal_levels_bullish: eqBull,
    equal_levels_bearish: eqBear,
    alignedCount: aligned,
    ourTemplateAlignedCount: ourTemplate,
    newPrimitivesAlignedCount: newPrimitives,
    allPrimitivesAlignedCount: allPrimitives,
  };
}

interface Result {
  trade: Trade;
  hit: PatternHit | null;
  reason?: string;
}

async function main() {
  const trades = loadTrades();
  console.log(`Loaded ${trades.length} trades.\n`);

  // Group by symbol — we'll fetch one set of bars per symbol.
  const bySymbol = new Map<string, Trade[]>();
  for (const t of trades) {
    const arr = bySymbol.get(t.appSymbol) ?? [];
    arr.push(t);
    bySymbol.set(t.appSymbol, arr);
  }

  const results: Result[] = [];
  for (const [symbol, sTrades] of bySymbol) {
    console.log(`Fetching bars for ${symbol}...`);
    let hourBars: Bar[];
    let dailyBars: Bar[];
    try {
      hourBars = await fetchBarsViaLoadCorpus(symbol, "1h");
      dailyBars = await fetchBarsViaLoadCorpus(symbol, "1day");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  skip ${symbol}: ${msg}`);
      for (const t of sTrades) results.push({ trade: t, hit: null, reason: msg });
      continue;
    }
    console.log(`  ${hourBars.length} 1h bars, ${dailyBars.length} 1d bars`);

    for (const t of sTrades) {
      const ms = t.openUtc.getTime();
      const idx = findBarIndex(hourBars, ms);
      if (idx < 5) {
        results.push({ trade: t, hit: null, reason: "no bar history" });
        continue;
      }
      const dir: "bullish" | "bearish" = t.type === "buy" ? "bullish" : "bearish";
      const hit = evaluatePatterns(hourBars, idx, dailyBars, dir);
      results.push({ trade: t, hit });
    }
  }

  // ---- Reports ----

  const evaluated = results.filter((r) => r.hit !== null);
  const wins = evaluated.filter((r) => r.trade.isWin);
  const losses = evaluated.filter((r) => !r.trade.isWin);

  console.log(`\n=== Replay summary ===`);
  console.log(`Trades evaluated: ${evaluated.length} (skipped ${results.length - evaluated.length})`);

  function rateAt(threshold: number, sample: Result[]): number {
    if (sample.length === 0) return 0;
    return (sample.filter((r) => (r.hit?.ourTemplateAlignedCount ?? 0) >= threshold).length / sample.length) * 100;
  }

  console.log(`\n--- Our 3-pattern template (daily_bias + BOS + order_block) ---`);
  console.log(`At trade entry, fraction with the trade's direction firing N or more of our 3 patterns:`);
  console.log(`                                  ALL TRADES         WINNERS         LOSERS`);
  for (const t of [1, 2, 3]) {
    const all = rateAt(t, evaluated).toFixed(0);
    const w = rateAt(t, wins).toFixed(0);
    const l = rateAt(t, losses).toFixed(0);
    console.log(`  ≥ ${t} patterns aligned:           ${all.padStart(5)}%${" ".repeat(18 - 5 - all.length)}${w.padStart(5)}%${" ".repeat(16 - 5 - w.length)}${l.padStart(5)}%`);
  }
  console.log(`\nThreshold for our friend-clone algos: 2-of-3.`);
  const wouldHaveFired = evaluated.filter((r) => (r.hit?.ourTemplateAlignedCount ?? 0) >= 2);
  console.log(`Trades where our 2-of-3 gate would have fired: ${wouldHaveFired.length} of ${evaluated.length} (${(wouldHaveFired.length / evaluated.length * 100).toFixed(0)}%)`);
  const wouldHaveFiredWins = wouldHaveFired.filter((r) => r.trade.isWin);
  if (wouldHaveFired.length > 0) {
    console.log(`  Of those: ${wouldHaveFiredWins.length} winners, WR ${(wouldHaveFiredWins.length / wouldHaveFired.length * 100).toFixed(1)}%`);
  }

  console.log(`\n--- Wider 5-pattern set (+ FVG + liquidity_sweep) ---`);
  console.log(`At his entry, how often was at least 1 of any pattern firing in his direction?`);
  const wide1 = evaluated.filter((r) => (r.hit?.alignedCount ?? 0) >= 1);
  const wide2 = evaluated.filter((r) => (r.hit?.alignedCount ?? 0) >= 2);
  const wide3 = evaluated.filter((r) => (r.hit?.alignedCount ?? 0) >= 3);
  console.log(`  ≥ 1 pattern aligned: ${wide1.length} (${(wide1.length / evaluated.length * 100).toFixed(0)}%)`);
  console.log(`  ≥ 2 patterns aligned: ${wide2.length} (${(wide2.length / evaluated.length * 100).toFixed(0)}%)`);
  console.log(`  ≥ 3 patterns aligned: ${wide3.length} (${(wide3.length / evaluated.length * 100).toFixed(0)}%)`);

  // Per-pattern firing rates (in his direction)
  console.log(`\n--- Per-pattern firing rate (in trade direction) at his entry timestamp ---`);
  function fireRate(key: keyof PatternHit, sample: Result[]): number {
    if (sample.length === 0) return 0;
    const fired = sample.filter((r) => {
      if (!r.hit) return false;
      const v = r.hit[key];
      return typeof v === "boolean" && v === true;
    }).length;
    return (fired / sample.length) * 100;
  }
  function dirKey(prefix: string, dir: "bullish" | "bearish"): keyof PatternHit {
    return `${prefix}_${dir}` as keyof PatternHit;
  }
  function fireAlignedRate(prefix: string, sample: Result[]): number {
    if (sample.length === 0) return 0;
    const fired = sample.filter((r) => {
      if (!r.hit) return false;
      const dir = r.trade.type === "buy" ? "bullish" : "bearish";
      const v = r.hit[dirKey(prefix, dir)];
      return v === true;
    }).length;
    return (fired / sample.length) * 100;
  }
  const patterns = ["daily_bias", "bos", "ob", "fvg", "sweep", "choch", "ote", "equal_levels"];
  console.log(`Pattern             ALL    WINNERS  LOSERS`);
  for (const p of patterns) {
    const a = fireAlignedRate(p, evaluated).toFixed(0);
    const w = fireAlignedRate(p, wins).toFixed(0);
    const l = fireAlignedRate(p, losses).toFixed(0);
    console.log(`  ${p.padEnd(18)} ${a.padStart(3)}%   ${w.padStart(3)}%     ${l.padStart(3)}%`);
  }

  // ----- Coverage rate including new primitives -----
  console.log(`\n--- Coverage including NEW primitives (choch + ote + equal_levels) ---`);
  function coverageAt(threshold: number, key: "allPrimitivesAlignedCount" | "newPrimitivesAlignedCount", sample: Result[]): number {
    if (sample.length === 0) return 0;
    return (sample.filter((r) => (r.hit?.[key] ?? 0) >= threshold).length / sample.length) * 100;
  }
  console.log(`Trades where ≥1 of 3 NEW primitives aligned: ${coverageAt(1, "newPrimitivesAlignedCount", evaluated).toFixed(0)}% (${evaluated.filter(r => (r.hit?.newPrimitivesAlignedCount ?? 0) >= 1).length} of ${evaluated.length})`);
  console.log(`Trades where ≥1 of ALL 8 primitives aligned: ${coverageAt(1, "allPrimitivesAlignedCount", evaluated).toFixed(0)}% (${evaluated.filter(r => (r.hit?.allPrimitivesAlignedCount ?? 0) >= 1).length} of ${evaluated.length})`);
  console.log(`Trades where ≥2 of ALL 8 primitives aligned: ${coverageAt(2, "allPrimitivesAlignedCount", evaluated).toFixed(0)}% (${evaluated.filter(r => (r.hit?.allPrimitivesAlignedCount ?? 0) >= 2).length} of ${evaluated.length})`);
  console.log(`Trades where ≥3 of ALL 8 primitives aligned: ${coverageAt(3, "allPrimitivesAlignedCount", evaluated).toFixed(0)}%`);
  const stillMissed = evaluated.filter((r) => (r.hit?.allPrimitivesAlignedCount ?? 0) === 0);
  console.log(`\nTrades where ZERO primitives fired (we cannot detect this entry at all): ${stillMissed.length} of ${evaluated.length} (${(stillMissed.length / evaluated.length * 100).toFixed(0)}%)`);
  const stillMissedWins = stillMissed.filter((r) => r.trade.isWin);
  console.log(`  Of those: ${stillMissedWins.length} winners (${stillMissed.length > 0 ? ((stillMissedWins.length / stillMissed.length) * 100).toFixed(0) : 0}%)`);

  // What was happening on HIS WINNING TRADES that DIDN'T match our patterns?
  const winnersWeMissed = wins.filter((r) => (r.hit?.ourTemplateAlignedCount ?? 0) < 2);
  console.log(`\n--- Sample of his WINNERS where our 2-of-3 template DIDN'T align (${winnersWeMissed.length} of ${wins.length}) ---`);
  for (const r of winnersWeMissed.slice(0, 8)) {
    const t = r.trade;
    const h = r.hit!;
    const dir = t.type === "buy" ? "bull" : "bear";
    const fired = (
      [
        ["bias", dir === "bull" ? h.daily_bias_bullish : h.daily_bias_bearish],
        ["bos", dir === "bull" ? h.bos_bullish : h.bos_bearish],
        ["ob", dir === "bull" ? h.ob_bullish : h.ob_bearish],
        ["fvg", dir === "bull" ? h.fvg_bullish : h.fvg_bearish],
        ["sweep", dir === "bull" ? h.sweep_bullish : h.sweep_bearish],
      ].filter((entry) => entry[1] === true).map((entry) => entry[0]) as string[]
    ).join("+") || "none";
    console.log(`  ${t.openUtc.toISOString().slice(0, 16)} ${t.symbol.padEnd(7)} ${t.type.padEnd(4)} +$${t.profit.toFixed(0).padStart(4)} | fired: ${fired}`);
  }

  // What was happening on his LOSERS where our patterns ALIGNED?
  const losersWeMatched = losses.filter((r) => (r.hit?.ourTemplateAlignedCount ?? 0) >= 2);
  console.log(`\n--- Sample of his LOSERS where our 2-of-3 template DID align (${losersWeMatched.length} of ${losses.length}) ---`);
  for (const r of losersWeMatched.slice(0, 8)) {
    const t = r.trade;
    console.log(`  ${t.openUtc.toISOString().slice(0, 16)} ${t.symbol.padEnd(7)} ${t.type.padEnd(4)} -$${Math.abs(t.profit).toFixed(0).padStart(4)} | aligned: ${r.hit!.ourTemplateAlignedCount}/3`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
