/**
 * One-off analysis: profile the friend's FTMO trading from the two CSV
 * exports in `funded account references/`. Goal is to extract the
 * disciplinary patterns we'd want to encode into algorithm rules:
 * session windows, day-of-week filters, news avoidance, R:R, position
 * sizing, holding time.
 *
 * Run with: npx tsx scripts/analyze-friend-trades.ts
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  fetchEconomicCalendar,
  getEventCurrencies,
  type EconomicEvent,
  type EventImpact,
} from "../src/lib/market-data/economic-calendar";

// Make sure FINNHUB_API_KEY from .env.local is loaded for the calendar
// fetch. Tiny manual parser — saves adding a dotenv dep just for this.
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
    /* ignore — env may already be set */
  }
}

interface Trade {
  ticket: string;
  openBroker: string; // raw timestamp from CSV (MT5 server time, GMT+2 outside DST)
  openUtc: Date;
  type: "buy" | "sell";
  volume: number;
  symbol: string;
  openPrice: number;
  sl: number;
  tp: number;
  closeUtc: Date;
  closePrice: number;
  swap: number;
  commission: number;
  profit: number;
  pips: number;
  durationSec: number;
}

const REFERENCES_DIR = "funded account references";
// MT5 server time on most FTMO configurations is GMT+2 (winter) / GMT+3
// (DST). Data spans 2026-02-13 → 2026-03-13, all pre-EU-DST.
const BROKER_TZ_OFFSET_MINUTES = 120;

function brokerTimestampToUtc(raw: string): Date {
  // CSV format: "2026-02-25 03:05:09"
  const [date, time] = raw.split(" ");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm, ss] = time.split(":").map(Number);
  // Build UTC date by subtracting the broker offset.
  return new Date(Date.UTC(y, m - 1, d, hh, mm, ss) - BROKER_TZ_OFFSET_MINUTES * 60_000);
}

function parseCsv(path: string): Trade[] {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // Skip header
  const trades: Trade[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // Split on commas but not inside quoted strings.
    const cells: string[] = [];
    let cur = "";
    let inQuote = false;
    for (const ch of line) {
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
      price,
      sl,
      tp,
      close,
      closePrice,
      swap,
      commissions,
      profit,
      pips,
      duration,
    ] = cells;
    if (!open || !close) continue;
    trades.push({
      ticket,
      openBroker: open,
      openUtc: brokerTimestampToUtc(open),
      type: type as "buy" | "sell",
      volume: Number(volume),
      symbol,
      openPrice: Number(price),
      sl: Number(sl),
      tp: Number(tp),
      closeUtc: brokerTimestampToUtc(close),
      closePrice: Number(closePrice),
      swap: Number(swap),
      commission: Number(commissions),
      profit: Number(profit),
      pips: Number(pips),
      durationSec: Number(duration),
    });
  }
  return trades;
}

function loadAllTrades(): Trade[] {
  const dir = join(process.cwd(), REFERENCES_DIR);
  const files = readdirSync(dir).filter((f) => f.endsWith(".csv"));
  const all: Trade[] = [];
  for (const f of files) all.push(...parseCsv(join(dir, f)));
  return all.sort((a, b) => a.openUtc.getTime() - b.openUtc.getTime());
}

function pad(n: number, w = 2) {
  return String(n).padStart(w, "0");
}

// ---------- Reports ----------

function summary(trades: Trade[]) {
  const wins = trades.filter((t) => t.profit > 0);
  const losses = trades.filter((t) => t.profit < 0);
  const breakevens = trades.filter((t) => t.profit === 0);
  const totalProfit = trades.reduce((s, t) => s + t.profit, 0);
  const grossWin = wins.reduce((s, t) => s + t.profit, 0);
  const grossLoss = losses.reduce((s, t) => s + t.profit, 0);
  const dates = trades.map((t) => t.openUtc.toISOString().slice(0, 10));
  const uniqueDays = new Set(dates).size;
  console.log("=== Summary ===");
  console.log(`Trades:          ${trades.length}`);
  console.log(`Span:            ${trades[0].openUtc.toISOString()} → ${trades[trades.length - 1].openUtc.toISOString()}`);
  console.log(`Trading days:    ${uniqueDays}`);
  console.log(`Trades/day avg:  ${(trades.length / uniqueDays).toFixed(1)}`);
  console.log(`Wins / Losses:   ${wins.length} / ${losses.length} (BE: ${breakevens.length})`);
  console.log(`Win rate:        ${((wins.length / trades.length) * 100).toFixed(1)}%`);
  console.log(`Net profit:      $${totalProfit.toFixed(2)}`);
  console.log(`Gross win:       $${grossWin.toFixed(2)}`);
  console.log(`Gross loss:      $${grossLoss.toFixed(2)}`);
  console.log(`Profit factor:   ${(grossWin / -grossLoss).toFixed(2)}`);
  console.log(`Avg win:         $${(grossWin / Math.max(wins.length, 1)).toFixed(2)}`);
  console.log(`Avg loss:        $${(grossLoss / Math.max(losses.length, 1)).toFixed(2)}`);
}

function symbolBreakdown(trades: Trade[]) {
  console.log("\n=== Symbol breakdown ===");
  const bySym = new Map<string, Trade[]>();
  for (const t of trades) {
    const arr = bySym.get(t.symbol) ?? [];
    arr.push(t);
    bySym.set(t.symbol, arr);
  }
  console.log(`${"Symbol".padEnd(10)} ${"N".padStart(3)} ${"Wins".padStart(4)} ${"WR%".padStart(6)} ${"Net $".padStart(10)} ${"Avg dur".padStart(10)}`);
  for (const [sym, arr] of bySym) {
    const wins = arr.filter((t) => t.profit > 0).length;
    const wr = (wins / arr.length) * 100;
    const net = arr.reduce((s, t) => s + t.profit, 0);
    const avgDurMin = arr.reduce((s, t) => s + t.durationSec, 0) / arr.length / 60;
    console.log(
      `${sym.padEnd(10)} ${String(arr.length).padStart(3)} ${String(wins).padStart(4)} ${wr.toFixed(1).padStart(5)}% ${("$" + net.toFixed(0)).padStart(10)} ${(avgDurMin.toFixed(1) + "m").padStart(10)}`
    );
  }
}

function hourDistribution(trades: Trade[]) {
  console.log("\n=== Entry hour (UTC) — when does he open trades? ===");
  const buckets = Array.from({ length: 24 }, () => 0);
  for (const t of trades) buckets[t.openUtc.getUTCHours()]++;
  const max = Math.max(...buckets);
  for (let h = 0; h < 24; h++) {
    if (buckets[h] === 0) continue;
    const bar = "█".repeat(Math.round((buckets[h] / max) * 30));
    console.log(`${pad(h)}:00  ${String(buckets[h]).padStart(2)}  ${bar}`);
  }
  // Session classification
  const london = trades.filter((t) => {
    const h = t.openUtc.getUTCHours();
    return h >= 7 && h < 12;
  }).length;
  const overlap = trades.filter((t) => {
    const h = t.openUtc.getUTCHours();
    return h >= 12 && h < 16;
  }).length;
  const ny = trades.filter((t) => {
    const h = t.openUtc.getUTCHours();
    return h >= 16 && h < 21;
  }).length;
  const asian = trades.filter((t) => {
    const h = t.openUtc.getUTCHours();
    return h < 7 || h >= 21;
  }).length;
  console.log(`\n  London-only window (07-12 UTC):    ${london}`);
  console.log(`  London/NY overlap (12-16 UTC):     ${overlap}`);
  console.log(`  NY-only window (16-21 UTC):        ${ny}`);
  console.log(`  Asian / off-hours (other):         ${asian}`);
}

function weekdayDistribution(trades: Trade[]) {
  console.log("\n=== Day of week ===");
  const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const buckets = [0, 0, 0, 0, 0, 0, 0];
  for (const t of trades) buckets[t.openUtc.getUTCDay()]++;
  for (let i = 0; i < 7; i++) {
    if (buckets[i] === 0) continue;
    console.log(`${labels[i]}: ${buckets[i]}`);
  }
}

function durationStats(trades: Trade[]) {
  console.log("\n=== Holding time ===");
  const winsDur = trades.filter((t) => t.profit > 0).map((t) => t.durationSec / 60);
  const lossesDur = trades.filter((t) => t.profit < 0).map((t) => t.durationSec / 60);
  const median = (arr: number[]) => {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  console.log(`Winners — median: ${median(winsDur).toFixed(0)}m, max: ${Math.max(...winsDur, 0).toFixed(0)}m`);
  console.log(`Losers  — median: ${median(lossesDur).toFixed(0)}m, max: ${Math.max(...lossesDur, 0).toFixed(0)}m`);
}

function rrAndSizing(trades: Trade[]) {
  console.log("\n=== R:R and SL/TP discipline ===");
  let withSlTp = 0;
  const rrs: number[] = [];
  for (const t of trades) {
    if (t.sl > 0 && t.tp > 0) {
      withSlTp++;
      const slDist = Math.abs(t.openPrice - t.sl);
      const tpDist = Math.abs(t.tp - t.openPrice);
      if (slDist > 0) rrs.push(tpDist / slDist);
    }
  }
  const noSl = trades.filter((t) => t.sl === 0).length;
  const noTp = trades.filter((t) => t.tp === 0).length;
  console.log(`With both SL & TP set:   ${withSlTp} of ${trades.length}`);
  console.log(`SL = 0 (no stop):        ${noSl}`);
  console.log(`TP = 0 (no take-profit): ${noTp}`);
  if (rrs.length > 0) {
    rrs.sort((a, b) => a - b);
    const median = rrs[Math.floor(rrs.length / 2)];
    const min = rrs[0];
    const max = rrs[rrs.length - 1];
    console.log(`R:R observed — min: ${min.toFixed(2)}, median: ${median.toFixed(2)}, max: ${max.toFixed(2)}`);
  }
  console.log("\n=== Position sizing (volume in lots) ===");
  const vols = new Map<number, number>();
  for (const t of trades) {
    vols.set(t.volume, (vols.get(t.volume) ?? 0) + 1);
  }
  const sorted = [...vols.entries()].sort((a, b) => a[0] - b[0]);
  for (const [v, n] of sorted) {
    console.log(`  ${v} lots: ${n} trades`);
  }
}

function dailyPnlConcentration(trades: Trade[]) {
  console.log("\n=== Daily P&L (FTMO consistency rule check) ===");
  const byDay = new Map<string, number>();
  for (const t of trades) {
    const day = t.openUtc.toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + t.profit);
  }
  const days = [...byDay.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  let totalPositive = 0;
  for (const [, p] of days) if (p > 0) totalPositive += p;
  console.log(`Best winning days (vs total positive $${totalPositive.toFixed(0)}):`);
  for (const [day, p] of days.slice(0, 5)) {
    const pct = totalPositive > 0 ? (p / totalPositive) * 100 : 0;
    console.log(`  ${day}: $${p.toFixed(2)} ${p > 0 ? `(${pct.toFixed(1)}% of total profits)` : ""}`);
  }
}

function clusterAnalysis(trades: Trade[]) {
  console.log("\n=== Trade clusters (same day, same direction) ===");
  const byDayDir = new Map<string, Trade[]>();
  for (const t of trades) {
    const key = `${t.openUtc.toISOString().slice(0, 10)}_${t.symbol}_${t.type}`;
    const arr = byDayDir.get(key) ?? [];
    arr.push(t);
    byDayDir.set(key, arr);
  }
  const clusters = [...byDayDir.entries()].filter(([, arr]) => arr.length > 1);
  console.log(`Days with ≥2 same-direction trades on same symbol: ${clusters.length}`);
  for (const [key, arr] of clusters.slice(0, 10)) {
    const profit = arr.reduce((s, t) => s + t.profit, 0);
    console.log(`  ${key} — ${arr.length} trades, net $${profit.toFixed(2)}`);
  }
}

// ---------- News cross-reference ----------

const IMPACT_RANK: Record<EventImpact, number> = { low: 1, medium: 2, high: 3 };

interface NewsContext {
  trade: Trade;
  /** Minutes from trade open to the nearest matching tier-1 event.
   *  Negative = event was BEFORE the trade. Positive = event is AFTER. */
  signedMinutesToNearest: number | null;
  nearestEvent: EconomicEvent | null;
  /** True if trade open is within +/- 5 minutes of an event */
  inFtmoWindow: boolean;
  /** True if within +/- 60 minutes (broader "news window") */
  inSixtyMinWindow: boolean;
  /** True if within +/- 240 minutes (whole-session) */
  inFourHourWindow: boolean;
  /** Same calendar day (UTC) as a tier-1 event */
  sameUtcDay: boolean;
}

async function fetchAllEvents(trades: Trade[]): Promise<EconomicEvent[]> {
  if (trades.length === 0) return [];
  const earliest = new Date(trades[0].openUtc);
  const latest = new Date(trades[trades.length - 1].openUtc);
  earliest.setUTCDate(earliest.getUTCDate() - 1);
  latest.setUTCDate(latest.getUTCDate() + 1);
  return fetchEconomicCalendar(earliest, latest);
}

function buildNewsContext(
  trade: Trade,
  events: EconomicEvent[],
  minImpact: EventImpact
): NewsContext {
  const ccys = getEventCurrencies(trade.symbol.toUpperCase().includes("/")
    ? trade.symbol
    : insertSlash(trade.symbol));
  if (ccys.length === 0) {
    return {
      trade,
      signedMinutesToNearest: null,
      nearestEvent: null,
      inFtmoWindow: false,
      inSixtyMinWindow: false,
      inFourHourWindow: false,
      sameUtcDay: false,
    };
  }
  const minRank = IMPACT_RANK[minImpact];
  const matching = events.filter(
    (e) => IMPACT_RANK[e.impact] >= minRank && ccys.includes(e.currency)
  );
  const tradeMs = trade.openUtc.getTime();
  let nearest: EconomicEvent | null = null;
  let nearestSigned = Number.POSITIVE_INFINITY;
  for (const e of matching) {
    const eventMs = new Date(e.time).getTime();
    const signedMin = (eventMs - tradeMs) / 60000;
    if (Math.abs(signedMin) < Math.abs(nearestSigned)) {
      nearestSigned = signedMin;
      nearest = e;
    }
  }
  if (!nearest) {
    return {
      trade,
      signedMinutesToNearest: null,
      nearestEvent: null,
      inFtmoWindow: false,
      inSixtyMinWindow: false,
      inFourHourWindow: false,
      sameUtcDay: false,
    };
  }
  const tradeDay = trade.openUtc.toISOString().slice(0, 10);
  const sameUtcDay = matching.some(
    (e) => new Date(e.time).toISOString().slice(0, 10) === tradeDay
  );
  return {
    trade,
    signedMinutesToNearest: nearestSigned,
    nearestEvent: nearest,
    inFtmoWindow: Math.abs(nearestSigned) <= 5,
    inSixtyMinWindow: Math.abs(nearestSigned) <= 60,
    inFourHourWindow: Math.abs(nearestSigned) <= 240,
    sameUtcDay,
  };
}

/** Convert MT5 symbol like "XAUUSD" → "XAU/USD" so getEventCurrencies works. */
function insertSlash(symbol: string): string {
  if (symbol.length === 6) return `${symbol.slice(0, 3)}/${symbol.slice(3)}`;
  return symbol;
}

async function newsAnalysis(trades: Trade[]) {
  console.log("\n=== News cross-reference (tier-1 events only) ===");
  const events = await fetchAllEvents(trades);
  console.log(`Calendar: fetched ${events.length} events across the trade span`);
  const high = events.filter((e) => e.impact === "high");
  console.log(`Of which tier-1 (high-impact): ${high.length}`);
  if (events.length === 0) {
    console.log("No events fetched — check FINNHUB_API_KEY or network. Skipping cross-reference.");
    return;
  }

  const contexts = trades.map((t) => buildNewsContext(t, events, "high"));

  const ftmoBreaches = contexts.filter((c) => c.inFtmoWindow);
  const sixtyMin = contexts.filter((c) => c.inSixtyMinWindow);
  const fourHour = contexts.filter((c) => c.inFourHourWindow);
  const sameDay = contexts.filter((c) => c.sameUtcDay);

  console.log(`\nTrades within ±5min of tier-1 event (FTMO breach):  ${ftmoBreaches.length}`);
  console.log(`Trades within ±60min of tier-1 event:               ${sixtyMin.length}`);
  console.log(`Trades within ±4h of tier-1 event:                  ${fourHour.length}`);
  console.log(`Trades on same UTC day as tier-1 event:             ${sameDay.length} of ${trades.length}`);

  // Distribution of "minutes from nearest" — bucketed
  const buckets: Record<string, number> = {
    "≥-240 to <-60 (>1h before)": 0,
    "-60 to -15 (1h–15m before)": 0,
    "-15 to -5 (within 15m before)": 0,
    "-5 to 0 (5m before)": 0,
    "0 to 5 (5m after)": 0,
    "5 to 15 (5–15m after)": 0,
    "15 to 60 (15m–1h after)": 0,
    "60 to 240 (1–4h after)": 0,
    ">240 or no event": 0,
  };
  for (const c of contexts) {
    const m = c.signedMinutesToNearest;
    if (m === null) {
      buckets[">240 or no event"]++;
      continue;
    }
    if (m < -240) buckets[">240 or no event"]++;
    else if (m < -60) buckets["≥-240 to <-60 (>1h before)"]++;
    else if (m < -15) buckets["-60 to -15 (1h–15m before)"]++;
    else if (m < -5) buckets["-15 to -5 (within 15m before)"]++;
    else if (m < 0) buckets["-5 to 0 (5m before)"]++;
    else if (m < 5) buckets["0 to 5 (5m after)"]++;
    else if (m < 15) buckets["5 to 15 (5–15m after)"]++;
    else if (m < 60) buckets["15 to 60 (15m–1h after)"]++;
    else if (m < 240) buckets["60 to 240 (1–4h after)"]++;
    else buckets[">240 or no event"]++;
  }
  console.log("\nDistribution of 'time to nearest tier-1 event' (negative = event before trade):");
  for (const [label, n] of Object.entries(buckets)) {
    if (n === 0) continue;
    const bar = "█".repeat(n);
    console.log(`  ${label.padEnd(35)} ${String(n).padStart(2)}  ${bar}`);
  }

  // WR comparison: in window vs out of window
  const inSixty = contexts.filter((c) => c.inSixtyMinWindow).map((c) => c.trade);
  const outsideSixty = contexts.filter((c) => !c.inSixtyMinWindow).map((c) => c.trade);
  function stats(ts: Trade[]) {
    if (ts.length === 0) return null;
    const wins = ts.filter((t) => t.profit > 0).length;
    const profit = ts.reduce((s, t) => s + t.profit, 0);
    return {
      n: ts.length,
      wr: (wins / ts.length) * 100,
      net: profit,
      avg: profit / ts.length,
    };
  }
  const inS = stats(inSixty);
  const outS = stats(outsideSixty);
  console.log("\nPerformance — in vs out of ±60min window:");
  if (inS)
    console.log(
      `  IN  window: n=${inS.n}, WR ${inS.wr.toFixed(1)}%, net $${inS.net.toFixed(0)}, avg $${inS.avg.toFixed(0)}/trade`
    );
  if (outS)
    console.log(
      `  OUT window: n=${outS.n}, WR ${outS.wr.toFixed(1)}%, net $${outS.net.toFixed(0)}, avg $${outS.avg.toFixed(0)}/trade`
    );

  // Sample of trades within the ±60min window — what events did he trade?
  if (sixtyMin.length > 0) {
    console.log(`\nTrades within ±60min of a tier-1 event (showing up to 10):`);
    for (const c of sixtyMin.slice(0, 10)) {
      const sign = (c.signedMinutesToNearest ?? 0) >= 0 ? "+" : "";
      console.log(
        `  ${c.trade.openUtc.toISOString().slice(0, 16)}  ${c.trade.symbol.padEnd(7)} ${c.trade.type.padEnd(4)} ${("$" + c.trade.profit.toFixed(0)).padStart(8)}  ${sign}${(c.signedMinutesToNearest ?? 0).toFixed(0)}min from "${c.nearestEvent?.event}" (${c.nearestEvent?.currency})`
      );
    }
  }
}

async function main() {
  const trades = loadAllTrades();
  summary(trades);
  symbolBreakdown(trades);
  hourDistribution(trades);
  weekdayDistribution(trades);
  durationStats(trades);
  rrAndSizing(trades);
  dailyPnlConcentration(trades);
  clusterAnalysis(trades);
  await newsAnalysis(trades);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
