/**
 * Retune-based auto-loop meta-backtest (Level A.3, issue #220).
 *
 * Tests whether continuous parameter retuning improves forward results
 * vs static config. The retune action layer is what the operator
 * actually wants ("calibrate the perfect edge for the present time,
 * retune as it drifts") — the binary pause/resume from closed PRs #217
 * and #219 was the wrong action shape.
 *
 * Approach (per spec):
 *   1. For each algo, define a pre-registered variant GRID over SL, RR,
 *      lookback, etc. ~100+ variants per algo.
 *   2. Pre-compute each variant's chronological trade list (one
 *      chunked-WF per variant). EXPENSIVE — backtest cost ~ #variants ×
 *      corpus depth.
 *   3. Walk Sunday checkpoints through history:
 *      a. Compute the current 14d market-state distribution.
 *      b. detectDrift() vs algo's calibration baseline distribution.
 *      c. If drift fires (max bucket-shift ≥ 15pp), invoke
 *         selectVariant() over the last 30d of variant trades.
 *      d. Picked variant becomes the active config for the forward
 *         week.
 *   4. Construct the auto-loop equity curve by taking, at each entry
 *      timestamp, only the trades from whichever variant was active.
 *   5. A/B vs the static-variant-A (live-deploy) equity curve.
 *
 * Pre-registered (do NOT edit grid or selection in-place — see
 * variant-selector.ts + drift-detector.ts docstrings).
 *
 * The big risk we're testing for: this is continuous walk-forward
 * optimization on production data. The drift-trigger limits churn
 * (retune only on regime shifts, not weekly), and the selector
 * requires ≥3 trades in lookback so noise can't win on a single
 * fluke. If retune-aware equity STILL underperforms static, the
 * concept needs structural overhaul before any live wiring.
 *
 * Usage:
 *   pnpm dlx tsx scripts/auto-loop-retune-meta-backtest.ts
 *   ONLY=coil_breakout_4h
 *   FRICTION_SLIPPAGE_BPS=0.5 FRICTION_SPREAD_BPS=0.4
 */
import { writeFileSync } from "fs";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import type { MarketStateSeries } from "../src/lib/market-data/portfolio-backtest";
import type { BacktestTrade } from "../src/lib/market-data/types";
import type { AlgorithmRules } from "../src/types/algorithm";
import { loadCorpus, type Corpus } from "./llm-trader-backtest";
import {
  computeMarketState4h,
  type MarketState,
  type MarketStateInputs,
} from "../src/lib/market-data/market-state";
import {
  buildDistribution,
  detectDrift,
} from "../src/lib/learning-loop/drift-detector";
import {
  selectVariant,
  type VariantTrade,
} from "../src/lib/learning-loop/variant-selector";

const CAPITAL = 100_000;
const TICKER = "XAU/USD";
const FRICTION_SLIPPAGE_BPS = Number(process.env.FRICTION_SLIPPAGE_BPS ?? 0);
const FRICTION_SPREAD_BPS = Number(process.env.FRICTION_SPREAD_BPS ?? 0);
const DAY_MS = 86_400_000;
const CHUNK_DAYS = 90;
const RECENT_WINDOW_DAYS = 14;

interface AlgoSpec {
  key: string;
  timeframe: "4h" | "30m";
  side: "long" | "short";
  entryConditions: AlgorithmRules["entry_conditions"];
  marketStateGate: AlgorithmRules["market_state_gate"];
  /** Calibration window for the drift detector's baseline. */
  calibration: { start: string; end: string };
  /** Grid axes — variant set is the cartesian product. */
  grid: {
    slValues: number[];
    slLookbacks: number[];
    rrValues: number[];
    patternLookbacks: number[];
  };
  /** Live variant key (for tie-break + static baseline). */
  defaultVariantKey: string;
}

function buildSpecs(): AlgoSpec[] {
  // Grids deliberately small enough to compute in reasonable time but
  // large enough to be a real search space (4 × 3 × 4 × 3 = 144 each).
  const SL_VALUES = [0.05, 0.075, 0.1, 0.15];
  const SL_LOOKBACKS = [3, 4, 6];
  const RR_VALUES = [1.5, 2, 3, 4];
  const PATTERN_LOOKBACKS = [3, 5, 7];

  return [
    {
      key: "coil_breakout_4h",
      timeframe: "4h",
      side: "long",
      entryConditions: [], // populated per variant — uses patternLookback
      marketStateGate: { mode: "allow", states: { range: ["compressed"] } },
      calibration: { start: "2020-01-01", end: "2022-01-01" },
      grid: {
        slValues: SL_VALUES,
        slLookbacks: SL_LOOKBACKS,
        rrValues: RR_VALUES,
        patternLookbacks: PATTERN_LOOKBACKS,
      },
      defaultVariantKey: "sl0.1_lb4_rr3_pl5",
    },
    {
      key: "dip_buyer_4h",
      timeframe: "4h",
      side: "long",
      entryConditions: [],
      marketStateGate: {
        mode: "block",
        states: { mtf: ["fast_div_bull"], dxy: ["usd_down"] },
        on_unreadable: "allow",
      },
      calibration: { start: "2020-01-01", end: "2022-01-01" },
      grid: {
        slValues: SL_VALUES,
        slLookbacks: SL_LOOKBACKS,
        rrValues: RR_VALUES,
        patternLookbacks: PATTERN_LOOKBACKS,
      },
      defaultVariantKey: "sl0.1_lb4_rr3_pl5",
    },
    {
      key: "fvg_long_30m",
      timeframe: "30m",
      side: "long",
      entryConditions: [],
      marketStateGate: undefined,
      calibration: { start: "2025-12-15", end: "2026-03-15" },
      grid: {
        slValues: SL_VALUES,
        slLookbacks: SL_LOOKBACKS,
        rrValues: RR_VALUES,
        patternLookbacks: [0], // fvg pattern doesn't take a lookback
      },
      defaultVariantKey: "sl0.1_lb4_rr3_pl0",
    },
  ];
}

interface Variant {
  key: string;
  rules: AlgorithmRules;
}

function variantsFor(spec: AlgoSpec): Variant[] {
  const out: Variant[] = [];
  for (const sl of spec.grid.slValues)
    for (const slLb of spec.grid.slLookbacks)
      for (const rr of spec.grid.rrValues)
        for (const pl of spec.grid.patternLookbacks) {
          const key = `sl${sl}_lb${slLb}_rr${rr}_pl${pl}`;
          let conditions: AlgorithmRules["entry_conditions"];
          if (spec.key === "coil_breakout_4h") {
            conditions = [
              { type: "pattern", pattern: "bos", direction: "bullish", lookback: pl, timeframe: spec.timeframe },
              { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: spec.timeframe },
            ];
          } else if (spec.key === "dip_buyer_4h") {
            conditions = [
              { type: "pattern", pattern: "liquidity_sweep", direction: "bullish", lookback: pl, timeframe: spec.timeframe },
              { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: spec.timeframe },
            ];
          } else {
            // fvg_long_30m — lookback ignored on fvg pattern
            conditions = [
              { type: "pattern", pattern: "fvg", direction: "bullish", timeframe: spec.timeframe },
            ];
          }
          const rules: AlgorithmRules = {
            entry_conditions: conditions,
            exit_conditions: [],
            stop_loss: { type: "swing_anchor", value: sl, lookback: slLb },
            take_profit: { type: "rr_multiple", value: rr },
            position_sizing: { type: "risk_per_trade", value: 0.6 },
            max_positions: 1,
            leverage: 9,
            timeframe: spec.timeframe,
            asset_class: "commodity",
            side: spec.side,
            stagnant_exit: { enabled: true },
            ...(spec.marketStateGate
              ? { market_state_gate: spec.marketStateGate }
              : {}),
            ...(FRICTION_SLIPPAGE_BPS > 0 || FRICTION_SPREAD_BPS > 0
              ? {
                  prop_firm: {
                    slippage_bps: FRICTION_SLIPPAGE_BPS,
                    spread_bps: FRICTION_SPREAD_BPS,
                  },
                }
              : {}),
          } as AlgorithmRules;
          out.push({ key, rules });
        }
  return out;
}

function sundayBoundaries(from: Date, to: Date): Date[] {
  const out: Date[] = [];
  const d = new Date(from);
  d.setUTCHours(23, 0, 0, 0);
  while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
  while (d.getTime() <= to.getTime()) {
    out.push(new Date(d));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}

function statesInRange(
  inputs: MarketStateInputs,
  startMs: number,
  endMs: number
): MarketState[] {
  const out: MarketState[] = [];
  for (let i = 0; i < inputs.bars4h.length; i++) {
    const t = new Date(inputs.bars4h[i].date).getTime();
    if (t < startMs) continue;
    if (t >= endMs) break;
    out.push(computeMarketState4h(inputs, i));
  }
  return out;
}

function chunkedBacktest(
  rules: AlgorithmRules,
  corpus: Corpus,
  marketStateSeries: MarketStateSeries | null
): BacktestTrade[] {
  const bars = corpus.bars;
  if (bars.length === 0) return [];
  const trades: BacktestTrade[] = [];
  const startMs = new Date(bars[0].date).getTime();
  const endMs = new Date(bars[bars.length - 1].date).getTime();
  for (let cursor = startMs; cursor < endMs; cursor += CHUNK_DAYS * DAY_MS) {
    const chunkEnd = cursor + CHUNK_DAYS * DAY_MS;
    const chunk = bars.filter((b) => {
      const t = new Date(b.date).getTime();
      return t >= cursor && t < chunkEnd;
    });
    if (chunk.length < 30) continue;
    const m = runPortfolioBacktest(
      rules,
      new Map([[TICKER, chunk]]),
      CAPITAL,
      [],
      null,
      marketStateSeries
    );
    trades.push(...m.trades);
  }
  trades.sort((a, b) =>
    new Date(a.exit_date).getTime() - new Date(b.exit_date).getTime()
  );
  return trades;
}

interface EquityStats {
  totalReturn: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  trades: number;
  winRate: number;
}

function equityFromTrades(trades: BacktestTrade[], capital: number): EquityStats {
  let equity = capital;
  let peak = capital;
  let maxDd = 0;
  let wins = 0;
  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
    if (t.pnl > 0) wins++;
  }
  return {
    totalReturn: equity - capital,
    maxDrawdown: maxDd,
    maxDrawdownPct: (maxDd / capital) * 100,
    trades: trades.length,
    winRate: trades.length ? (wins / trades.length) * 100 : 0,
  };
}

async function runOneAlgo(
  spec: AlgoSpec,
  corpus: Corpus,
  corpus4h: Corpus,
  corpus1h: Corpus,
  marketStateSeries: MarketStateSeries | null
): Promise<Record<string, unknown>> {
  const variants = variantsFor(spec);
  console.log(`\n=== ${spec.key} (${variants.length} variants) ===`);
  const t0 = Date.now();

  // Backtest each variant. Each ~5-30s, so 100+ variants = several min.
  const tradesByVariant = new Map<string, BacktestTrade[]>();
  const RISK_DOLLARS = (CAPITAL * 0.6) / 100;
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    const trades = chunkedBacktest(v.rules, corpus, marketStateSeries);
    tradesByVariant.set(v.key, trades);
    if (i % 20 === 0 || i === variants.length - 1) {
      console.log(`  variant ${i + 1}/${variants.length} (${v.key}): ${trades.length} trades`);
    }
  }
  console.log(`  variant backtests done in ${Math.round((Date.now() - t0) / 1000)}s`);

  // Build the variant-tagged trade list for the selector.
  const allVariantTrades: VariantTrade[] = [];
  for (const [key, trades] of tradesByVariant) {
    for (const t of trades) {
      allVariantTrades.push({
        variantKey: key,
        exitDate: new Date(t.exit_date),
        r: t.pnl / RISK_DOLLARS,
      });
    }
  }

  // Compute drift baseline.
  const inputs: MarketStateInputs = {
    bars4h: corpus4h.bars,
    oneHourBars: corpus1h.bars,
    dailyBars: corpus.dailyBars,
    eurusd4h: corpus.eurusd4h,
  };
  const calStart = new Date(spec.calibration.start + "T00:00:00Z").getTime();
  const calEnd = new Date(spec.calibration.end + "T00:00:00Z").getTime();
  const baselineStates = statesInRange(inputs, calStart, calEnd);
  const baseline = buildDistribution(baselineStates);

  // Walk Sundays — drift-triggered retune.
  const allBars = corpus.bars;
  if (allBars.length === 0) {
    return {
      config: spec.key,
      static: equityFromTrades([], CAPITAL),
      auto_loop: equityFromTrades([], CAPITAL),
    };
  }
  const replayStart = new Date(Math.max(calEnd, new Date(allBars[0].date).getTime()));
  const replayEnd = new Date(allBars[allBars.length - 1].date);
  const sundays = sundayBoundaries(replayStart, replayEnd);

  let activeVariant = spec.defaultVariantKey;
  const retuneEvents: Array<{
    date: string;
    from: string;
    to: string;
    drift: string;
    reason: string;
  }> = [];
  // For each Sunday, store the active variant — drives entry filtering.
  const sundayActive: Array<{ date: Date; variant: string }> = [];

  for (const boundary of sundays) {
    const recentStart = boundary.getTime() - RECENT_WINDOW_DAYS * DAY_MS;
    const recentStates = statesInRange(inputs, recentStart, boundary.getTime());
    const recent = buildDistribution(recentStates);
    const driftV = detectDrift({ baseline, recent });
    if (driftV.flagged) {
      const sel = selectVariant(allVariantTrades, {
        asOf: boundary,
        current: activeVariant,
      });
      if (sel.picked !== activeVariant) {
        retuneEvents.push({
          date: boundary.toISOString(),
          from: activeVariant,
          to: sel.picked,
          drift: driftV.reason ?? "drift",
          reason: sel.reason,
        });
        activeVariant = sel.picked;
      }
    }
    sundayActive.push({ date: boundary, variant: activeVariant });
  }

  // Variant-active at a given entry timestamp.
  const variantAt = (when: Date): string => {
    let v = spec.defaultVariantKey;
    for (const s of sundayActive) {
      if (s.date.getTime() <= when.getTime()) v = s.variant;
      else break;
    }
    return v;
  };

  // Build auto-loop trade list: each trade was generated by SOME
  // variant. The auto-loop "would have taken" only trades from the
  // variant active at the trade's entry timestamp.
  const autoLoopTrades: BacktestTrade[] = [];
  for (const [key, trades] of tradesByVariant) {
    for (const t of trades) {
      if (variantAt(new Date(t.entry_date)) === key) {
        autoLoopTrades.push(t);
      }
    }
  }
  autoLoopTrades.sort((a, b) =>
    new Date(a.exit_date).getTime() - new Date(b.exit_date).getTime()
  );

  const staticTrades = tradesByVariant.get(spec.defaultVariantKey) ?? [];
  const stat = equityFromTrades(staticTrades, CAPITAL);
  const auto = equityFromTrades(autoLoopTrades, CAPITAL);

  const delta = auto.totalReturn - stat.totalReturn;
  const deltaPct = stat.totalReturn !== 0 ? (delta / Math.abs(stat.totalReturn)) * 100 : 0;
  console.log(
    `  static (${spec.defaultVariantKey}): total $${stat.totalReturn.toFixed(0)} DD ${stat.maxDrawdownPct.toFixed(2)}% trades ${stat.trades} WR ${stat.winRate.toFixed(0)}%`
  );
  console.log(
    `  retune-aware:                       total $${auto.totalReturn.toFixed(0)} DD ${auto.maxDrawdownPct.toFixed(2)}% trades ${auto.trades} WR ${auto.winRate.toFixed(0)}%`
  );
  console.log(
    `  Δ: $${delta.toFixed(0)} (${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%) · ${retuneEvents.length} retune events on ${sundays.length} sundays`
  );
  for (const e of retuneEvents.slice(0, 5)) {
    console.log(`    [retune ${e.date.slice(0, 10)}] ${e.from} → ${e.to}  trigger=${e.drift}`);
  }
  if (retuneEvents.length > 5) console.log(`    ... ${retuneEvents.length - 5} more`);

  return {
    config: spec.key,
    calibration: spec.calibration,
    variant_count: variants.length,
    static: stat,
    auto_loop: auto,
    retune_events: retuneEvents,
    sunday_count: sundays.length,
    variant_churn: new Set(sundayActive.map((s) => s.variant)).size,
  };
}

async function main(): Promise<void> {
  const only = process.env.ONLY?.split(",").map((s) => s.trim());
  const specs = buildSpecs().filter((s) => !only || only.includes(s.key));

  console.log(
    `Retune meta-backtest (#220) — capital $${CAPITAL.toLocaleString()}, friction ${FRICTION_SLIPPAGE_BPS}/${FRICTION_SPREAD_BPS} bps`
  );
  console.log(
    `Pre-registered: PAUSE 15pp drift trigger | RESUME implicit on next variant pick | weekly Sunday | 30d variant lookback, min 3 trades\n`
  );

  const corpora = new Map<string, Corpus>();
  for (const tf of ["4h", "30m"] as const) {
    if (!specs.some((s) => s.timeframe === tf)) continue;
    console.log(`Loading ${tf} corpus...`);
    corpora.set(tf, await loadCorpus(tf));
  }
  const corpus4h = corpora.get("4h") ?? (await loadCorpus("4h"));
  const corpus1h = await loadCorpus("1h");

  const reports: Array<Record<string, unknown>> = [];
  for (const spec of specs) {
    const corpus = corpora.get(spec.timeframe)!;
    const series: MarketStateSeries | null = spec.marketStateGate
      ? {
          bars4h: new Map([[TICKER, corpus4h.bars]]),
          oneHour: new Map([[TICKER, corpus1h.bars]]),
          daily: new Map([[TICKER, corpus.dailyBars]]),
          eurusd4h: corpus.eurusd4h,
        }
      : null;
    const r = await runOneAlgo(spec, corpus, corpus4h, corpus1h, series);
    reports.push(r);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/auto-loop-retune-meta-backtest-${stamp}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        capital: CAPITAL,
        friction: {
          slippage_bps: FRICTION_SLIPPAGE_BPS,
          spread_bps: FRICTION_SPREAD_BPS,
        },
        pre_registered: {
          grid: "spec.grid (cartesian product)",
          drift_threshold_pp: 15,
          recovery_threshold_pp: 8,
          recent_window_days: RECENT_WINDOW_DAYS,
          selector_lookback_days: 30,
          selector_min_trades: 3,
          cadence: "weekly Sunday 23:00 UTC, only retunes when drift fires",
        },
        reports,
      },
      null,
      2
    )
  );
  console.log(`\nSaved: ${outPath}`);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
