/**
 * Round driver for the 2026-10 Gold-Maximization + Forex round.
 * Contract: scripts/canonical/algo-search-2026-10.spec.md (IMMUTABLE).
 * Constants come from src/lib/algo-search/spec-2026-10.ts — never retyped.
 *
 * Modes:
 *   MODE=enumerate  (default) print N + strata + feasibility asserts. $0, seconds.
 *   MODE=smoke      one cell end-to-end on pinned data, results DISCARDED
 *                   (mechanism proof, not selection — no file written).
 *   MODE=layer-a    the real Layer A sweep. Requires PINS_REFRESHED=1 ack.
 *                   Checkpointed per stratum (instrument×TF) under
 *                   e2-results/2026-10/ — re-run resumes, never re-trims.
 *   MODE=layer-b    96-variant time-relative geometry sweep over Layer A
 *                   operator-bar passers (reads the layer-a checkpoints).
 *   MODE=compose    portfolio composition over Layer B passers with the
 *                   blended-WR gate armed (incumbent pool from g8-baseline).
 *
 * Verdict-grade rules: pinned data only (loadPinnedForInterval refuses
 * live cache), session-day D1 override, spec asserts abort on drift.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { enumerateLayerACandidates, type SearchCandidate } from "../../src/lib/algo-search/enumerate";
import { enumerateLayerBVariants, type LayerBVariant } from "../../src/lib/algo-search/layer-b-enumerate";
import {
  composePortfolio,
  DEFAULT_PORTFOLIO_COMPOSER_CONFIG,
  type CandidateInput,
} from "../../src/lib/algo-search/portfolio-composer";
import { assertSpecFeasible, bootstrapPFloor, SPEC_2026_10 } from "../../src/lib/algo-search/spec-2026-10";
import { runPortfolioBacktest } from "../../src/lib/market-data/portfolio-backtest";
import { bootstrapStatBlockWithSamples } from "../../src/lib/stats/bootstrap";
import type { BacktestTrade } from "../../src/lib/market-data/types";
import { loadPinnedForInterval, pinnedSessionDaily, soloStats } from "./lib/pinned-eval";

const MODE = process.env.MODE ?? "enumerate";
const RESULTS_DIR = resolve(process.cwd(), "scripts/canonical/e2-results/2026-10");
const INTERVAL_BY_TF: Record<string, string> = { "30m": "30min", "1h": "1h", "4h": "4h" };

interface CellResult {
  cell_key: string;
  name: string;
  stats: ReturnType<typeof soloStats>;
  passes_bar_v4: boolean;
  blockers: string[];
  bonferroni_p: number | null; // computed for passers only (spec §5)
  /** Per-trade data kept for passers only — feeds Layer B/compose. */
  per_trade_r?: number[];
  exit_dates?: string[];
  per_trade_pnl?: number[];
}

/** The v4 operator bar (spec §4): WR floor 35, NOT soloStats' legacy 37. */
function barV4(stats: ReturnType<typeof soloStats>): string[] {
  const blockers: string[] = [];
  if (stats.trades < 30) blockers.push(`n ${stats.trades} < 30`);
  if (stats.wr < SPEC_2026_10.WR_FLOOR_PCT) blockers.push(`WR ${stats.wr.toFixed(1)} < ${SPEC_2026_10.WR_FLOOR_PCT}`);
  if (stats.static_dd_pct > 10) blockers.push(`staticDD ${stats.static_dd_pct.toFixed(2)} > 10`);
  if (stats.daily_dd_pct > 5) blockers.push(`dailyDD ${stats.daily_dd_pct.toFixed(2)} > 5`);
  if (stats.total_pnl <= 0) blockers.push("pnl <= 0");
  return blockers;
}

function bonferroniP(trades: BacktestTrade[], riskDollars: number): number {
  const rs = trades.map((t) => t.pnl / riskDollars);
  const { samples } = bootstrapStatBlockWithSamples(
    rs,
    (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length),
    { n_iterations: SPEC_2026_10.BOOTSTRAP_ITERATIONS, seed: 42 }
  );
  const leq = samples.filter((s) => s <= 0).length;
  return (leq + 0.5) / (samples.length + 1); // add-half convention (matches the p-floor)
}

function runCell(cell: SearchCandidate): CellResult {
  const interval = INTERVAL_BY_TF[cell.timeframe];
  const pinned = loadPinnedForInterval(cell.ticker, interval);
  if (!pinned) throw new Error(`no pinned dataset for ${cell.ticker} ${interval} — refresh pins first`);
  const res = runPortfolioBacktest(cell.rules, new Map([[cell.ticker, pinned.bars]]), cell.capital, {
    dailyBarsOverride: pinnedSessionDaily(cell.ticker),
  });
  const trades = res.trades ?? [];
  const stats = soloStats(trades);
  const blockers = barV4(stats);
  const passes = blockers.length === 0;
  const riskDollars = cell.capital * (1.0 / 100); // Layer A default geometry risk 1.0%
  const out: CellResult = {
    cell_key: cell.cell_key,
    name: cell.name,
    stats,
    passes_bar_v4: passes,
    blockers,
    bonferroni_p: passes ? bonferroniP(trades, riskDollars) : null,
  };
  if (passes) {
    out.per_trade_r = trades.map((t) => t.pnl / riskDollars);
    out.exit_dates = trades.map((t) => t.exit_date);
    out.per_trade_pnl = trades.map((t) => t.pnl);
  }
  return out;
}

/** Cumulative test-count ledger for honest DSR families (spec §3): every
 *  rows[] entry across all prior e2-results grid/layer JSONs + this
 *  round's N. Conservative floor — prefer overcounting to undercounting. */
function familyLedger(): number {
  const dir = resolve(process.cwd(), "scripts/canonical/e2-results");
  let prior = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const d = JSON.parse(readFileSync(resolve(dir, f), "utf-8")) as { rows?: unknown[]; stage_a?: unknown[] };
      prior += d.rows?.length ?? 0;
      prior += d.stage_a?.length ?? 0;
    } catch {
      /* non-grid JSON — skip */
    }
  }
  return prior + SPEC_2026_10.N_EXPECTED;
}

function enumerateAll(): SearchCandidate[] {
  return enumerateLayerACandidates({ axes2026_10: true, forex: true });
}

function strataOf(cells: SearchCandidate[]): Map<string, SearchCandidate[]> {
  const m = new Map<string, SearchCandidate[]>();
  for (const c of cells) {
    const key = `${c.ticker.replace("/", "-").toLowerCase()}-${c.timeframe}`;
    m.set(key, [...(m.get(key) ?? []), c]);
  }
  return m;
}

async function main(): Promise<void> {
  const cells = enumerateAll();
  assertSpecFeasible(cells.length); // N==1,696 + p-floor<α/N or abort
  const strata = strataOf(cells);
  console.log(
    `2026-10 round: N=${cells.length} cells, ${strata.size} strata, α/N=${(SPEC_2026_10.FAMILY_ALPHA / cells.length).toExponential(3)}, ` +
      `p-floor=${bootstrapPFloor(SPEC_2026_10.BOOTSTRAP_ITERATIONS).toExponential(3)}, cumulative family=${familyLedger()}`
  );

  if (MODE === "enumerate") {
    for (const [k, v] of strata) console.log(`  ${k.padEnd(16)} ${v.length} cells`);
    console.log("Feasibility asserts PASSED. MODE=smoke for a mechanism test; MODE=layer-a to run (needs PINS_REFRESHED=1).");
    return;
  }

  if (MODE === "smoke") {
    const cell = cells.find((c) => c.ticker === "XAU/USD" && c.timeframe === "1h" && c.session === "london" && c.bias === "aligned")!;
    console.log(`Smoke cell: ${cell.name}`);
    const r = runCell(cell);
    console.log(`  n=${r.stats.trades} WR=${r.stats.wr.toFixed(1)} pnl=${r.stats.total_pnl.toFixed(0)} passes_v4=${r.passes_bar_v4} p=${r.bonferroni_p ?? "—"} blockers=[${r.blockers.join("; ")}]`);
    console.log("Results DISCARDED (mechanism proof only).");
    return;
  }

  if (MODE === "layer-a") {
    if (process.env.PINS_REFRESHED !== "1") {
      throw new Error("MODE=layer-a requires PINS_REFRESHED=1 — re-run fetch-pinned-history.ts for all 4 instruments first (spec §1).");
    }
    mkdirSync(RESULTS_DIR, { recursive: true });
    for (const [stratum, sCells] of strata) {
      const path = resolve(RESULTS_DIR, `layera-${stratum}.json`);
      if (existsSync(path)) {
        console.log(`  ${stratum}: checkpoint exists, skipping (${sCells.length} cells)`);
        continue;
      }
      console.log(`  ${stratum}: running ${sCells.length} cells…`);
      const rows = sCells.map((c) => runCell(c));
      const passers = rows.filter((r) => r.passes_bar_v4).length;
      writeFileSync(path, JSON.stringify({ spec: "algo-search-2026-10", stratum, rows }, null, 1));
      console.log(`  ${stratum}: DONE — ${passers}/${rows.length} pass bar v4`);
    }
    return;
  }

  if (MODE === "layer-b") {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const passers: CellResult[] = [];
    for (const f of readdirSync(RESULTS_DIR)) {
      if (!f.startsWith("layera-")) continue;
      const d = JSON.parse(readFileSync(resolve(RESULTS_DIR, f), "utf-8")) as { rows: CellResult[] };
      passers.push(...d.rows.filter((r) => r.passes_bar_v4));
    }
    console.log(`Layer B over ${passers.length} Layer-A passers (time-relative lookbacks)…`);
    const byKey = new Map(cells.map((c) => [c.cell_key, c]));
    for (const p of passers) {
      const base = byKey.get(p.cell_key)!;
      const path = resolve(RESULTS_DIR, `layerb-${p.cell_key.replace(/[|/]/g, "_")}.json`);
      if (existsSync(path)) continue;
      const variants: LayerBVariant[] = enumerateLayerBVariants(
        { name: base.name, ticker: base.ticker, capital: base.capital, rules: base.rules },
        { lookbackMode: "time-relative" }
      );
      const interval = INTERVAL_BY_TF[base.timeframe];
      const bars = loadPinnedForInterval(base.ticker, interval)!.bars;
      const rows = variants.map((v) => {
        const res = runPortfolioBacktest(v.rules, new Map([[v.ticker, bars]]), v.capital, {
          dailyBarsOverride: pinnedSessionDaily(v.ticker),
        });
        const trades = res.trades ?? [];
        const stats = soloStats(trades);
        const riskDollars = v.capital * (v.geometry.risk_per_trade_pct / 100);
        return {
          variant_tag: v.variant_tag,
          stats,
          passes_bar_v4: barV4(stats).length === 0,
          per_trade_r: trades.map((t) => t.pnl / riskDollars),
          exit_dates: trades.map((t) => t.exit_date),
          per_trade_pnl: trades.map((t) => t.pnl),
          wins: trades.filter((t) => t.pnl > 0).length,
          trades_n: trades.length,
        };
      });
      writeFileSync(path, JSON.stringify({ base: p.cell_key, rows }, null, 1));
      console.log(`  ${p.cell_key}: ${rows.filter((r) => r.passes_bar_v4).length}/96 pass`);
    }
    return;
  }

  if (MODE === "compose") {
    // Incumbent pool from the G.8 baseline artifact (pooled account WR).
    const g8 = JSON.parse(
      readFileSync(resolve(process.cwd(), "scripts/canonical/e2-results/g8-baseline.json"), "utf-8")
    ) as { portfolio: { n: number; wr_pct: number } };
    const baselinePool = {
      trades: g8.portfolio.n,
      wins: Math.round((g8.portfolio.wr_pct / 100) * g8.portfolio.n),
    };
    const candidates: CandidateInput[] = [];
    for (const f of readdirSync(RESULTS_DIR)) {
      if (!f.startsWith("layerb-")) continue;
      const d = JSON.parse(readFileSync(resolve(RESULTS_DIR, f), "utf-8")) as {
        base: string;
        rows: Array<{
          variant_tag: string; passes_bar_v4: boolean; per_trade_r: number[]; exit_dates: string[];
          per_trade_pnl: number[]; wins: number; trades_n: number; stats: { total_pnl: number; static_dd_pct: number };
        }>;
      };
      // Best passing variant per base — single representative (family
      // dedup; DSR family honesty lives in the acceptance packet stage).
      const best = d.rows.filter((r) => r.passes_bar_v4).sort((a, b) => b.stats.total_pnl - a.stats.total_pnl)[0];
      if (!best) continue;
      candidates.push({
        id: `${d.base} | ${best.variant_tag}`,
        total_return: best.stats.total_pnl,
        per_trade_r: best.per_trade_r,
        exit_dates: best.exit_dates,
        per_trade_pnl_dollars: best.per_trade_pnl,
        max_drawdown_pct: best.stats.static_dd_pct,
        wins: best.wins,
        trades: best.trades_n,
      });
    }
    const out = composePortfolio(candidates, {
      ...DEFAULT_PORTFOLIO_COMPOSER_CONFIG,
      min_blended_wr: SPEC_2026_10.BLENDED_WR_FLOOR_PCT,
      baseline_pool: baselinePool,
    });
    console.log(`Compose over ${candidates.length} candidates (baseline pool ${baselinePool.wins}/${baselinePool.trades}):`);
    console.log(JSON.stringify(out, null, 2));
    writeFileSync(resolve(RESULTS_DIR, "compose.json"), JSON.stringify(out, null, 1));
    return;
  }

  throw new Error(`unknown MODE "${MODE}"`);
}

main().catch((err) => {
  console.error("[algo-search-2026-10]", err instanceof Error ? err.message : err);
  process.exit(1);
});
