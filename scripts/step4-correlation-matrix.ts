/**
 * STEP 4 — Algo correlation matrix on STEP-3 survivors (per roadmap-2026-06).
 *
 * Computes three correlation lenses for the surviving algos:
 *   (a) Daily P&L Pearson correlation — if two algos' daily P&Ls move
 *       together, they're not really diversified.
 *   (b) Trade-day overlap % — what fraction of trade days are shared?
 *   (c) Side-aligned trade days — when they share a day, do they take
 *       the same side?
 *
 * Gate per roadmap: "uncorrelated enough — aggregate stands" OR
 * "correlated — only one of N contributes uniquely, target gap is
 * wider than thought."
 *
 * Practical thresholds:
 *   |corr| > 0.7  : highly correlated; effectively the same edge
 *   0.4 < |corr| < 0.7 : moderately correlated
 *   |corr| < 0.3  : mostly diversifying
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { timeframeToInterval } from "../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import type { BacktestTrade, PriceBar } from "../src/lib/market-data/types";
import type { AlgorithmRules } from "../src/types/algorithm";

{
  try {
    const raw = readFileSync(".env.local", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.replace(/^['"]|['"]$/g, "");
    }
  } catch {}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getBarsNoTtl(supabase: any, ticker: string, interval: string): Promise<PriceBar[] | null> {
  const { data } = await supabase
    .from("price_cache")
    .select("bars")
    .eq("ticker", ticker.toUpperCase())
    .eq("output_size", "full")
    .eq("interval", interval)
    .limit(1)
    .single();
  return (data as { bars: PriceBar[] } | null)?.bars ?? null;
}

const STEP3_SURVIVORS = [
  "Library: Gold FVG-DailyBias-Long 4h",
  "Library: Gold FVG-Long 30m",
  "Library: Gold Coil-Breakout 4h",
  "Library: Gold Dip-Buyer 4h",
  "Library: Gold sweep_reclaim-DailyBias-Long 4h",
  "Library: USD/JPY sweep_reclaim-DailyBias-Long 4h",
];

interface AlgoData {
  name: string;
  shortName: string;
  ticker: string;
  capital: number;
  trades: BacktestTrade[];
  /** Daily P&L map: date -> pnl */
  dailyPnl: Map<string, number>;
  /** Set of unique trade-entry days */
  tradeDays: Set<string>;
  /** Per-day side: long/short for the (single) trade taken that day. Mixed = both. */
  dayDirection: Map<string, "long" | "short" | "mixed">;
}

function shortName(name: string): string {
  // "Library: Gold FVG-DailyBias-Long 4h" -> "GoldFVGDailyBias4h"
  return name.replace("Library: ", "").replace(/[\s/-]+/g, "");
}

function pearson(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  const n = a.length;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let sumXY = 0, sumXX = 0, sumYY = 0;
  for (let i = 0; i < n; i++) {
    const dx = a[i] - meanA, dy = b[i] - meanB;
    sumXY += dx * dy;
    sumXX += dx * dx;
    sumYY += dy * dy;
  }
  const denom = Math.sqrt(sumXX * sumYY);
  return denom === 0 ? 0 : sumXY / denom;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadAlgo(supabase: any, name: string): Promise<AlgoData | null> {
  const algoRes = await supabase.from("algorithms").select("id, capital, rules").eq("name", name).single();
  if (algoRes.error || !algoRes.data) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const algo = algoRes.data as any as { id: string; capital: number; rules: AlgorithmRules };
  const wl = await supabase.from("algorithm_watchlist").select("ticker").eq("algorithm_id", algo.id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ticker = ((wl.data ?? []) as any[])[0]?.ticker?.toUpperCase() ?? "";
  const interval = timeframeToInterval(algo.rules.timeframe);
  const bars = await getBarsNoTtl(supabase, ticker, interval);
  if (!bars) return null;
  const result = runPortfolioBacktest(algo.rules, new Map([[ticker, bars]]), algo.capital, []);
  const trades = result.trades;

  const dailyPnl = new Map<string, number>();
  const tradeDays = new Set<string>();
  const dayDirection = new Map<string, "long" | "short" | "mixed">();
  for (const t of trades) {
    const day = t.entry_date.slice(0, 10);
    tradeDays.add(day);
    const exitDay = t.exit_date.slice(0, 10);
    dailyPnl.set(exitDay, (dailyPnl.get(exitDay) ?? 0) + t.pnl);
    const side = t.side ?? "long";
    const existing = dayDirection.get(day);
    if (!existing) dayDirection.set(day, side);
    else if (existing !== side) dayDirection.set(day, "mixed");
  }
  return { name, shortName: shortName(name), ticker, capital: algo.capital, trades, dailyPnl, tradeDays, dayDirection };
}

interface PairAnalysis {
  a: string;
  b: string;
  daysShared: number;
  daysA: number;
  daysB: number;
  overlapPct: number;
  sameSidePct: number;  // when shared, what % same side?
  pnlCorr: number;     // daily P&L Pearson
  capitalNormalizedCorr: number; // P&L / capital normalised before correlation
}

function analyzePair(a: AlgoData, b: AlgoData): PairAnalysis {
  const sharedDays = [...a.tradeDays].filter((d) => b.tradeDays.has(d));
  const overlapPct = a.tradeDays.size === 0 ? 0 : sharedDays.length / a.tradeDays.size * 100;
  let sameSide = 0, totalShared = 0;
  for (const d of sharedDays) {
    const da = a.dayDirection.get(d);
    const db = b.dayDirection.get(d);
    if (da && db && da !== "mixed" && db !== "mixed") {
      totalShared++;
      if (da === db) sameSide++;
    }
  }
  const sameSidePct = totalShared === 0 ? 0 : sameSide / totalShared * 100;

  // Daily P&L correlation — align dates, fill missing with 0
  const allDays = new Set<string>([...a.dailyPnl.keys(), ...b.dailyPnl.keys()]);
  const days = [...allDays].sort();
  const seriesA = days.map((d) => a.dailyPnl.get(d) ?? 0);
  const seriesB = days.map((d) => b.dailyPnl.get(d) ?? 0);
  const pnlCorr = pearson(seriesA, seriesB);

  // Capital-normalised P&L (so $100K vs $10K capital algos compare fairly)
  const seriesAn = days.map((d) => (a.dailyPnl.get(d) ?? 0) / a.capital);
  const seriesBn = days.map((d) => (b.dailyPnl.get(d) ?? 0) / b.capital);
  const capCorr = pearson(seriesAn, seriesBn);

  return {
    a: a.shortName, b: b.shortName,
    daysShared: sharedDays.length, daysA: a.tradeDays.size, daysB: b.tradeDays.size,
    overlapPct: Math.round(overlapPct * 10) / 10,
    sameSidePct: Math.round(sameSidePct * 10) / 10,
    pnlCorr: Math.round(pnlCorr * 100) / 100,
    capitalNormalizedCorr: Math.round(capCorr * 100) / 100,
  };
}

async function main(): Promise<void> {
  console.log(`\n===== STEP 4 — Algo correlation matrix @ ${new Date().toISOString().slice(0, 16)} =====\n`);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  console.log(`Loading STEP-3 survivors...`);
  const algos: AlgoData[] = [];
  for (const name of STEP3_SURVIVORS) {
    const a = await loadAlgo(supabase, name);
    if (!a) { console.log(`  ${name}: SKIP`); continue; }
    console.log(`  ${a.shortName.padEnd(40)} ${a.trades.length} trades / ${a.tradeDays.size} unique entry-days`);
    algos.push(a);
  }
  if (algos.length < 2) { console.log(`Need ≥2 algos to correlate.`); return; }

  // Pairwise analyses
  console.log(`\n${"=".repeat(120)}\nPAIRWISE ANALYSIS\n${"=".repeat(120)}`);
  console.log(`${"A".padEnd(28)} ${"B".padEnd(28)} ${"shared/A/B".padStart(15)} ${"overlap%".padStart(10)} ${"sameSide%".padStart(10)} ${"pnlCorr".padStart(9)} ${"capCorr".padStart(9)}`);
  const pairs: PairAnalysis[] = [];
  for (let i = 0; i < algos.length; i++) {
    for (let j = i + 1; j < algos.length; j++) {
      const p = analyzePair(algos[i], algos[j]);
      pairs.push(p);
      const sharedStr = `${p.daysShared}/${p.daysA}/${p.daysB}`;
      console.log(`${p.a.padEnd(28)} ${p.b.padEnd(28)} ${sharedStr.padStart(15)} ${p.overlapPct.toString().padStart(10)} ${p.sameSidePct.toString().padStart(10)} ${p.pnlCorr.toString().padStart(9)} ${p.capitalNormalizedCorr.toString().padStart(9)}`);
    }
  }

  // Correlation matrix (capital-normalised pnl correlation)
  console.log(`\n${"=".repeat(120)}\nCAPITAL-NORMALISED P&L CORRELATION MATRIX\n${"=".repeat(120)}`);
  const head = ["".padEnd(28), ...algos.map((a) => a.shortName.slice(0, 12).padStart(12))].join(" ");
  console.log(head);
  for (let i = 0; i < algos.length; i++) {
    const row = [algos[i].shortName.slice(0, 28).padEnd(28)];
    for (let j = 0; j < algos.length; j++) {
      if (i === j) row.push("1.00".padStart(12));
      else {
        const p = pairs.find((p) => (p.a === algos[i].shortName && p.b === algos[j].shortName) || (p.b === algos[i].shortName && p.a === algos[j].shortName));
        row.push(((p?.capitalNormalizedCorr ?? 0).toFixed(2)).padStart(12));
      }
    }
    console.log(row.join(" "));
  }

  // Verdict
  console.log(`\n${"=".repeat(120)}\nVERDICT\n${"=".repeat(120)}`);
  const highly = pairs.filter((p) => Math.abs(p.capitalNormalizedCorr) > 0.7);
  const moderate = pairs.filter((p) => Math.abs(p.capitalNormalizedCorr) > 0.4 && Math.abs(p.capitalNormalizedCorr) <= 0.7);
  const diversifying = pairs.filter((p) => Math.abs(p.capitalNormalizedCorr) <= 0.3);

  console.log(`  Highly correlated pairs (|corr|>0.7):  ${highly.length}`);
  for (const p of highly) console.log(`    ${p.a} <-> ${p.b}: corr=${p.capitalNormalizedCorr}`);
  console.log(`  Moderately correlated (0.4-0.7):       ${moderate.length}`);
  for (const p of moderate) console.log(`    ${p.a} <-> ${p.b}: corr=${p.capitalNormalizedCorr}`);
  console.log(`  Mostly diversifying (|corr|<0.3):      ${diversifying.length}`);
  for (const p of diversifying) console.log(`    ${p.a} <-> ${p.b}: corr=${p.capitalNormalizedCorr}`);

  // High-overlap warning (separate from corr — algos can fire on same days but correlate weakly)
  const sameSideHighOverlap = pairs.filter((p) => p.overlapPct > 50 && p.sameSidePct > 70);
  console.log(`\n  High day-overlap + same-side (>50% days shared, >70% same side): ${sameSideHighOverlap.length}`);
  for (const p of sameSideHighOverlap) console.log(`    ${p.a} <-> ${p.b}: ${p.overlapPct}% days shared, ${p.sameSidePct}% same side`);
}

void main();
