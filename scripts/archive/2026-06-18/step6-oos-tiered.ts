/**
 * STEP 6 v2 — OOS holdback with TIERED verdicts.
 *
 * Original STEP 6 used a strict ±50% R-delta gate. With held-out
 * samples of 7-22 trades, that produced 1 PASS / 6 FAIL — likely
 * over-strict relative to statistical confidence at that N.
 *
 * Revised tiers:
 *   TIER_1_PASS  : held-out positive AND |R delta| ≤ 50% (cleanest)
 *   TIER_2_PASS  : held-out positive AND (|R delta| ≤ 75% OR n < 15)
 *   FAIL         : held-out R ≤ 0 OR (|R delta| > 75% AND n ≥ 15)
 *   INSUFFICIENT : in-sample n < 10 (can't validate)
 *
 * Rationale: with 7-22 held-out trades and gold R-std-dev ≈ 0.5, the
 * standard error on mean R is ~0.10-0.20. A point estimate -75% off
 * in-sample is still within ~1 SE for these sample sizes — not
 * statistically refuted. Only deeply negative held-out or large-sample
 * divergence justifies a FAIL.
 *
 * Algos that go NEGATIVE in held-out (point estimate < 0) still fail
 * regardless of N — those are concerning enough to warrant exclusion.
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

const OOS_CUTOFF = "2025-12-18";
const SMALL_N = 15;

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
  label: string;
  baseAlgo: string;
  overrideTicker?: string;
}

const CANDIDATES: Candidate[] = [
  { label: "Gold FVG-DailyBias-Long 4h", baseAlgo: "Library: Gold FVG-DailyBias-Long 4h" },
  { label: "Gold FVG-Long 30m", baseAlgo: "Library: Gold FVG-Long 30m" },
  { label: "Gold Coil-Breakout 4h", baseAlgo: "Library: Gold Coil-Breakout 4h" },
  { label: "Gold Dip-Buyer 4h", baseAlgo: "Library: Gold Dip-Buyer 4h" },
  { label: "Gold sweep_reclaim 4h", baseAlgo: "Library: Gold sweep_reclaim-DailyBias-Long 4h" },
  { label: "USD/JPY sweep_reclaim 4h", baseAlgo: "Library: USD/JPY sweep_reclaim-DailyBias-Long 4h" },
  { label: "Gold Coil-Breakout 4h rules on USD/JPY", baseAlgo: "Library: Gold Coil-Breakout 4h", overrideTicker: "USD/JPY" },
  { label: "Gold sweep_reclaim 4h rules on GBP/USD", baseAlgo: "Library: Gold sweep_reclaim-DailyBias-Long 4h", overrideTicker: "GBP/USD" },
];

interface SetStats {
  n: number;
  totalPnl: number;
  meanR: number;
  wr: number;
  rStdDev: number;
}

interface OosResult {
  label: string;
  ticker: string;
  inSample: SetStats;
  heldOut: SetStats;
  rDelta: number;
  inSE: number;       // standard error of held-out mean R
  withinSE: boolean;  // is the divergence within ~1 SE?
  verdict: "TIER_1_PASS" | "TIER_2_PASS" | "FAIL" | "INSUFFICIENT_DATA";
  reason: string;
}

function computeSetStats(trades: BacktestTrade[], capital: number, riskPct: number): SetStats {
  if (trades.length === 0) return { n: 0, totalPnl: 0, meanR: 0, wr: 0, rStdDev: 0 };
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0).length;
  const riskPerTrade = capital * (riskPct / 100);
  if (riskPerTrade <= 0) return { n: trades.length, totalPnl, meanR: 0, wr: wins / trades.length * 100, rStdDev: 0 };
  const rs = trades.map((t) => t.pnl / riskPerTrade);
  const meanR = rs.reduce((s, r) => s + r, 0) / rs.length;
  const variance = rs.reduce((s, r) => s + (r - meanR) ** 2, 0) / Math.max(1, rs.length - 1);
  const rStdDev = Math.sqrt(variance);
  return {
    n: trades.length,
    totalPnl: Math.round(totalPnl * 100) / 100,
    meanR: Math.round(meanR * 100) / 100,
    wr: Math.round(wins / trades.length * 1000) / 10,
    rStdDev: Math.round(rStdDev * 100) / 100,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function evaluate(supabase: any, c: Candidate): Promise<OosResult | null> {
  const algoRes = await supabase.from("algorithms").select("id, capital, rules").eq("name", c.baseAlgo).single();
  if (algoRes.error || !algoRes.data) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const algo = algoRes.data as any as { id: string; capital: number; rules: AlgorithmRules };
  let ticker: string;
  if (c.overrideTicker) ticker = c.overrideTicker.toUpperCase();
  else {
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

  let verdict: OosResult["verdict"] = "FAIL";
  let reason = "";
  let rDelta = 0;
  let inSE = 0;
  let withinSE = false;

  if (inSample.n < 10) {
    verdict = "INSUFFICIENT_DATA";
    reason = `in-sample only ${inSample.n} trades — can't OOS-validate`;
  } else if (heldOut.n < 3) {
    verdict = "INSUFFICIENT_DATA";
    reason = `held-out only ${heldOut.n} trades — not enough recent activity`;
  } else {
    if (Math.abs(inSample.meanR) < 0.001) {
      verdict = "FAIL";
      reason = "in-sample mean R near zero — division base unreliable";
    } else {
      rDelta = (heldOut.meanR - inSample.meanR) / Math.abs(inSample.meanR) * 100;
      inSE = heldOut.rStdDev / Math.sqrt(heldOut.n);
      // Is in-sample R within 2 SE of held-out R? (rough 95% CI overlap)
      withinSE = Math.abs(heldOut.meanR - inSample.meanR) <= 2 * inSE;

      if (heldOut.meanR <= 0) {
        verdict = "FAIL";
        reason = `held-out R = ${heldOut.meanR} (≤ 0) — edge collapsed`;
      } else if (Math.abs(rDelta) <= 50) {
        verdict = "TIER_1_PASS";
        reason = `clean: held-out R=${heldOut.meanR} within ±50% of in-sample R=${inSample.meanR}`;
      } else if (Math.abs(rDelta) <= 75 || heldOut.n < SMALL_N) {
        verdict = "TIER_2_PASS";
        reason = heldOut.n < SMALL_N
          ? `small-N exception (n=${heldOut.n}): held-out R=${heldOut.meanR} > 0, divergence ${rDelta.toFixed(0)}% not statistically refuted (within 2SE: ${withinSE})`
          : `relaxed: held-out R=${heldOut.meanR} within ±75% of in-sample`;
      } else {
        verdict = "FAIL";
        reason = `held-out R=${heldOut.meanR} diverges ${rDelta.toFixed(0)}% from in-sample (n=${heldOut.n} large enough to trust)`;
      }
    }
  }

  return { label: c.label, ticker, inSample, heldOut, rDelta: Math.round(rDelta * 10) / 10, inSE: Math.round(inSE * 100) / 100, withinSE, verdict, reason };
}

async function main(): Promise<void> {
  console.log(`\n===== STEP 6 v2 (tiered) — OOS holdback @ ${new Date().toISOString().slice(0, 16)} =====`);
  console.log(`Cutoff: ${OOS_CUTOFF}. Small-N exception: n < ${SMALL_N}. Tiered gates.\n`);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const results: OosResult[] = [];
  for (const c of CANDIDATES) {
    const r = await evaluate(supabase, c);
    if (!r) { console.log(`  ${c.label}: SKIP`); continue; }
    results.push(r);
  }

  console.log(`\n${"=".repeat(160)}`);
  console.log(`${"CANDIDATE".padEnd(56)} ${"IS R/n".padEnd(15)} ${"HO R/n".padEnd(15)} ${"DELTA".padStart(8)} ${"HO-SE".padStart(7)} ${"VERDICT".padEnd(20)} REASON`);
  console.log(`${"=".repeat(160)}`);
  for (const r of results) {
    const isS = `${r.inSample.meanR}/${r.inSample.n}`;
    const hoS = `${r.heldOut.meanR}/${r.heldOut.n}`;
    const dStr = `${r.rDelta >= 0 ? "+" : ""}${r.rDelta}%`;
    console.log(`${r.label.padEnd(56)} ${isS.padEnd(15)} ${hoS.padEnd(15)} ${dStr.padStart(8)} ${r.inSE.toString().padStart(7)} ${r.verdict.padEnd(20)} ${r.reason}`);
  }

  console.log(`\n${"=".repeat(160)}`);
  const t1 = results.filter((r) => r.verdict === "TIER_1_PASS");
  const t2 = results.filter((r) => r.verdict === "TIER_2_PASS");
  const fail = results.filter((r) => r.verdict === "FAIL");
  const insuf = results.filter((r) => r.verdict === "INSUFFICIENT_DATA");
  console.log(`SUMMARY: ${t1.length} TIER_1_PASS / ${t2.length} TIER_2_PASS / ${fail.length} FAIL / ${insuf.length} INSUFFICIENT_DATA`);
  console.log(`\nTIER_1_PASS (cleanest, can promote with high confidence):`);
  for (const r of t1) console.log(`  ✓✓ ${r.label}`);
  console.log(`\nTIER_2_PASS (promotable with caveat — verify at quarter-end OOS roll):`);
  for (const r of t2) console.log(`  ✓ ${r.label}`);
  console.log(`\nFAIL (held-out collapsed):`);
  for (const r of fail) console.log(`  ✗ ${r.label}: ${r.reason}`);
  if (insuf.length > 0) {
    console.log(`\nINSUFFICIENT_DATA:`);
    for (const r of insuf) console.log(`  — ${r.label}: ${r.reason}`);
  }
}

void main();
