/**
 * STEP 6 — Out-of-sample holdback (per roadmap-2026-06).
 *
 * Lock the most recent 6 months as held-out. For each candidate,
 * compare in-sample (everything before cutoff) vs held-out mean R per
 * trade. Pass if held-out within ±50% of in-sample.
 *
 * Cutoff: 2025-12-18 (6 months back from today 2026-06-18).
 *
 * Per roadmap STEP 6: "Deploy only if held-out test confirms expected
 * R within ±50% of in-sample. Re-roll the holdout window quarterly."
 *
 * Output / gate to step 7: every config queued for promotion has a
 * "passed OOS holdout" stamp + the variance vs in-sample.
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

const OOS_CUTOFF = "2025-12-18"; // 6 months back from today (2026-06-18)

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

interface Candidate {
  label: string;          // display label
  baseAlgo: string;       // algorithm name in DB to source rules from
  overrideTicker?: string; // if set, run on this ticker instead of the algo's watchlist
}

const CANDIDATES: Candidate[] = [
  { label: "Gold FVG-DailyBias-Long 4h", baseAlgo: "Library: Gold FVG-DailyBias-Long 4h" },
  { label: "Gold FVG-Long 30m", baseAlgo: "Library: Gold FVG-Long 30m" },
  { label: "Gold Coil-Breakout 4h", baseAlgo: "Library: Gold Coil-Breakout 4h" },
  { label: "Gold Dip-Buyer 4h", baseAlgo: "Library: Gold Dip-Buyer 4h" },
  { label: "Gold sweep_reclaim 4h", baseAlgo: "Library: Gold sweep_reclaim-DailyBias-Long 4h" },
  { label: "USD/JPY sweep_reclaim 4h", baseAlgo: "Library: USD/JPY sweep_reclaim-DailyBias-Long 4h" },
  { label: "Gold Coil-Breakout 4h rules on USD/JPY (STEP 5 passer)", baseAlgo: "Library: Gold Coil-Breakout 4h", overrideTicker: "USD/JPY" },
  { label: "Gold sweep_reclaim 4h rules on GBP/USD (STEP 5 passer)", baseAlgo: "Library: Gold sweep_reclaim-DailyBias-Long 4h", overrideTicker: "GBP/USD" },
];

interface SetStats {
  n: number;
  totalPnl: number;
  meanPnl: number;
  wr: number;
  meanR: number;        // mean pnl / risk_per_trade_$
}

interface OosResult {
  label: string;
  ticker: string;
  inSample: SetStats;
  heldOut: SetStats;
  rDelta: number;       // (heldOut.meanR - inSample.meanR) / |inSample.meanR| × 100
  inWindow: boolean;    // within ±50%?
  verdict: "PASS" | "FAIL" | "INSUFFICIENT_DATA";
  reason: string;
}

function computeSetStats(trades: BacktestTrade[], capital: number, riskPct: number): SetStats {
  if (trades.length === 0) return { n: 0, totalPnl: 0, meanPnl: 0, wr: 0, meanR: 0 };
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0).length;
  const riskPerTrade = capital * (riskPct / 100);
  const meanR = riskPerTrade > 0 ? totalPnl / trades.length / riskPerTrade : 0;
  return {
    n: trades.length,
    totalPnl: Math.round(totalPnl * 100) / 100,
    meanPnl: Math.round(totalPnl / trades.length * 100) / 100,
    wr: Math.round(wins / trades.length * 1000) / 10,
    meanR: Math.round(meanR * 100) / 100,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function evaluate(supabase: any, c: Candidate): Promise<OosResult | null> {
  const algoRes = await supabase.from("algorithms").select("id, capital, rules").eq("name", c.baseAlgo).single();
  if (algoRes.error || !algoRes.data) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const algo = algoRes.data as any as { id: string; capital: number; rules: AlgorithmRules };
  let ticker: string;
  if (c.overrideTicker) {
    ticker = c.overrideTicker.toUpperCase();
  } else {
    const wl = await supabase.from("algorithm_watchlist").select("ticker").eq("algorithm_id", algo.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ticker = ((wl.data ?? []) as any[])[0]?.ticker?.toUpperCase() ?? "";
  }
  const interval = timeframeToInterval(algo.rules.timeframe);
  const bars = await getBarsNoTtl(supabase, ticker, interval);
  if (!bars) return null;
  const result = runPortfolioBacktest(algo.rules, new Map([[ticker, bars]]), algo.capital, []);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const riskPct = ((algo.rules as any).position_sizing?.value ?? 1);

  const cutoffMs = new Date(OOS_CUTOFF).getTime();
  const inSampleTrades = result.trades.filter((t) => new Date(t.exit_date).getTime() < cutoffMs);
  const heldOutTrades = result.trades.filter((t) => new Date(t.exit_date).getTime() >= cutoffMs);

  const inSample = computeSetStats(inSampleTrades, algo.capital, riskPct);
  const heldOut = computeSetStats(heldOutTrades, algo.capital, riskPct);

  // Verdict logic
  let verdict: OosResult["verdict"] = "FAIL";
  let reason = "";
  let rDelta = 0;
  let inWindow = false;
  if (inSample.n < 10) {
    verdict = "INSUFFICIENT_DATA";
    reason = `in-sample only ${inSample.n} trades — can't OOS-validate`;
  } else if (heldOut.n < 3) {
    verdict = "INSUFFICIENT_DATA";
    reason = `held-out only ${heldOut.n} trades — not enough recent activity`;
  } else {
    // Compare mean R
    if (Math.abs(inSample.meanR) < 0.001) {
      verdict = "FAIL";
      reason = "in-sample mean R near zero — division base unreliable";
    } else {
      rDelta = (heldOut.meanR - inSample.meanR) / Math.abs(inSample.meanR) * 100;
      inWindow = Math.abs(rDelta) <= 50;
      if (inWindow && heldOut.totalPnl > 0) {
        verdict = "PASS";
        reason = `held-out meanR ${heldOut.meanR} within ±50% of in-sample ${inSample.meanR}`;
      } else if (heldOut.totalPnl <= 0) {
        verdict = "FAIL";
        reason = `held-out total negative ($${heldOut.totalPnl}) — edge gone`;
      } else {
        verdict = "FAIL";
        reason = `held-out meanR ${heldOut.meanR} diverges ${rDelta > 0 ? "+" : ""}${rDelta.toFixed(0)}% from in-sample ${inSample.meanR}`;
      }
    }
  }

  return { label: c.label, ticker, inSample, heldOut, rDelta: Math.round(rDelta * 10) / 10, inWindow, verdict, reason };
}

async function main(): Promise<void> {
  console.log(`\n===== STEP 6 — OOS holdback @ ${new Date().toISOString().slice(0, 16)} =====`);
  console.log(`Cutoff: ${OOS_CUTOFF} (last 6 months held-out)\n`);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const results: OosResult[] = [];
  for (const c of CANDIDATES) {
    const r = await evaluate(supabase, c);
    if (!r) { console.log(`  ${c.label}: SKIP`); continue; }
    results.push(r);
  }

  console.log(`\n${"=".repeat(140)}`);
  console.log(`${"CANDIDATE".padEnd(58)} ${"TICKER".padEnd(8)} ${"IN-SAMPLE".padEnd(28)} ${"HELD-OUT".padEnd(28)} ${"R DELTA".padStart(8)} VERDICT`);
  console.log(`${"=".repeat(140)}`);
  for (const r of results) {
    const isStr = `$${r.inSample.totalPnl}/${r.inSample.n}t/R=${r.inSample.meanR}/WR${r.inSample.wr}%`;
    const hoStr = `$${r.heldOut.totalPnl}/${r.heldOut.n}t/R=${r.heldOut.meanR}/WR${r.heldOut.wr}%`;
    const deltaStr = r.rDelta >= 0 ? `+${r.rDelta}%` : `${r.rDelta}%`;
    console.log(`${r.label.padEnd(58)} ${r.ticker.padEnd(8)} ${isStr.padEnd(28)} ${hoStr.padEnd(28)} ${deltaStr.padStart(8)} ${r.verdict}${r.verdict !== "PASS" ? "  [" + r.reason + "]" : ""}`);
  }

  console.log(`\n${"=".repeat(140)}`);
  const pass = results.filter((r) => r.verdict === "PASS");
  const fail = results.filter((r) => r.verdict === "FAIL");
  const insufficient = results.filter((r) => r.verdict === "INSUFFICIENT_DATA");
  console.log(`SUMMARY: ${pass.length} PASS / ${fail.length} FAIL / ${insufficient.length} INSUFFICIENT_DATA\n`);
  if (pass.length > 0) {
    console.log(`PASS — held-out R within ±50% of in-sample (OOS stamp earned):`);
    for (const r of pass) console.log(`  ✓ ${r.label}`);
  }
  if (fail.length > 0) {
    console.log(`\nFAIL — held-out diverges from in-sample (overfit OR regime change):`);
    for (const r of fail) console.log(`  ✗ ${r.label}: ${r.reason}`);
  }
  if (insufficient.length > 0) {
    console.log(`\nINSUFFICIENT_DATA:`);
    for (const r of insufficient) console.log(`  — ${r.label}: ${r.reason}`);
  }
}

void main();
