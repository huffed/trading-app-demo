/**
 * Phase 2 random search — RETURN-PRIORITY winner picker (per
 * [[feedback_winner_rule_return_within_ftmo]]). Replaces the original
 * prototype's Calmar-based ranking with: filter by FTMO safety (DD
 * ≤ 10%, daily DD ≤ 5%, WR ≥ 40%, positive return) then sort by
 * total_return.
 *
 * Runs on all 3 surviving Gold algos sequentially. For each:
 *   - Current deployed config (baseline)
 *   - Top 5 by return that pass safety
 *   - Recommendation: apply top-return cell if it beats current
 *
 * Usage:
 *   N=300 pnpm dlx tsx scripts/phase2-random-search-return-priority.ts
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { timeframeToInterval } from "../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import { getCachedPrices, savePricesToCache } from "../src/lib/market-data/price-cache";
import { fetchDailyPrices } from "../src/lib/market-data/prices";
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

const N = Number(process.env.N ?? 300);
const WINNER_MIN_WR = 40;

const TARGETS = [
  "Library: Gold FVG-DailyBias-Long 4h",
  "Library: Gold FVG-Long 30m",
  "Library: Gold Coil-Breakout 4h",
];

const AXES = {
  rr: [1.5, 2, 2.25, 2.5, 2.75, 3, 3.5, 4, 5],
  lookback: [3, 4, 5, 6, 8, 10, 12, 16],
  sl_buffer: [0.0, 0.05, 0.1, 0.15, 0.25, 0.4, 0.6],
  risk_per_trade: [0.3, 0.4, 0.5, 0.6, 0.75, 1.0],
  stagnant_max_bars: [12, 18, 24, 36, 48, 72],
  stagnant_min_excursion_r: [0.2, 0.3, 0.5, 0.75, 1.0],
  regime_filter: [false, true],
  adx_filter: [false, true],
};

type AxisKey = keyof typeof AXES;
type Config = Record<AxisKey, number | boolean>;

function sampleConfig(): Config {
  const out = {} as Config;
  for (const [k, vs] of Object.entries(AXES)) {
    out[k as AxisKey] = vs[Math.floor(Math.random() * vs.length)];
  }
  return out;
}

function cloneRules(rules: AlgorithmRules, cfg: Config): AlgorithmRules {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = JSON.parse(JSON.stringify(rules)) as any;
  if (r.take_profit?.type === "rr_multiple") r.take_profit.value = cfg.rr;
  if (r.stop_loss?.type === "swing_anchor") {
    r.stop_loss.lookback = cfg.lookback;
    r.stop_loss.value = cfg.sl_buffer;
  }
  if (r.position_sizing?.type === "risk_per_trade") r.position_sizing.value = cfg.risk_per_trade;
  r.stagnant_exit = {
    ...(r.stagnant_exit ?? {}),
    enabled: true,
    max_bars: cfg.stagnant_max_bars,
    min_excursion_r: cfg.stagnant_min_excursion_r,
  };
  r.regime_filter = { ...(r.regime_filter ?? {}), enabled: cfg.regime_filter };
  r.adx_filter = { ...(r.adx_filter ?? {}), enabled: cfg.adx_filter };
  return r as AlgorithmRules;
}

interface CellResult {
  cfg: Config;
  total_return: number;
  max_drawdown: number;
  max_daily_dd: number;
  trades: number;
  win_rate: number;
  calmar: number | null;
}

function computeResult(cfg: Config, trades: BacktestTrade[], capital: number): CellResult {
  if (trades.length === 0) {
    return { cfg, total_return: 0, max_drawdown: 0, max_daily_dd: 0, trades: 0, win_rate: 0, calmar: null };
  }
  const sorted = [...trades].sort(
    (a, b) => new Date(a.exit_date).getTime() - new Date(b.exit_date).getTime()
  );
  let cum = 0, peak = 0, maxDd = 0, wins = 0;
  const dailyPnl = new Map<string, number>();
  for (const t of sorted) {
    cum += t.pnl;
    if (t.pnl > 0) wins++;
    if (cum > peak) peak = cum;
    const dd = ((peak - cum) / capital) * 100;
    if (dd > maxDd) maxDd = dd;
    const day = t.exit_date.slice(0, 10);
    dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + t.pnl);
  }
  let worstDay = 0;
  for (const v of dailyPnl.values()) if (v < worstDay) worstDay = v;
  const maxDailyDd = (Math.abs(worstDay) / capital) * 100;
  return {
    cfg,
    total_return: Math.round(cum * 100) / 100,
    max_drawdown: Math.round(maxDd * 100) / 100,
    max_daily_dd: Math.round(maxDailyDd * 100) / 100,
    trades: sorted.length,
    win_rate: Math.round((wins / sorted.length) * 1000) / 10,
    calmar: maxDd > 0 ? Math.round((cum / maxDd) * 100) / 100 : null,
  };
}

async function loadBars(
  ticker: string,
  interval: ReturnType<typeof timeframeToInterval>
): Promise<PriceBar[] | null> {
  let prices = await getCachedPrices(ticker, "full", interval);
  if (!prices) {
    try {
      prices = await fetchDailyPrices(ticker, "full", interval);
      savePricesToCache(ticker, "full", prices, interval).catch(() => {});
    } catch { return null; }
  }
  return prices && prices.length >= 30 ? prices : null;
}

function fmtCfg(c: Config): string {
  return `RR=${c.rr} lb=${c.lookback} sl_buf=${c.sl_buffer} risk=${c.risk_per_trade}% stag=${c.stagnant_max_bars}b/${c.stagnant_min_excursion_r}R reg=${c.regime_filter ? "on" : "off"} adx=${c.adx_filter ? "on" : "off"}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function searchAlgo(supabase: any, name: string): Promise<void> {
  const algoRes = await supabase.from("algorithms").select("id, name, capital, rules").eq("name", name).single();
  if (algoRes.error) { console.log(`  ✗ ${name}: ${algoRes.error.message}`); return; }
  const algo = algoRes.data as unknown as { id: string; name: string; capital: number; rules: AlgorithmRules };
  const wl = await supabase.from("algorithm_watchlist").select("ticker").eq("algorithm_id", algo.id);
  const ticker = ((wl.data ?? []) as { ticker: string }[])[0]?.ticker.toUpperCase() ?? "";
  const interval = timeframeToInterval(algo.rules.timeframe);
  const bars = await loadBars(ticker, interval);
  if (!bars) { console.log(`  ✗ ${name}: no bars`); return; }
  const prices = new Map([[ticker, bars]]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = algo.rules as any;
  const ddThreshold = r.prop_firm?.max_drawdown ?? 10;
  const dailyDdThreshold = r.prop_firm?.daily_loss_limit ?? 5;

  console.log(`\n===== ${name} =====`);
  console.log(`  Capital: $${algo.capital.toLocaleString()} · DD≤${ddThreshold}% · daily DD≤${dailyDdThreshold}% · WR≥${WINNER_MIN_WR}%`);
  console.log(`  Sampling ${N} configs...`);

  const startTs = Date.now();
  const results: CellResult[] = [];
  for (let i = 0; i < N; i++) {
    const cfg = sampleConfig();
    const variant = cloneRules(algo.rules, cfg);
    const result = runPortfolioBacktest(variant, prices, algo.capital, []);
    results.push(computeResult(cfg, result.trades, algo.capital));
  }
  const elapsed = (Date.now() - startTs) / 1000;
  console.log(`  Done in ${elapsed.toFixed(0)}s.`);

  // Eligibility: positive + DD<10% + daily DD<5% + WR≥40%
  const eligible = results.filter(
    (c) => c.trades > 0
      && c.total_return > 0
      && c.win_rate >= WINNER_MIN_WR
      && c.max_drawdown < ddThreshold
      && c.max_daily_dd < dailyDdThreshold
  );
  // RANK BY RETURN (per feedback_winner_rule_return_within_ftmo)
  eligible.sort((a, b) => b.total_return - a.total_return);

  console.log(`  Eligible: ${eligible.length}/${results.length}`);

  // Current deployed config (sanity baseline)
  const currentCfg: Config = {
    rr: r.take_profit?.value,
    lookback: r.stop_loss?.lookback,
    sl_buffer: r.stop_loss?.value,
    risk_per_trade: r.position_sizing?.value,
    stagnant_max_bars: r.stagnant_exit?.max_bars ?? 24,
    stagnant_min_excursion_r: r.stagnant_exit?.min_excursion_r ?? 0.5,
    regime_filter: r.regime_filter?.enabled === true,
    adx_filter: r.adx_filter?.enabled === true,
  };
  const baselineResult = runPortfolioBacktest(cloneRules(algo.rules, currentCfg), prices, algo.capital, []);
  const baseline = computeResult(currentCfg, baselineResult.trades, algo.capital);
  console.log(`\n  CURRENT: $${baseline.total_return} / DD ${baseline.max_drawdown}% / daily DD ${baseline.max_daily_dd}% / ${baseline.trades} trades / WR ${baseline.win_rate}% / Calmar ${baseline.calmar?.toFixed(1) ?? "—"}`);
  console.log(`  CURRENT cfg: ${fmtCfg(currentCfg)}`);

  if (eligible.length === 0) {
    console.log(`  No eligible cells. No recommendation.`);
    return;
  }

  console.log(`\n  TOP 5 BY RETURN (within FTMO safety):`);
  for (let i = 0; i < Math.min(5, eligible.length); i++) {
    const c = eligible[i];
    console.log(`    ${i + 1}. $${c.total_return.toString().padStart(7)} · DD ${c.max_drawdown.toFixed(2).padStart(5)}% · daily ${c.max_daily_dd.toFixed(2).padStart(5)}% · ${c.trades} trades · WR ${c.win_rate.toFixed(0)}% · Calmar ${(c.calmar ?? 0).toFixed(0)}`);
    console.log(`       ${fmtCfg(c.cfg)}`);
  }

  const top = eligible[0];
  const liftPct = baseline.total_return > 0 ? ((top.total_return / baseline.total_return - 1) * 100) : Infinity;
  console.log(`\n  TOP RETURN vs CURRENT: ${liftPct >= 0 ? "+" : ""}${liftPct.toFixed(0)}% ($${top.total_return} vs $${baseline.total_return})`);
  if (liftPct > 5) {
    const monthlyCurrent = (baseline.total_return / algo.capital / 72) * 100;
    const monthlyTop = (top.total_return / algo.capital / 72) * 100;
    console.log(`  RECOMMENDATION: APPLY — ${monthlyCurrent.toFixed(2)}%/mo → ${monthlyTop.toFixed(2)}%/mo`);
  } else {
    console.log(`  RECOMMENDATION: keep current (uplift ≤ 5%, within noise)`);
  }
}

async function main(): Promise<void> {
  console.log(`\n===== Phase 2 random search (RETURN priority) @ ${new Date().toISOString().slice(0, 16)} =====`);
  console.log(`N per algo: ${N} · Total: ${TARGETS.length} algos × ${N} = ${TARGETS.length * N} configs`);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  for (const name of TARGETS) await searchAlgo(supabase, name);
}

void main();
