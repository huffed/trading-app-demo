/**
 * STEP 2 cost-simulation gate (per roadmap-2026-06).
 *
 * Re-validates every deployed library algo + flagship under realistic
 * friction values DERIVED FROM EMPIRICAL FTMO MT5 fills (37-trade sample
 * shows avg adverse slippage = 3.31 bps; not the 0.4/0.5 from CLAUDE.md
 * and not the conservative 10/5 currently deployed).
 *
 * Two configs per algo:
 *   - "deployed"  — current friction config from DB (10/5/0)
 *   - "realistic" — slippage_bps=3, spread_bps=0, comm_per_lot=0
 *
 * Output: per-algo
 *   - total / WR / static DD / daily DD under each config
 *   - delta (does the algo IMPROVE under realistic friction? — likely yes,
 *     since deployed is too pessimistic on slippage)
 *   - FTMO+37%WR survival verdict under realistic friction
 *
 * STEP 2 gate per roadmap: "any config that drops materially under
 * realistic costs gets disqualified or reverted."
 *
 * NOTE: empirical sample shows realistic friction is LOWER than deployed,
 * so this gate primarily ENABLES algos rather than disqualifying them.
 * The disqualification path applies if a borderline algo only survived
 * via the friction overstatement.
 */
import { readFileSync } from "fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { timeframeToInterval } from "../src/lib/market-data/interval";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import type { BacktestTrade, PriceBar } from "../src/lib/market-data/types";
import type { AlgorithmRules } from "../src/types/algorithm";

/** TTL-bypass cache reader. Validation scripts want HISTORICAL bars;
 *  freshness doesn't matter for backtest replay. The 1h TTL on
 *  getCachedPrices is for live-scan freshness, not for validation. */
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

interface Stats {
  total: number;
  trades: number;
  wr: number;
  sdd: number;
  ddd: number;
  pdd: number;
}

function computeStats(trades: BacktestTrade[], capital: number): Stats {
  if (trades.length === 0) return { total: 0, trades: 0, wr: 0, sdd: 0, ddd: 0, pdd: 0 };
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
  const ddd = worstDay < 0 ? ((-worstDay) / capital) * 100 : 0;
  return {
    total: Math.round(cum * 100) / 100,
    trades: sorted.length,
    wr: Math.round(wins / sorted.length * 1000) / 10,
    sdd: Math.round(maxSdd * 100) / 100,
    ddd: Math.round(ddd * 100) / 100,
    pdd: Math.round(maxPdd * 100) / 100,
  };
}

function withFriction(rules: AlgorithmRules, slip: number, spread: number, commPerLot: number): AlgorithmRules {
  const r = JSON.parse(JSON.stringify(rules)) as AlgorithmRules;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pf = (r as any).prop_firm ?? {};
  pf.slippage_bps = slip;
  pf.spread_bps = spread;
  pf.commission_per_lot = commPerLot;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (r as any).prop_firm = pf;
  return r;
}

interface AlgoVerdict {
  name: string;
  ticker: string;
  capital: number;
  status: string;
  deployed: Stats;
  realistic: Stats;
  deltaPct: number;
  passDeployed: boolean;
  passRealistic: boolean;
  verdict: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function verifyAlgo(supabase: any, name: string): Promise<AlgoVerdict | null> {
  const algoRes = await supabase.from("algorithms").select("id, capital, rules, status").eq("name", name).single();
  if (algoRes.error || !algoRes.data) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const algo = algoRes.data as any as { id: string; capital: number; rules: AlgorithmRules; status: string };
  const wl = await supabase.from("algorithm_watchlist").select("ticker").eq("algorithm_id", algo.id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ticker = ((wl.data ?? []) as any[])[0]?.ticker?.toUpperCase() ?? "";
  if (!ticker) return null;
  const interval = timeframeToInterval(algo.rules.timeframe);
  const bars = await getBarsNoTtl(supabase, ticker, interval);
  if (!bars) return null;
  const prices = new Map([[ticker, bars]]);

  const deployedResult = runPortfolioBacktest(algo.rules, prices, algo.capital, []);
  const deployedStats = computeStats(deployedResult.trades, algo.capital);

  const realisticRules = withFriction(algo.rules, 3, 0, 0);
  const realisticResult = runPortfolioBacktest(realisticRules, prices, algo.capital, []);
  const realisticStats = computeStats(realisticResult.trades, algo.capital);

  const deltaPct = deployedStats.total === 0
    ? 0
    : ((realisticStats.total - deployedStats.total) / Math.abs(deployedStats.total)) * 100;

  const ftmoSafe = (s: Stats) => s.sdd < 10 && s.ddd < 5 && s.wr >= 37 && s.total > 0;
  const passDeployed = ftmoSafe(deployedStats);
  const passRealistic = ftmoSafe(realisticStats);

  let verdict: string;
  if (passDeployed && passRealistic) verdict = "PASS BOTH";
  else if (!passDeployed && passRealistic) verdict = "UNLOCKED by realistic friction";
  else if (passDeployed && !passRealistic) verdict = "FRICTION KILLS — disqualify";
  else verdict = "FAILS BOTH";

  return { name, ticker, capital: algo.capital, status: algo.status, deployed: deployedStats, realistic: realisticStats, deltaPct, passDeployed, passRealistic, verdict };
}

async function main(): Promise<void> {
  console.log(`\n===== STEP 2 friction re-validation @ ${new Date().toISOString().slice(0, 16)} =====`);
  console.log(`Empirical friction: slip=3 bps, spread=0, comm=0 (from 37-trade FTMO sample)\n`);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const TARGETS = [
    "Gold Swing 4h",
    "Library: Gold FVG-DailyBias-Long 4h",
    "Library: Gold FVG-Long 30m",
    "Library: Gold Coil-Breakout 4h",
    "Library: Gold Coil-Breakout 1h",
    "Library: Gold Dip-Buyer 4h",
    "Library: Gold OTE-Long 4h",
    "Library: Gold sweep_reclaim-DailyBias-Long 4h",
    "Library: Gold Bear-Short Sentinel 4h",
    "Library: USD/JPY FVG-DailyBias-Long 4h",
    "Library: USD/JPY Coil-Breakout-Long 4h",
    "Library: USD/JPY Dip-Buyer-Long 4h",
    "Library: USD/JPY sweep_reclaim-DailyBias-Long 4h",
    "Library: GBP/USD FVG-DailyBias-Long 4h",
    "Library: GBP/USD Dip-Buyer-Long 4h",
    "Library: EUR/USD FVG-DailyBias-Long 4h",
    "Library: EUR/USD Dip-Buyer-Long 4h",
  ];

  const verdicts: AlgoVerdict[] = [];
  for (const name of TARGETS) {
    const v = await verifyAlgo(supabase, name);
    if (v) verdicts.push(v);
    else console.log(`  ${name}: SKIP (no bars / not in DB)`);
  }

  console.log(`\n${"=".repeat(120)}`);
  console.log(`${"NAME".padEnd(48)} ${"STATUS".padEnd(8)} ${"DEPLOYED ($/WR/DD)".padEnd(30)} ${"REALISTIC ($/WR/DD)".padEnd(30)} ${"VERDICT"}`);
  console.log(`${"=".repeat(120)}`);
  for (const v of verdicts) {
    const dep = `$${v.deployed.total.toFixed(0).padStart(7)}/${v.deployed.wr.toString().padStart(4)}%/${v.deployed.sdd.toFixed(1)}%`;
    const real = `$${v.realistic.total.toFixed(0).padStart(7)}/${v.realistic.wr.toString().padStart(4)}%/${v.realistic.sdd.toFixed(1)}%`;
    console.log(`${v.name.padEnd(48)} ${v.status.padEnd(8)} ${dep.padEnd(30)} ${real.padEnd(30)} ${v.verdict}`);
  }
  console.log(`${"=".repeat(120)}\n`);

  // Summaries
  const survivors = verdicts.filter((v) => v.passRealistic);
  const newlyEnabled = verdicts.filter((v) => !v.passDeployed && v.passRealistic);
  const friction_kills = verdicts.filter((v) => v.passDeployed && !v.passRealistic);
  const failBoth = verdicts.filter((v) => !v.passDeployed && !v.passRealistic);

  console.log(`SUMMARY:`);
  console.log(`  Survives under realistic friction:  ${survivors.length}/${verdicts.length}`);
  console.log(`  Unlocked by realistic friction:     ${newlyEnabled.length}  ${newlyEnabled.map((v) => v.name).join(", ")}`);
  console.log(`  Friction kills (was passing):       ${friction_kills.length}  ${friction_kills.map((v) => v.name).join(", ")}`);
  console.log(`  Fails both:                         ${failBoth.length}`);
}

void main();
