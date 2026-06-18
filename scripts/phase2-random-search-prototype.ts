/**
 * Phase 2 random-search PROTOTYPE — runs N random config samples on
 * a single algorithm and reports top-K by Calmar vs the current
 * geometry-grid winner. Used to size up whether full PR A (random
 * search persistence + UI) is worth building, or if the grid winner
 * is already near-optimal and we should skip ahead to walk-forward.
 *
 * Usage:
 *   pnpm dlx tsx scripts/phase2-random-search-prototype.ts ALGO="Library: Gold FVG-DailyBias-Long 4h" N=500
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

const ALGO = process.env.ALGO ?? "Library: Gold FVG-DailyBias-Long 4h";
const N = Number(process.env.N ?? 300);
const WINNER_MIN_WR = 37;

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
  trades: number;
  win_rate: number;
  calmar: number | null;
}

function computeResult(cfg: Config, trades: BacktestTrade[], capital: number): CellResult {
  if (trades.length === 0) {
    return { cfg, total_return: 0, max_drawdown: 0, trades: 0, win_rate: 0, calmar: null };
  }
  const sorted = [...trades].sort(
    (a, b) => new Date(a.exit_date).getTime() - new Date(b.exit_date).getTime()
  );
  let cum = 0, peak = 0, maxDd = 0, wins = 0;
  for (const t of sorted) {
    cum += t.pnl;
    if (t.pnl > 0) wins++;
    if (cum > peak) peak = cum;
    const dd = ((peak - cum) / capital) * 100;
    if (dd > maxDd) maxDd = dd;
  }
  return {
    cfg,
    total_return: Math.round(cum * 100) / 100,
    max_drawdown: Math.round(maxDd * 100) / 100,
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
    } catch {
      return null;
    }
  }
  return prices && prices.length >= 30 ? prices : null;
}

async function main(): Promise<void> {
  console.log(`\n===== Random search prototype @ ${new Date().toISOString().slice(0, 16)} =====`);
  console.log(`ALGO: ${ALGO}`);
  console.log(`N: ${N}`);
  console.log(`Axes: ${Object.entries(AXES).map(([k, vs]) => `${k}(${vs.length})`).join(" × ")}`);
  console.log(`Total space size: ${Object.values(AXES).reduce((a, b) => a * b.length, 1)} configs`);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const algoRes = await supabase.from("algorithms").select("id, name, capital, rules").eq("name", ALGO).single();
  if (algoRes.error) { console.error(algoRes.error.message); process.exit(1); }
  const algo = algoRes.data as unknown as { id: string; name: string; capital: number; rules: AlgorithmRules };
  const wl = await supabase.from("algorithm_watchlist").select("ticker").eq("algorithm_id", algo.id);
  const ticker = ((wl.data ?? []) as { ticker: string }[])[0]?.ticker.toUpperCase() ?? "";
  const interval = timeframeToInterval(algo.rules.timeframe);
  const bars = await loadBars(ticker, interval);
  if (!bars) { console.error(`No bars for ${ticker} ${interval}`); process.exit(1); }
  const prices = new Map([[ticker, bars]]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = algo.rules as any;
  const ddThreshold = r.prop_firm?.max_drawdown ?? 10;

  console.log(`\nRunning ${N} samples...`);
  const startTs = Date.now();
  const results: CellResult[] = [];
  for (let i = 0; i < N; i++) {
    const cfg = sampleConfig();
    const variant = cloneRules(algo.rules, cfg);
    const result = runPortfolioBacktest(variant, prices, algo.capital, []);
    results.push(computeResult(cfg, result.trades, algo.capital));
    if ((i + 1) % 50 === 0) {
      const elapsed = (Date.now() - startTs) / 1000;
      const rate = (i + 1) / elapsed;
      const eta = (N - i - 1) / rate;
      console.log(`  ${i + 1}/${N} · ${elapsed.toFixed(0)}s elapsed · ${rate.toFixed(1)} cfg/s · ETA ${eta.toFixed(0)}s`);
    }
  }
  const elapsed = (Date.now() - startTs) / 1000;
  console.log(`Done in ${elapsed.toFixed(0)}s.\n`);

  // Eligible = passes DD + WR + positive
  const eligible = results.filter(
    (c) => c.trades > 0 && c.total_return > 0 && c.win_rate >= WINNER_MIN_WR && c.max_drawdown < ddThreshold
  );
  eligible.sort((a, b) => (b.calmar ?? -Infinity) - (a.calmar ?? -Infinity));

  console.log(`Eligible cells (DD<${ddThreshold}% + WR≥${WINNER_MIN_WR}% + positive): ${eligible.length}/${N}`);
  console.log(`\nTop 10 by Calmar:\n`);
  console.log("  RANK  RETURN     DD%   TRADES   WR%  CALMAR   CONFIG");
  for (let i = 0; i < Math.min(10, eligible.length); i++) {
    const c = eligible[i];
    const cfgStr = `RR=${c.cfg.rr} lb=${c.cfg.lookback} sl_buf=${c.cfg.sl_buffer} risk=${c.cfg.risk_per_trade}% stag=${c.cfg.stagnant_max_bars}b/${c.cfg.stagnant_min_excursion_r}R reg=${c.cfg.regime_filter ? "on" : "off"} adx=${c.cfg.adx_filter ? "on" : "off"}`;
    console.log(`  ${(i + 1).toString().padStart(4)}  $${c.total_return.toString().padStart(7)}  ${c.max_drawdown.toFixed(2).padStart(5)}  ${c.trades.toString().padStart(6)}   ${c.win_rate.toFixed(0).padStart(3)}  ${(c.calmar ?? 0).toFixed(1).padStart(6)}   ${cfgStr}`);
  }

  // Compare top hit to the current deployed config
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
  // Run the current config too for a sanity baseline
  const baselineResult = runPortfolioBacktest(cloneRules(algo.rules, currentCfg), prices, algo.capital, []);
  const baseline = computeResult(currentCfg, baselineResult.trades, algo.capital);
  console.log(`\nCurrent deployed:  $${baseline.total_return} / DD ${baseline.max_drawdown}% / ${baseline.trades} trades / WR ${baseline.win_rate}% / Calmar ${baseline.calmar?.toFixed(1) ?? "—"}`);
  if (eligible.length > 0) {
    const top = eligible[0];
    const liftPct = baseline.total_return > 0 ? ((top.total_return / baseline.total_return - 1) * 100).toFixed(0) : "n/a";
    const liftCalmar = baseline.calmar != null && top.calmar != null
      ? ((top.calmar / baseline.calmar - 1) * 100).toFixed(0)
      : "n/a";
    console.log(`Top random hit:    $${top.total_return} / DD ${top.max_drawdown}% / ${top.trades} trades / WR ${top.win_rate}% / Calmar ${top.calmar?.toFixed(1) ?? "—"}`);
    console.log(`\nUplift: return ${liftPct}% · Calmar ${liftCalmar}%`);
    console.log(`Verdict: ${Number(liftPct) > 30 ? "FULL PR A WORTH BUILDING" : Number(liftPct) > 10 ? "MARGINAL — walk-forward likely more valuable" : "GRID WINNER NEAR OPTIMAL — skip to walk-forward"}`);
  }
}

void main();
