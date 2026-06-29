/**
 * E2.10 — Portfolio composer driver.
 *
 * Pre-registered in `phase-e2-sweep-lock.md` § E2.10 Addendum (locked
 * 2026-06-29 LATE BEFORE empirical run).
 *
 * Loads Layer B step2-PASS variants matching universe filter, runs
 * runPortfolioBacktest per variant to capture per-trade R series (not
 * stored in DB step2), runs composePortfolio greedy selection, emits
 * acceptance packet JSON.
 *
 * Compute: ~108 backtests × ~5s = ~10min + correlation walk + greedy =
 * trivial. $0 LLM cost.
 *
 * USAGE:
 *   pnpm dlx tsx scripts/canonical/compose-portfolio.ts
 *
 * Env (defaults match pre-reg):
 *   UNIVERSE_NAME_LIKE         default "LayerB: XAU/USD %-Long 4h | %"
 *   MIN_WIN_RATE               default 37
 *   MAX_STATIC_DD              default 10
 *   MAX_DAILY_DD               default 5
 *   MIN_TRADES                 default 30
 *   PAIRWISE_CORR_CEILING      default 0.40
 *   COMBINED_DD_CEILING        default 10.0
 *   MAX_PORTFOLIO_SIZE         default 5
 *   OUTPUT_JSON                default scripts/canonical/e2-results/portfolio-2026-06-29.json
 *   PERSIST                    default 1
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  composePortfolio,
  DEFAULT_PORTFOLIO_COMPOSER_CONFIG,
  perTradePnlDollarsFromTrades,
  perTradeRFromTrades,
  type CandidateInput,
  type PortfolioComposerConfig,
} from "../../src/lib/algo-search/portfolio-composer";
import { timeframeToInterval } from "../../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../../src/lib/market-data/portfolio-backtest";
import type { Database } from "../../src/lib/supabase/database.types";
import type { PriceBar } from "../../src/lib/market-data/types";
import type { AlgorithmRules } from "../../src/types/algorithm";

function loadEnvLocal(): void {
  try {
    const envText = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
    for (const line of envText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch { /* operator exports envs themselves */ }
}
loadEnvLocal();

const UNIVERSE_NAME_LIKE = process.env.UNIVERSE_NAME_LIKE ?? "LayerB: XAU/USD %-Long 4h | %";
const MIN_WIN_RATE = Number(process.env.MIN_WIN_RATE ?? 37);
const MAX_STATIC_DD = Number(process.env.MAX_STATIC_DD ?? 10);
const MAX_DAILY_DD = Number(process.env.MAX_DAILY_DD ?? 5);
const MIN_TRADES = Math.max(1, Number(process.env.MIN_TRADES ?? 30));
const PAIRWISE_CORR_CEILING = Number(process.env.PAIRWISE_CORR_CEILING ?? 0.4);
// E2.11 fix: default lowered 10.0 → 5.0 to match [[feedback_dd_validation_gate]]
// (operator-locked rule); FTMO 10% is the SECONDARY ceiling. Override via env.
const COMBINED_DD_CEILING = Number(process.env.COMBINED_DD_CEILING ?? 5.0);
const POOL_CAPITAL = Number(process.env.POOL_CAPITAL ?? 10000);
const MAX_PORTFOLIO_SIZE = Math.max(1, Number(process.env.MAX_PORTFOLIO_SIZE ?? 5));
const OUTPUT_JSON =
  process.env.OUTPUT_JSON ?? "scripts/canonical/e2-results/portfolio-2026-06-29-v2.json";
const PERSIST = process.env.PERSIST !== "0";

function requireEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required");
  }
  return { url, key };
}

function riskDollarsFor(rules: AlgorithmRules, capital: number): number {
  const sizing = rules.position_sizing;
  if (sizing?.type === "risk_per_trade") return capital * (sizing.value / 100);
  return capital * 0.01;
}

function extractTicker(name: string): string {
  return name.replace(/^LayerB:\s*/, "").split(" ")[0] ?? "XAU/USD";
}

function extractTimeframe(name: string): string {
  return name.match(/\s(\d+[mh])\s/)?.[1] ?? "4h";
}

async function loadBars(
  sb: SupabaseClient<Database>,
  ticker: string,
  timeframe: string,
): Promise<PriceBar[]> {
  const interval = timeframeToInterval(timeframe);
  const { data, error } = await sb
    .from("price_cache")
    .select("bars")
    .eq("ticker", ticker.toUpperCase())
    .eq("output_size", "full")
    .eq("interval", interval)
    .limit(1)
    .single();
  if (error || !data) {
    throw new Error(`No cached bars for ${ticker} ${interval}: ${error?.message ?? "row missing"}`);
  }
  return data.bars as unknown as PriceBar[];
}

interface UniverseRow {
  id: string;
  name: string;
  rules: AlgorithmRules;
  capital: number;
  total_return: number;
  max_drawdown_pct: number;
  win_rate: number;
  trades: number;
}

async function loadUniverse(sb: SupabaseClient<Database>): Promise<UniverseRow[]> {
  const { data, error } = await sb
    .from("algorithms")
    .select("id, name, rules, capital, backtest_results")
    .like("name", UNIVERSE_NAME_LIKE)
    .not("backtest_results", "is", null);
  if (error || !data) {
    throw new Error(`fetch universe: ${error?.message ?? "no data"}`);
  }
  const out: UniverseRow[] = [];
  for (const r of data) {
    const br = r.backtest_results as Record<string, unknown> | null;
    if (!br) continue;
    const step2 = (br.step2 ?? {}) as Record<string, unknown>;
    if (step2.verdict !== "PASS") continue;
    const wr = Number(step2.win_rate ?? 0);
    const dd = Number(step2.max_drawdown ?? 0);
    const dailyDd = Number(step2.max_daily_dd ?? 0);
    const trades = Number(step2.total_trades ?? 0);
    const ret = Number(step2.total_return ?? 0);
    if (wr < MIN_WIN_RATE) continue;
    if (dd > MAX_STATIC_DD) continue;
    if (dailyDd > MAX_DAILY_DD) continue;
    if (trades < MIN_TRADES) continue;
    if (ret <= 0) continue;
    out.push({
      id: r.id,
      name: r.name,
      rules: r.rules as unknown as AlgorithmRules,
      capital: Number(r.capital),
      total_return: ret,
      max_drawdown_pct: dd,
      win_rate: wr,
      trades,
    });
  }
  return out;
}

async function main(): Promise<void> {
  const { url, key } = requireEnv();
  const sb = createClient<Database>(url, key);

  console.log("E2.10 portfolio composer");
  console.log(`  universe filter : ${UNIVERSE_NAME_LIKE}`);
  console.log(`  hard criteria   : WR ≥ ${MIN_WIN_RATE} + DD ≤ ${MAX_STATIC_DD} + daily_dd ≤ ${MAX_DAILY_DD} + trades ≥ ${MIN_TRADES} + return > 0`);
  console.log(`  composer params : |ρ| ≤ ${PAIRWISE_CORR_CEILING} / combined DD ≤ ${COMBINED_DD_CEILING}% / max size ${MAX_PORTFOLIO_SIZE}`);
  console.log("");

  const universe = await loadUniverse(sb);
  console.log(`Universe candidates (post-filter) : ${universe.length}`);

  if (universe.length === 0) {
    throw new Error("Zero candidates pass hard deploy criteria — universe filter may need adjustment");
  }

  // Sort by total_return DESC (the pre-registered ranking metric)
  universe.sort((a, b) => b.total_return - a.total_return);

  // Backtest each to capture per-trade R series
  // Group by (ticker, timeframe) to avoid re-loading bars
  const barsCache = new Map<string, PriceBar[]>();
  const candidates: CandidateInput[] = [];
  console.log("Loading bars + computing per-trade R series:");
  for (let i = 0; i < universe.length; i++) {
    const v = universe[i];
    const ticker = extractTicker(v.name);
    const timeframe = extractTimeframe(v.name);
    const barsKey = `${ticker}|${timeframe}`;
    let bars = barsCache.get(barsKey);
    if (!bars) {
      bars = await loadBars(sb, ticker, timeframe);
      barsCache.set(barsKey, bars);
      console.log(`  bars cached : ${barsKey} (${bars.length} bars)`);
    }
    const pricesByTicker = new Map<string, PriceBar[]>([[ticker.toUpperCase(), bars]]);
    // E2.11 fix: run at POOL_CAPITAL not v.capital so pnl is on shared pool
    const result = runPortfolioBacktest(v.rules, pricesByTicker, POOL_CAPITAL);
    const trades = result.trades ?? [];
    const risk = riskDollarsFor(v.rules, POOL_CAPITAL);
    const { r, exit_dates } = perTradeRFromTrades(trades, risk);
    const { pnl } = perTradePnlDollarsFromTrades(trades);
    candidates.push({
      id: v.name,
      total_return: v.total_return,
      per_trade_r: r,
      per_trade_pnl_dollars: pnl,
      exit_dates,
      max_drawdown_pct: v.max_drawdown_pct,
    });
    if ((i + 1) % 20 === 0) {
      console.log(`  backtested : ${i + 1}/${universe.length}`);
    }
  }
  console.log(`  backtested : ${universe.length}/${universe.length}`);
  console.log("");

  // Run composer
  const config: PortfolioComposerConfig = {
    ...DEFAULT_PORTFOLIO_COMPOSER_CONFIG,
    pairwise_correlation_ceiling: PAIRWISE_CORR_CEILING,
    combined_portfolio_dd_ceiling: COMBINED_DD_CEILING,
    max_portfolio_size: MAX_PORTFOLIO_SIZE,
    pool_capital: POOL_CAPITAL,
  };
  console.log("Running greedy composer...");
  const composerOut = composePortfolio(candidates, config);

  // Build acceptance packet
  const selected = composerOut.selected.map((id) => {
    const u = universe.find((x) => x.name === id);
    const c = candidates.find((x) => x.id === id);
    return {
      name: id,
      total_return: u?.total_return ?? 0,
      win_rate: u?.win_rate ?? 0,
      max_drawdown_pct: u?.max_drawdown_pct ?? 0,
      trades: u?.trades ?? 0,
      per_trade_r_count: c?.per_trade_r.length ?? 0,
    };
  });

  console.log("");
  console.log("=".repeat(72));
  console.log(`E2.10 PORTFOLIO COMPOSER OUTPUT`);
  console.log("=".repeat(72));
  console.log(`Selected portfolio : ${selected.length} algos (fallback=${composerOut.fallback_applied})`);
  console.log(`Combined DD final  : ${composerOut.combined_dd_final_pct.toFixed(2)}%`);
  console.log("");
  for (let i = 0; i < selected.length; i++) {
    const s = selected[i];
    console.log(`  #${i + 1} ${s.name}`);
    console.log(`     return=$${s.total_return.toFixed(0)} WR=${s.win_rate}% DD=${s.max_drawdown_pct}% trades=${s.trades}`);
  }
  console.log("");
  console.log("Pairwise correlations among selected:");
  const selectedSet = new Set(selected.map((s) => s.name));
  for (const c of composerOut.pairwise_correlations) {
    if (selectedSet.has(c.a) && selectedSet.has(c.b)) {
      console.log(`  corr(${c.a.slice(0, 50)}, ${c.b.slice(0, 50)}) = ${c.corr.toFixed(3)}`);
    }
  }

  const packet = {
    sub_phase: "E2.10 portfolio composer" as const,
    verdict: selected.length >= 1 ? "PASS" : "FAIL",
    pre_registration: {
      lock_doc: "scripts/canonical/phase-e2-sweep-lock.md § E2.10 Addendum (2026-06-29 LATE)",
      params: {
        pairwise_correlation_ceiling: PAIRWISE_CORR_CEILING,
        combined_portfolio_dd_ceiling: COMBINED_DD_CEILING,
        max_portfolio_size: MAX_PORTFOLIO_SIZE,
        min_win_rate: MIN_WIN_RATE,
        max_static_dd: MAX_STATIC_DD,
        max_daily_dd: MAX_DAILY_DD,
        min_trades: MIN_TRADES,
      },
    },
    universe: {
      filter: UNIVERSE_NAME_LIKE,
      candidate_count: universe.length,
    },
    selected_portfolio: selected,
    combined_dd_final_pct: composerOut.combined_dd_final_pct,
    fallback_applied: composerOut.fallback_applied,
    per_step_log: composerOut.per_step_log,
    pairwise_correlations: composerOut.pairwise_correlations.filter(
      (c) => selectedSet.has(c.a) && selectedSet.has(c.b),
    ),
    generated_at: new Date().toISOString(),
  };

  if (PERSIST) {
    mkdirSync(dirname(OUTPUT_JSON), { recursive: true });
    writeFileSync(OUTPUT_JSON, JSON.stringify(packet, null, 2));
    console.log("");
    console.log(`Persisted ${OUTPUT_JSON}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
