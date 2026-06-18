/**
 * Phase 1 gate-rescue — for the 3 forex FVG-DailyBias algos that
 * are "close" to passing (WR 38-46%, DD just over 10%), sweep
 * RR × sl_pct × all 8 gate combos (regime × adx × dxy) to see if
 * any combination rescues them.
 *
 * Gates filter out bad-condition trades, which should reduce trade
 * count + DD AND lift WR if the gate correctly identifies bad
 * setups. If any combo crosses the threshold (DD < 10% + WR ≥ 40%
 * + positive return), that's a rescue.
 *
 * Usage:
 *   pnpm dlx tsx scripts/phase1-gate-rescue.ts
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

const RR_GRID = [1.5, 2, 2.5, 3];
const SL_PCT_GRID = [0.15, 0.2, 0.3, 0.4, 0.5];
const WINNER_MIN_WR = 40;

// Three forex algos closest to passing in the original rescue sweep.
const TARGETS = [
  "Library: EUR/USD FVG-DailyBias-Long 4h", // 46% WR · 10.60% DD
  "Library: GBP/USD FVG-DailyBias-Long 4h", // 42% WR · 10.82% DD
  "Library: USD/JPY FVG-DailyBias-Long 4h", // 38% WR · 11.19% DD
];

interface GateCombo {
  regime: boolean;
  adx: boolean;
  dxy: boolean;
}

const GATE_COMBOS: GateCombo[] = [];
for (const regime of [false, true]) {
  for (const adx of [false, true]) {
    for (const dxy of [false, true]) GATE_COMBOS.push({ regime, adx, dxy });
  }
}

interface CellResult {
  rr: number;
  sl_pct: number;
  gates: GateCombo;
  total_return: number;
  max_drawdown: number;
  trades: number;
  win_rate: number;
  calmar: number | null;
}

function computeResult(rr: number, sl_pct: number, gates: GateCombo, trades: BacktestTrade[], capital: number): CellResult {
  if (trades.length === 0) {
    return { rr, sl_pct, gates, total_return: 0, max_drawdown: 0, trades: 0, win_rate: 0, calmar: null };
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
    rr,
    sl_pct,
    gates,
    total_return: Math.round(cum * 100) / 100,
    max_drawdown: Math.round(maxDd * 100) / 100,
    trades: sorted.length,
    win_rate: Math.round((wins / sorted.length) * 1000) / 10,
    calmar: maxDd > 0 ? Math.round((cum / maxDd) * 100) / 100 : null,
  };
}

function cloneRules(rules: AlgorithmRules, rr: number, sl_pct: number, gates: GateCombo): AlgorithmRules {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = JSON.parse(JSON.stringify(rules)) as any;
  if (r.take_profit?.type === "rr_multiple") r.take_profit.value = rr;
  if (r.stop_loss?.type === "percentage") r.stop_loss.value = sl_pct;
  r.regime_filter = { ...(r.regime_filter ?? {}), enabled: gates.regime };
  r.adx_filter = { ...(r.adx_filter ?? {}), enabled: gates.adx };
  r.dxy_filter = { ...(r.dxy_filter ?? {}), enabled: gates.dxy };
  return r as AlgorithmRules;
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

function gateStr(g: GateCombo): string {
  return `regime=${g.regime ? "on" : "off"} adx=${g.adx ? "on" : "off"} dxy=${g.dxy ? "on" : "off"}`;
}

async function main(): Promise<void> {
  console.log(`\n===== Gate-rescue sweep @ ${new Date().toISOString().slice(0, 16)} =====`);
  console.log(`Grid per algo: RR(${RR_GRID.length}) × sl_pct(${SL_PCT_GRID.length}) × gates(${GATE_COMBOS.length}) = ${RR_GRID.length * SL_PCT_GRID.length * GATE_COMBOS.length} cells\n`);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const algoRes = await supabase
    .from("algorithms")
    .select("id, name, capital, rules")
    .in("name", TARGETS);
  if (algoRes.error) { console.error(algoRes.error.message); process.exit(1); }
  const algos = (algoRes.data ?? []) as unknown as { id: string; name: string; capital: number; rules: AlgorithmRules }[];

  for (const algo of algos) {
    process.stdout.write(`\n  ${algo.name} ...`);
    const wl = await supabase.from("algorithm_watchlist").select("ticker").eq("algorithm_id", algo.id);
    const ticker = ((wl.data ?? []) as { ticker: string }[])[0]?.ticker.toUpperCase() ?? "";
    const interval = timeframeToInterval(algo.rules.timeframe);
    const bars = await loadBars(ticker, interval);
    if (!bars) { console.log(` ✗ no bars`); continue; }
    const prices = new Map([[ticker, bars]]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = algo.rules as any;
    const ddThreshold = r.prop_firm?.max_drawdown ?? 10;

    const cells: CellResult[] = [];
    for (const rr of RR_GRID) {
      for (const sl_pct of SL_PCT_GRID) {
        for (const gates of GATE_COMBOS) {
          const rules = cloneRules(algo.rules, rr, sl_pct, gates);
          const result = runPortfolioBacktest(rules, prices, algo.capital, []);
          cells.push(computeResult(rr, sl_pct, gates, result.trades, algo.capital));
        }
      }
    }

    const eligible = cells.filter(
      (c) => c.trades > 0 && c.total_return > 0 && c.win_rate >= WINNER_MIN_WR && c.max_drawdown < ddThreshold
    );
    eligible.sort((a, b) => (b.calmar ?? -Infinity) - (a.calmar ?? -Infinity));

    console.log(` ${eligible.length}/${cells.length} eligible`);

    if (eligible.length === 0) {
      const closest = cells
        .filter((c) => c.trades > 0)
        .sort((a, b) => a.max_drawdown - b.max_drawdown)[0];
      if (closest) {
        console.log(`    No survivors. Closest by DD: RR=${closest.rr} sl=${closest.sl_pct}% ${gateStr(closest.gates)} → $${closest.total_return} / DD ${closest.max_drawdown}% / WR ${closest.win_rate}%`);
      }
      console.log(`    VERDICT  STILL UNSALVAGEABLE — gates don't rescue this algo either`);
      continue;
    }

    console.log(`    Top 3 survivors:`);
    for (let i = 0; i < Math.min(3, eligible.length); i++) {
      const c = eligible[i];
      console.log(`      ${i + 1}. RR=${c.rr} sl=${c.sl_pct}% ${gateStr(c.gates)}`);
      console.log(`         $${c.total_return} / DD ${c.max_drawdown}% / ${c.trades} trades / WR ${c.win_rate}% / Calmar ${c.calmar?.toFixed(1)}`);
    }
    const monthlyPct = (eligible[0].total_return / algo.capital / 72) * 100;
    console.log(`    VERDICT  GATES RESCUED IT — best monthly equivalent ${monthlyPct.toFixed(2)}% at $${algo.capital.toLocaleString()} capital`);
  }
}

void main();
