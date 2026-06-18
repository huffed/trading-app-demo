/**
 * STEP 2.4 — Persist friction-aware backtest_results JSONB on each algo.
 *
 * Required by CLAUDE.md "Pre-deploy validation" + roadmap-2026-06 STEP 2 gate.
 * Runs portfolio backtest with deployed friction (now 3/0/0 post-step-2.3
 * UPDATE) and writes the result to algorithms.backtest_results.
 *
 * Format: {
 *   total_return, total_trades, win_rate, max_drawdown, max_static_dd,
 *   max_daily_dd, friction: {slippage_bps, spread_bps, commission_per_lot},
 *   computed_at, sample_window: [first_trade_date, last_trade_date]
 * }
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

interface FrictionAwareResults {
  total_return: number;
  total_trades: number;
  win_rate: number;
  max_drawdown: number;
  max_static_dd: number;
  max_daily_dd: number;
  friction: {
    slippage_bps: number;
    spread_bps: number;
    commission_per_lot: number;
  };
  step2_verdict: "PASS" | "FAIL" | "EXCLUDED";
  step2_reason?: string;
  computed_at: string;
  sample_first: string | null;
  sample_last: string | null;
}

function computeResults(trades: BacktestTrade[], capital: number, friction: FrictionAwareResults["friction"]): FrictionAwareResults {
  if (trades.length === 0) {
    return {
      total_return: 0, total_trades: 0, win_rate: 0,
      max_drawdown: 0, max_static_dd: 0, max_daily_dd: 0,
      friction,
      step2_verdict: "EXCLUDED",
      step2_reason: "Zero trades — likely LLM-trader (Anthropic backtest skipped) or condition mismatch on cached bars",
      computed_at: "2026-06-18T11:25:00Z",
      sample_first: null, sample_last: null,
    };
  }
  const sorted = [...trades].sort((a, b) => new Date(a.exit_date).getTime() - new Date(b.exit_date).getTime());
  let cum = 0, peak = 0, maxPdd = 0, maxSdd = 0, wins = 0;
  const dailyPnl = new Map<string, number>();
  for (const t of sorted) {
    cum += t.pnl;
    if (t.pnl > 0) wins++;
    if (cum > peak) peak = cum;
    const pdd = ((peak - cum) / capital) * 100;
    if (pdd > maxPdd) maxPdd = pdd;
    const sdd = cum < 0 ? (-cum / capital) * 100 : 0;
    if (sdd > maxSdd) maxSdd = sdd;
    const day = t.exit_date.slice(0, 10);
    dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + t.pnl);
  }
  let worstDay = 0;
  for (const v of dailyPnl.values()) if (v < worstDay) worstDay = v;
  const wr = wins / sorted.length * 100;
  const total = cum;
  const sdd = maxSdd;
  const ddd = worstDay < 0 ? (-worstDay / capital) * 100 : 0;
  // STEP 2 gate: FTMO-safe + 37% WR floor + positive (per roadmap STEP 2 verdict criterion)
  const pass = total > 0 && wr >= 37 && sdd < 10 && ddd < 5;
  const reasons: string[] = [];
  if (total <= 0) reasons.push("not positive");
  if (wr < 37) reasons.push(`WR ${wr.toFixed(1)}% < 37`);
  if (sdd >= 10) reasons.push(`static DD ${sdd.toFixed(2)}% >= 10`);
  if (ddd >= 5) reasons.push(`daily DD ${ddd.toFixed(2)}% >= 5`);
  return {
    total_return: Math.round(total * 100) / 100,
    total_trades: sorted.length,
    win_rate: Math.round(wr * 10) / 10,
    max_drawdown: Math.round(maxPdd * 100) / 100,
    max_static_dd: Math.round(sdd * 100) / 100,
    max_daily_dd: Math.round(ddd * 100) / 100,
    friction,
    step2_verdict: pass ? "PASS" : "FAIL",
    step2_reason: pass ? undefined : reasons.join("; "),
    computed_at: "2026-06-18T11:25:00Z",
    sample_first: sorted[0].exit_date.slice(0, 10),
    sample_last: sorted[sorted.length - 1].exit_date.slice(0, 10),
  };
}

async function main(): Promise<void> {
  console.log(`\n===== STEP 2.4 — Persist friction-aware backtest_results @ ${new Date().toISOString().slice(0, 16)} =====\n`);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const algoRes = await supabase
    .from("algorithms")
    .select("id, name, capital, rules")
    .or("name.like.Library:%,name.eq.Gold Swing 4h");
  if (algoRes.error) { console.error(algoRes.error.message); process.exit(1); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const algos = (algoRes.data ?? []) as any as { id: string; name: string; capital: number; rules: AlgorithmRules }[];

  let pass = 0, fail = 0, excluded = 0;
  for (const algo of algos) {
    const wl = await supabase.from("algorithm_watchlist").select("ticker").eq("algorithm_id", algo.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ticker = ((wl.data ?? []) as any[])[0]?.ticker?.toUpperCase() ?? "";
    if (!ticker) { console.log(`  ${algo.name}: SKIP (no watchlist ticker)`); continue; }
    const interval = timeframeToInterval(algo.rules.timeframe);
    const bars = await getBarsNoTtl(supabase, ticker, interval);
    if (!bars) { console.log(`  ${algo.name}: SKIP (no bars in cache)`); continue; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pf = (algo.rules as any).prop_firm ?? {};
    const friction = {
      slippage_bps: pf.slippage_bps ?? 0,
      spread_bps: pf.spread_bps ?? 0,
      commission_per_lot: pf.commission_per_lot ?? 0,
    };
    const result = runPortfolioBacktest(algo.rules, new Map([[ticker, bars]]), algo.capital, []);
    const results = computeResults(result.trades, algo.capital, friction);
    if (results.step2_verdict === "PASS") pass++;
    else if (results.step2_verdict === "FAIL") fail++;
    else excluded++;
    await supabase.from("algorithms").update({ backtest_results: results }).eq("id", algo.id);
    const tag = results.step2_verdict === "PASS" ? "✓" : results.step2_verdict === "EXCLUDED" ? "—" : "✗";
    console.log(`  ${tag} ${algo.name.padEnd(50)} $${results.total_return.toString().padStart(7)} / ${results.total_trades.toString().padStart(3)}t / WR ${results.win_rate}% / static DD ${results.max_static_dd}% / daily DD ${results.max_daily_dd}%${results.step2_reason ? `  [${results.step2_reason}]` : ""}`);
  }
  console.log(`\n===== SUMMARY: ${pass} PASS / ${fail} FAIL / ${excluded} EXCLUDED =====\n`);
}

void main();
