/**
 * Drift-based auto-loop meta-backtest (Level A, issue #218, 2026-06-16).
 *
 * Validates the pre-registered DRIFT-based pause rule on deterministic
 * library algo history. Drift = input-side market-state distribution
 * shift away from each algo's calibration window. NOT trade-outcome
 * decay — that was the closed PR #217's wrong framing.
 *
 * Approach:
 *   1. For each algo, define a calibration window (the period the algo
 *      was validated against).
 *   2. Compute the baseline state distribution: aggregate
 *      computeMarketState4h over every 4h bar in the calibration
 *      period.
 *   3. Build the algo's chronological trade list via chunked WF
 *      (workaround for runPortfolioBacktest's corpus-size bug).
 *   4. Walk Sunday-23:00-UTC boundaries through history. At each:
 *        - Build recent state distribution over the last 14 days of 4h
 *          bars (using the same computeMarketState4h primitive).
 *        - active → paused on drift (max bucket shift ≥ 15pp)
 *        - paused → active on recovery (max bucket shift < 8pp)
 *      Hysteresis prevents flapping at the boundary.
 *   5. Filter trades that would have ENTERED during a paused window
 *      out of the auto-loop equity curve.
 *   6. A/B output per algo: static vs drift-aware.
 *
 * Pre-registered (do NOT edit thresholds in-place — see drift-detector
 * docstring + feedback_drift_not_losses).
 *
 * Output: scripts/auto-loop-drift-meta-backtest-YYYY-MM-DD.json.
 *
 * Usage:
 *   pnpm dlx tsx scripts/auto-loop-drift-meta-backtest.ts
 *   ONLY=dip_buyer_4h,coil_breakout_4h    subset
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
  detectDriftRecovery,
  type DriftShift,
} from "../src/lib/learning-loop/drift-detector";

const CAPITAL = 100_000;
const TICKER = "XAU/USD";
const FRICTION_SLIPPAGE_BPS = Number(process.env.FRICTION_SLIPPAGE_BPS ?? 0);
const FRICTION_SPREAD_BPS = Number(process.env.FRICTION_SPREAD_BPS ?? 0);
const DAY_MS = 86_400_000;
const CHUNK_DAYS = 90; // WF-style chunk to dodge the runPortfolioBacktest bug
const RECENT_WINDOW_DAYS = 14;

interface ConfigEntry {
  key: string;
  timeframe: "4h" | "30m";
  rules: AlgorithmRules;
  /** Calibration window (inclusive start, exclusive end) — the period
   *  the algo was validated against. Drift is measured against this
   *  window's state distribution. */
  calibration: { start: string; end: string };
}

function baseRules(timeframe: ConfigEntry["timeframe"], side: "long" | "short" = "long"): AlgorithmRules {
  return {
    entry_conditions: [],
    exit_conditions: [],
    stop_loss: { type: "swing_anchor", value: 0.1, lookback: 4 },
    take_profit: { type: "rr_multiple", value: 3 },
    position_sizing: { type: "risk_per_trade", value: 0.6 },
    max_positions: 1,
    leverage: 9,
    timeframe,
    asset_class: "commodity",
    side,
    stagnant_exit: { enabled: true },
    ...(FRICTION_SLIPPAGE_BPS > 0 || FRICTION_SPREAD_BPS > 0
      ? {
          prop_firm: {
            slippage_bps: FRICTION_SLIPPAGE_BPS,
            spread_bps: FRICTION_SPREAD_BPS,
          },
        }
      : {}),
  } as AlgorithmRules;
}

/** Library configs (matching live deploys) with their calibration
 *  windows from PR #199 / PR #209 / PR #214. */
function buildConfigs(): ConfigEntry[] {
  const dipBuyer = baseRules("4h");
  dipBuyer.entry_conditions = [
    { type: "pattern", pattern: "liquidity_sweep", direction: "bullish", lookback: 5, timeframe: "4h" },
    { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "4h" },
  ];
  dipBuyer.market_state_gate = {
    mode: "block",
    states: { mtf: ["fast_div_bull"], dxy: ["usd_down"] },
    on_unreadable: "allow",
  };

  const coilBreakout = baseRules("4h");
  coilBreakout.entry_conditions = [
    { type: "pattern", pattern: "bos", direction: "bullish", lookback: 5, timeframe: "4h" },
    { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "4h" },
  ];
  coilBreakout.market_state_gate = { mode: "allow", states: { range: ["compressed"] } };

  const bearShort = baseRules("4h", "short");
  bearShort.entry_conditions = [
    { type: "pattern", pattern: "bos", direction: "bearish", lookback: 5, timeframe: "4h" },
    { type: "pattern", pattern: "daily_bias", direction: "bearish", ma_period: 20, timeframe: "4h" },
  ];
  bearShort.market_state_gate = { mode: "allow", states: { mtf: ["aligned_LH"] } };

  const fvgLong30m = baseRules("30m");
  fvgLong30m.entry_conditions = [
    { type: "pattern", pattern: "fvg", direction: "bullish", timeframe: "30m" },
  ];

  // Calibration windows. For the meta-backtest to actually exercise the
  // drift detector, calibration needs to PRECEDE most of the replay
  // window — otherwise there's no "out of sample" period to test on.
  // We use early-corpus calibrations so the replay covers 2022-2026
  // (the period where actual regime shifts occurred per
  // feedback_edge_is_regime_dependent).
  //
  // 4h: 2 years calibration (2020-2021), 4 years replay.
  // 30m: only ~6mo of data exists — split half/half (3mo cal, 3mo replay).
  return [
    {
      key: "dip_buyer_4h",
      timeframe: "4h",
      rules: dipBuyer,
      calibration: { start: "2020-01-01", end: "2022-01-01" },
    },
    {
      key: "coil_breakout_4h",
      timeframe: "4h",
      rules: coilBreakout,
      calibration: { start: "2020-01-01", end: "2022-01-01" },
    },
    {
      key: "bear_short_4h",
      timeframe: "4h",
      rules: bearShort,
      calibration: { start: "2020-01-01", end: "2022-01-01" },
    },
    {
      key: "fvg_long_30m",
      timeframe: "30m",
      rules: fvgLong30m,
      calibration: { start: "2025-12-15", end: "2026-03-15" },
    },
  ];
}

interface SundayCheckpoint {
  date: Date;
}

function sundayBoundaries(from: Date, to: Date): SundayCheckpoint[] {
  const out: SundayCheckpoint[] = [];
  const d = new Date(from);
  d.setUTCHours(23, 0, 0, 0);
  while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
  while (d.getTime() <= to.getTime()) {
    out.push({ date: new Date(d) });
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}

/** Compute MarketState at every 4h bar in [start, end). The market-state
 *  primitive needs 1h/daily/eurusd4h alongside the 4h bars, so we pass
 *  full corpora; the function naturally limits its history-lookback by
 *  the `idx` argument. */
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

interface PauseEvent {
  type: "pause" | "resume";
  date: Date;
  reason: string;
  maxShift: DriftShift | null;
}

interface ReplayResult {
  staticTrades: BacktestTrade[];
  autoLoopTrades: BacktestTrade[];
  events: PauseEvent[];
}

function replayWithDriftLoop(
  trades: BacktestTrade[],
  inputs: MarketStateInputs,
  calibration: { start: string; end: string }
): ReplayResult {
  if (trades.length === 0) {
    return { staticTrades: [], autoLoopTrades: [], events: [] };
  }
  // Build baseline distribution once.
  const calStart = new Date(calibration.start + "T00:00:00Z").getTime();
  const calEnd = new Date(calibration.end + "T00:00:00Z").getTime();
  const baselineStates = statesInRange(inputs, calStart, calEnd);
  const baseline = buildDistribution(baselineStates);

  const first = new Date(trades[0].entry_date);
  const last = new Date(trades[trades.length - 1].exit_date);
  // Replay starts at calEnd (don't act inside calibration window —
  // baseline already includes it). If trades start before calEnd, the
  // pre-calibration trades are treated as "active" by default.
  const replayStart = new Date(Math.max(first.getTime(), calEnd));
  const sundays = sundayBoundaries(replayStart, last);

  let state: "active" | "paused" = "active";
  const events: PauseEvent[] = [];
  const sundayStates: { date: Date; state: "active" | "paused" }[] = [];

  for (const boundary of sundays) {
    const recentStart = boundary.date.getTime() - RECENT_WINDOW_DAYS * DAY_MS;
    const recentStates = statesInRange(inputs, recentStart, boundary.date.getTime());
    const recent = buildDistribution(recentStates);

    if (state === "active") {
      const v = detectDrift({ baseline, recent });
      if (v.flagged) {
        state = "paused";
        events.push({
          type: "pause",
          date: boundary.date,
          reason: v.reason ?? "drift",
          maxShift: v.maxShift,
        });
      }
    } else {
      const v = detectDriftRecovery({ baseline, recent });
      if (v.recovered) {
        state = "active";
        events.push({
          type: "resume",
          date: boundary.date,
          reason: v.reason ?? "recovery",
          maxShift: v.maxShift,
        });
      }
    }
    sundayStates.push({ date: boundary.date, state });
  }

  const stateAt = (when: Date): "active" | "paused" => {
    let s: "active" | "paused" = "active";
    for (const ss of sundayStates) {
      if (ss.date.getTime() <= when.getTime()) s = ss.state;
      else break;
    }
    return s;
  };

  const autoLoopTrades = trades.filter(
    (t) => stateAt(new Date(t.entry_date)) === "active"
  );
  return { staticTrades: trades, autoLoopTrades, events };
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

/** False-positive pauses: pause→next-resume windows whose skipped
 *  trades summed positive (the algo would have made money during the
 *  paused window). */
function countFalsePositivePauses(
  trades: BacktestTrade[],
  events: PauseEvent[]
): number {
  let count = 0;
  for (let i = 0; i < events.length; i++) {
    if (events[i].type !== "pause") continue;
    const pauseStart = events[i].date.getTime();
    let resumeAt: number | null = null;
    for (let j = i + 1; j < events.length; j++) {
      if (events[j].type === "resume") {
        resumeAt = events[j].date.getTime();
        break;
      }
    }
    const skipped = trades.filter((t) => {
      const entry = new Date(t.entry_date).getTime();
      if (entry < pauseStart) return false;
      if (resumeAt != null && entry >= resumeAt) return false;
      return true;
    });
    if (skipped.length === 0) continue;
    if (skipped.reduce((s, t) => s + t.pnl, 0) > 0) count++;
  }
  return count;
}

async function main(): Promise<void> {
  const only = process.env.ONLY?.split(",").map((s) => s.trim());
  const configs = buildConfigs().filter((c) => !only || only.includes(c.key));

  console.log(
    `Drift meta-backtest (#218) — capital $${CAPITAL.toLocaleString()}, friction ${FRICTION_SLIPPAGE_BPS}/${FRICTION_SPREAD_BPS} bps`
  );
  console.log(
    `Pre-registered: PAUSE max-bucket-shift ≥ 15pp | RESUME < 8pp | 14d recent window vs calibration baseline | weekly Sun 23:00 UTC\n`
  );

  // Pre-load all corpora.
  const corpora = new Map<string, Corpus>();
  for (const tf of ["4h", "30m"] as const) {
    if (!configs.some((c) => c.timeframe === tf)) continue;
    console.log(`Loading ${tf} corpus...`);
    corpora.set(tf, await loadCorpus(tf));
  }
  const corpus4h = corpora.get("4h") ?? (await loadCorpus("4h"));
  const corpus1h = await loadCorpus("1h");

  const reports: Array<Record<string, unknown>> = [];

  for (const c of configs) {
    const corpus = corpora.get(c.timeframe)!;
    const prices = new Map([[TICKER, corpus.bars]]);

    // MarketStateInputs: state is ALWAYS computed on 4h primitives
    // regardless of the algo's primary TF — the state is the market
    // condition, not the algo's signal cadence.
    const inputs: MarketStateInputs = {
      bars4h: corpus4h.bars,
      oneHourBars: corpus1h.bars,
      dailyBars: corpus4h.dailyBars,
      eurusd4h: corpus4h.eurusd4h,
    };
    const marketStateSeries: MarketStateSeries | null = c.rules.market_state_gate
      ? {
          bars4h: new Map([[TICKER, corpus4h.bars]]),
          oneHour: new Map([[TICKER, corpus1h.bars]]),
          daily: new Map([[TICKER, corpus.dailyBars]]),
          eurusd4h: corpus.eurusd4h,
        }
      : null;

    // Chunked WF: runPortfolioBacktest has a bug on certain corpus
    // sizes — see closed PR #217 / open bug-fix issue.
    const allBars = corpus.bars;
    const trades: BacktestTrade[] = [];
    if (allBars.length > 0) {
      const startMs = new Date(allBars[0].date).getTime();
      const endMs = new Date(allBars[allBars.length - 1].date).getTime();
      for (let cursor = startMs; cursor < endMs; cursor += CHUNK_DAYS * DAY_MS) {
        const chunkEnd = cursor + CHUNK_DAYS * DAY_MS;
        const chunk = allBars.filter((b) => {
          const t = new Date(b.date).getTime();
          return t >= cursor && t < chunkEnd;
        });
        if (chunk.length < 30) continue;
        const chunkMetrics = runPortfolioBacktest(
          c.rules,
          new Map([[TICKER, chunk]]),
          CAPITAL,
          [],
          null,
          marketStateSeries
        );
        trades.push(...chunkMetrics.trades);
      }
    }
    trades.sort((a, b) =>
      new Date(a.exit_date).getTime() - new Date(b.exit_date).getTime()
    );

    const { staticTrades, autoLoopTrades, events } = replayWithDriftLoop(
      trades,
      inputs,
      c.calibration
    );

    const stat = equityFromTrades(staticTrades, CAPITAL);
    const auto = equityFromTrades(autoLoopTrades, CAPITAL);
    const pauses = events.filter((e) => e.type === "pause");
    const resumes = events.filter((e) => e.type === "resume");
    const fpPauses = countFalsePositivePauses(staticTrades, events);

    const delta = auto.totalReturn - stat.totalReturn;
    const deltaPct = stat.totalReturn !== 0 ? (delta / Math.abs(stat.totalReturn)) * 100 : 0;
    console.log(`\n=== ${c.key} (TF=${c.timeframe}, cal ${c.calibration.start}→${c.calibration.end}) ===`);
    console.log(
      `  static:    total $${stat.totalReturn.toFixed(0).padStart(7)}  worstDD ${stat.maxDrawdownPct.toFixed(2)}%  ${stat.trades} trades  ${stat.winRate.toFixed(0)}% WR`
    );
    console.log(
      `  auto-loop: total $${auto.totalReturn.toFixed(0).padStart(7)}  worstDD ${auto.maxDrawdownPct.toFixed(2)}%  ${auto.trades} trades  ${auto.winRate.toFixed(0)}% WR`
    );
    console.log(
      `  Δ:         $${delta.toFixed(0)} (${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%)  ${pauses.length} pauses · ${resumes.length} resumes · ${fpPauses} false-positive · ${stat.trades - auto.trades} trades skipped`
    );
    for (const e of events.slice(0, 5)) {
      console.log(
        `    [${e.type}] ${e.date.toISOString().slice(0, 10)} ${e.reason}`
      );
    }
    if (events.length > 5) console.log(`    ... ${events.length - 5} more events`);

    reports.push({
      config: c.key,
      timeframe: c.timeframe,
      calibration: c.calibration,
      static: stat,
      auto_loop: auto,
      events: events.map((e) => ({
        type: e.type,
        date: e.date.toISOString(),
        reason: e.reason,
      })),
      pause_count: pauses.length,
      resume_count: resumes.length,
      trades_skipped: stat.trades - auto.trades,
      false_positive_pauses: fpPauses,
    });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/auto-loop-drift-meta-backtest-${stamp}.json`;
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
          pause: "max bucket-proportion shift ≥ 15pp",
          resume: "max bucket-proportion shift < 8pp",
          baseline: "full calibration window",
          recent: "14d before each Sunday checkpoint",
          cadence: "weekly Sunday 23:00 UTC",
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
