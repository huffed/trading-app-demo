/* eslint-disable no-console */
/**
 * S1.5 priority #5 — OTE-Long 4h DD reduction via regime gate.
 *
 * Current state: `Library: Gold OTE-Long 4h` deployed paper-only with
 * no market_state_gate. Per OTE standalone validation
 * (PR #257): mean_R +0.28 / n=209 / peak-to-trough DD 11.6% on gold —
 * just over the FTMO 10% cap.
 *
 * Goal: find a regime gate that drops DD <10% while preserving most
 * of the +0.28R per-trade edge. Two approaches:
 *   - block-mode: exclude regimes that contribute disproportionately to DD
 *   - allow-mode: only enter in regimes with positive expectancy
 *
 * Method: run OTE-Long on XAU/USD 6yr corpus once UNGATED to get
 * baseline trades. Then re-run with each gate candidate and compare
 * peak-to-trough DD + total R + trade count.
 *
 * Gate candidates (each tested independently):
 *   G1  block mtf=fast_div_bull           (V1.2 said bad for longs)
 *   G2  block dxy=usd_down                (V1.2 said bad for longs)
 *   G3  block mtf=fast_div_bull + dxy=usd_down (combined)
 *   G4  block range=compressed            (V1.2 cluster signature)
 *   G5  block entry_zone=premium          (don't long in premium)
 *   G6  allow mtf=aligned_HH only         (trend-confirmation gate)
 *   G7  allow entry_zone=discount only    (ICT discount-only rule)
 *   G8  block joint cluster (compressed ∩ discount ∩ london(7-13))
 *       (the V1.2 portfolio-level cluster — never bound on per-algo
 *       per PR #260, but include for completeness)
 *
 * Each gate runs UNGATED + GATED. Output: per-gate trades / R / DD.
 * Decision: prefer the variant with the largest DD-drop per R-given-up.
 *
 * Usage:
 *   pnpm dlx tsx scripts/regime-decomp-ote-long.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import type { MarketStateSeries } from "../src/lib/market-data/portfolio-backtest";
import type { BacktestTrade, PriceBar } from "../src/lib/market-data/types";
import type { AlgorithmRules } from "../src/types/algorithm";
import type { MarketStateGate, MarketStateGateConfig } from "../src/lib/algorithm/market-state-gate";
import { loadCorpus } from "./llm-trader-backtest";

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
    /* ignore */
  }
}

const TICKERS = (process.env.TICKERS ?? "XAU/USD,EUR/USD,GBP/USD,USD/JPY").split(",").map((s) => s.trim());
const CAPITAL = 100_000;
const RISK_PCT = 0.6;
const RISK_DOLLARS = (CAPITAL * RISK_PCT) / 100;
const CHUNK_DAYS = 90;
const DAY_MS = 86_400_000;
const FRICTION_SLIPPAGE_BPS = 0.5;
const FRICTION_SPREAD_BPS = 0.4;

interface GateCandidate {
  key: string;
  description: string;
  gate: MarketStateGateConfig | null;
}

const CANDIDATES: GateCandidate[] = [
  {
    key: "ungated",
    description: "Baseline: no gate (current OTE-Long config)",
    gate: null,
  },
  {
    key: "G1_block_fast_div_bull",
    description: "Block mtf=fast_div_bull (V1.2 negative for longs)",
    gate: { mode: "block", states: { mtf: ["fast_div_bull"] }, on_unreadable: "allow" },
  },
  {
    key: "G2_block_usd_down",
    description: "Block dxy=usd_down (V1.2 negative for longs)",
    gate: { mode: "block", states: { dxy: ["usd_down"] }, on_unreadable: "allow" },
  },
  {
    key: "G3_block_fast_div_bull_OR_usd_down",
    description: "Block mtf=fast_div_bull OR dxy=usd_down (same as Dip-Buyer's gate)",
    gate: {
      mode: "block",
      states: { mtf: ["fast_div_bull"], dxy: ["usd_down"] },
      on_unreadable: "allow",
    },
  },
  {
    key: "G4_block_compressed",
    description: "Block range=compressed (V1.2 cluster signature element)",
    gate: { mode: "block", states: { range: ["compressed"] }, on_unreadable: "allow" },
  },
  {
    key: "G5_block_premium",
    description: "Block entry_zone=premium (don't long in premium)",
    gate: { mode: "block", states: { entry_zone: ["premium"] }, on_unreadable: "allow" },
  },
  {
    key: "G6_allow_aligned_HH",
    description: "Allow only mtf=aligned_HH (trend-confirmation)",
    gate: { mode: "allow", states: { mtf: ["aligned_HH"] }, on_unreadable: "allow" },
  },
  {
    key: "G7_allow_discount",
    description: "Allow only entry_zone=discount (ICT discount-only rule)",
    gate: { mode: "allow", states: { entry_zone: ["discount"] }, on_unreadable: "allow" },
  },
  {
    key: "G8_block_v12_cluster",
    description: "Block V1.2 joint cluster (compressed ∩ discount ∩ london(7-13))",
    gate: {
      mode: "block_joint",
      states: {
        range: ["compressed"],
        entry_zone: ["discount"],
        entry_hour_bucket: ["london(7-13)"],
      },
      on_unreadable: "allow",
    },
  },
  // ---- Combos: layer two filters via composite gate ----
  {
    key: "G3+G7_block_dxy_mtf_AND_allow_discount",
    description: "G3 + G7 layered (block usd_down/fast_div_bull AND only enter in discount)",
    gate: {
      clauses: [
        { mode: "block", states: { mtf: ["fast_div_bull"], dxy: ["usd_down"] }, on_unreadable: "allow" },
        { mode: "allow", states: { entry_zone: ["discount"] }, on_unreadable: "allow" },
      ],
    },
  },
  {
    key: "G2+G7_block_usd_down_AND_allow_discount",
    description: "G2 + G7 layered (block usd_down AND only enter in discount)",
    gate: {
      clauses: [
        { mode: "block", states: { dxy: ["usd_down"] }, on_unreadable: "allow" },
        { mode: "allow", states: { entry_zone: ["discount"] }, on_unreadable: "allow" },
      ],
    },
  },
  {
    key: "G4+G7_block_compressed_AND_allow_discount",
    description: "G4 + G7 layered (block compressed AND only enter in discount)",
    gate: {
      clauses: [
        { mode: "block", states: { range: ["compressed"] }, on_unreadable: "allow" },
        { mode: "allow", states: { entry_zone: ["discount"] }, on_unreadable: "allow" },
      ],
    },
  },
];

function buildRules(ticker: string, gate: MarketStateGateConfig | null): AlgorithmRules {
  const assetClass = ticker === "XAU/USD" ? "commodity" : "forex";
  const rules: Record<string, unknown> = {
    entry_conditions: [
      { type: "pattern", pattern: "ote", direction: "bullish", lookback: 5, timeframe: "4h" },
    ],
    exit_conditions: [],
    stop_loss: { type: "swing_anchor", value: 0.1, lookback: 4 },
    take_profit: { type: "rr_multiple", value: 3 },
    position_sizing: { type: "risk_per_trade", value: RISK_PCT },
    max_positions: 1,
    leverage: 9,
    timeframe: "4h",
    asset_class: assetClass,
    side: "long",
    stagnant_exit: { enabled: true },
    prop_firm: { slippage_bps: FRICTION_SLIPPAGE_BPS, spread_bps: FRICTION_SPREAD_BPS },
  };
  if (gate) rules.market_state_gate = gate;
  return rules as unknown as AlgorithmRules;
}

interface T {
  r: number;
  pnl: number;
  entry_date: string;
}

function peakDD(ts: T[]): number {
  const sorted = [...ts].sort((a, b) => new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime());
  let eq = 0, peak = 0, dd = 0;
  for (const t of sorted) {
    eq += t.pnl;
    if (eq > peak) peak = eq;
    if (peak - eq > dd) dd = peak - eq;
  }
  return (dd / CAPITAL) * 100;
}

interface PerYearStat {
  year: string;
  n: number;
  total_dollars: number;
  win_pct: number;
  year_peak_dd_pct: number;
}

interface CandidateResult {
  ticker: string;
  key: string;
  description: string;
  n: number;
  mean_r: number;
  total_r: number;
  win_pct: number;
  total_dollars: number;
  dd_pct: number;
  per_year: PerYearStat[];
  /** Worst single-year peak-to-trough DD% across all years (rolling DD proxy). */
  worst_year_dd_pct: number;
}

async function runCandidate(ticker: string, c: GateCandidate, bars: PriceBar[], series: MarketStateSeries): Promise<CandidateResult> {
  const rules = buildRules(ticker, c.gate);
  const trades: BacktestTrade[] = [];
  const start = new Date(bars[0].date).getTime();
  const end = new Date(bars[bars.length - 1].date).getTime();
  for (let cur = start; cur < end; cur += CHUNK_DAYS * DAY_MS) {
    const ce = cur + CHUNK_DAYS * DAY_MS;
    const chunk = bars.filter((b) => {
      const t = new Date(b.date).getTime();
      return t >= cur && t < ce;
    });
    if (chunk.length < 30) continue;
    const m = runPortfolioBacktest(
      rules,
      new Map<string, PriceBar[]>([[ticker, chunk]]),
      CAPITAL,
      [],
      null,
      c.gate ? series : null
    );
    trades.push(...m.trades);
  }
  trades.sort((a, b) => new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime());
  const ts: T[] = trades.map((t) => ({ r: t.pnl / RISK_DOLLARS, pnl: t.pnl, entry_date: t.entry_date }));
  const n = ts.length;
  const total_r = ts.reduce((s, t) => s + t.r, 0);
  const mean_r = n > 0 ? total_r / n : 0;
  const wins = ts.filter((t) => t.r > 0).length;
  const win_pct = n > 0 ? (wins * 100) / n : 0;
  const total_dollars = ts.reduce((s, t) => s + t.pnl, 0);
  const dd_pct = peakDD(ts);
  // Per-year breakdown: peak-DD within each year (the FTMO-relevant rolling DD proxy)
  const byYear = new Map<string, T[]>();
  for (const t of ts) {
    const y = t.entry_date.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(t);
  }
  const per_year: PerYearStat[] = [];
  let worst_year_dd_pct = 0;
  for (const [year, yts] of Array.from(byYear.entries()).sort()) {
    const yn = yts.length;
    const yw = yts.filter((t) => t.r > 0).length;
    const ydollars = yts.reduce((s, t) => s + t.pnl, 0);
    const ydd = peakDD(yts);
    if (ydd > worst_year_dd_pct) worst_year_dd_pct = ydd;
    per_year.push({
      year,
      n: yn,
      total_dollars: Number(ydollars.toFixed(0)),
      win_pct: yn > 0 ? Number(((yw * 100) / yn).toFixed(1)) : 0,
      year_peak_dd_pct: Number(ydd.toFixed(2)),
    });
  }
  return {
    ticker,
    key: c.key,
    description: c.description,
    n,
    mean_r: Number(mean_r.toFixed(3)),
    total_r: Number(total_r.toFixed(1)),
    win_pct: Number(win_pct.toFixed(1)),
    total_dollars: Number(total_dollars.toFixed(0)),
    dd_pct: Number(dd_pct.toFixed(2)),
    per_year,
    worst_year_dd_pct: Number(worst_year_dd_pct.toFixed(2)),
  };
}

async function main() {
  console.log("OTE-Long 4h regime-decomp + DD-reduction gate search\n");
  const allResults: CandidateResult[] = [];

  for (const ticker of TICKERS) {
    console.log(`\n## ${ticker}`);
    const c4 = await loadCorpus("4h", ticker);
    console.log(`Loaded ${c4.bars.length} 4h bars (${c4.bars[0]?.date.slice(0, 10)} → ${c4.bars[c4.bars.length - 1]?.date.slice(0, 10)})`);
    const series: MarketStateSeries = {
      bars4h: new Map([[ticker, c4.bars]]),
      oneHour: new Map([[ticker, c4.bars]]),
      daily: new Map([[ticker, c4.dailyBars]]),
      eurusd4h: c4.eurusd4h,
    };

    for (const c of CANDIDATES) {
      process.stdout.write(`  Running ${c.key}... `);
      const r = await runCandidate(ticker, c, c4.bars, series);
      allResults.push(r);
      console.log(`n=${r.n} mean_R=${r.mean_r} DD=${r.dd_pct}% worst_year_DD=${r.worst_year_dd_pct}% $=${r.total_dollars}`);
    }
  }

  // Per-ticker summary tables.
  for (const ticker of TICKERS) {
    const results = allResults.filter((r) => r.ticker === ticker);
    console.log(`\n\n=== ${ticker} per-gate summary ===`);
    console.log("candidate                              n   mean_R  win%   total$    DD%   worstYrDD%   ship?");
    console.log("-".repeat(120));
    const baseline = results.find((r) => r.key === "ungated")!;
    for (const r of results) {
      const passDd = r.dd_pct <= 10 && r.worst_year_dd_pct <= 10;
      const passR = r.total_r > 0 && r.n >= 30;
      const ship = passDd && passR ? "✓" : passDd ? "DD-ok / R-fail" : r.worst_year_dd_pct > 10 ? "yrDD>10" : "DD>10";
      const ddDelta = (r.dd_pct - baseline.dd_pct).toFixed(2);
      const rPreserved = baseline.total_r !== 0 ? ((r.total_r / baseline.total_r) * 100).toFixed(0) : "n/a";
      console.log(
        `${r.key.padEnd(38)} ${String(r.n).padStart(4)}  ${r.mean_r.toFixed(3).padStart(7)}  ${r.win_pct.toFixed(1).padStart(5)} ${String(r.total_dollars).padStart(8)}  ${r.dd_pct.toFixed(2).padStart(5)}  ${r.worst_year_dd_pct.toFixed(2).padStart(7)}      ${ship.padEnd(15)} (ΔDD=${ddDelta}, R-kept=${rPreserved}%)`
      );
    }
  }

  // Per-year breakdown for the top XAU candidates only (most operator-relevant).
  console.log("\n\n=== XAU/USD per-year detail for top candidates (DD-passing, R-kept ≥75%) ===");
  const xau = allResults.filter((r) => r.ticker === "XAU/USD");
  const xauBaseline = xau.find((r) => r.key === "ungated")!;
  const topXau = xau.filter((r) => r.dd_pct <= 10 && r.worst_year_dd_pct <= 10 && r.n >= 30 && r.total_r > 0 && r.total_r >= 0.75 * xauBaseline.total_r);
  for (const r of topXau) {
    console.log(`\n--- ${r.key} (DD=${r.dd_pct}%, worst-yr-DD=${r.worst_year_dd_pct}%) ---`);
    console.log(`year  n     $       win%    yr-peak-DD%`);
    for (const y of r.per_year) {
      console.log(`${y.year}  ${String(y.n).padStart(3)}   ${String(y.total_dollars).padStart(6)}    ${y.win_pct.toFixed(1).padStart(5)}    ${y.year_peak_dd_pct.toFixed(2)}`);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/regime-decomp-ote-long-${stamp}.json`;
  writeFileSync(outPath, JSON.stringify({ results: allResults }, null, 2));
  console.log(`\nSaved: ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
