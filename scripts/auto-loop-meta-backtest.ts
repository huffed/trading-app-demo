/**
 * Auto-loop meta-backtest — Level A (issue #216, 2026-06-15).
 *
 * Validates the pre-registered cohort-decay auto-pause rule against
 * deterministic library algo history WITHOUT requiring live evidence.
 *
 * Approach (per spec):
 *   1. For each algo config, runPortfolioBacktest on the FULL corpus
 *      → returns chronological trade list with entry_date / exit_date
 *      / pnl.
 *   2. Convert each trade's pnl → R-multiple (pnl / risk_dollars).
 *   3. Replay trades in chronological order, maintaining an
 *      `active ↔ paused` state machine.
 *   4. At each weekly boundary (Sunday 23:00 UTC) walk-clock the state:
 *        - If `active`: detectDecay() on closed-trades-so-far.
 *          Flagged → transition to `paused`.
 *        - If `paused`: detectRecovery() on closed-trades-so-far.
 *          Recovered → transition to `active`.
 *      The detectors use the SAME pre-registered thresholds the cohort
 *      report ships with (0.5R drop OR 20pp WR drop, n≥5 halves, 14d
 *      windows for pause; 14d ≥0.0R n≥3 for resume).
 *   5. Filter trades that would have ENTERED during a `paused` window
 *      out of the auto-loop equity curve. Trades whose entry timestamp
 *      precedes the pause but close during it are kept (we don't yank
 *      open positions, we just stop opening new ones).
 *   6. A/B output per algo: static (auto-loop OFF) vs auto-loop ON
 *      total return, worst DD, trade count, pause/resume event count.
 *
 * Pre-registered (do NOT edit thresholds in-place — see decay-detector
 * docstring + feedback_audit_proposals_rigorously_before_presenting).
 *
 * Output: scripts/auto-loop-meta-backtest-YYYY-MM-DD.json.
 *
 * Usage:
 *   pnpm dlx tsx scripts/auto-loop-meta-backtest.ts
 *   ONLY=dip_buyer,coil_breakout        subset of configs (matches keys below)
 *   FRICTION_SLIPPAGE_BPS=0.5 FRICTION_SPREAD_BPS=0.4   realistic friction
 */
import { writeFileSync } from "fs";
import { runPortfolioBacktest } from "../src/lib/market-data/portfolio-backtest";
import type { MarketStateSeries } from "../src/lib/market-data/portfolio-backtest";
import type { BacktestTrade, PriceBar } from "../src/lib/market-data/types";
import type { AlgorithmRules } from "../src/types/algorithm";
import { loadCorpus, type Corpus } from "./llm-trader-backtest";
import {
  detectDecay,
  detectRecovery,
  type DecayTrade,
  type DecayVerdict,
  type RecoveryVerdict,
} from "../src/lib/learning-loop/decay-detector";

const CAPITAL = 100_000;
const TICKER = "XAU/USD";
const FRICTION_SLIPPAGE_BPS = Number(process.env.FRICTION_SLIPPAGE_BPS ?? 0);
const FRICTION_SPREAD_BPS = Number(process.env.FRICTION_SPREAD_BPS ?? 0);

interface ConfigEntry {
  key: string;
  timeframe: "4h" | "1h" | "30m";
  rules: AlgorithmRules;
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

/** The 5 canonical 4h library candidates (gated, matching live) plus the
 *  new fvg_long_no_bias 30m candidate deployed paper-only 2026-06-15. */
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

  const breakdownRider = baseRules("4h", "short");
  breakdownRider.entry_conditions = [
    { type: "pattern", pattern: "bos", direction: "bearish", lookback: 5, timeframe: "4h" },
  ];
  breakdownRider.market_state_gate = { mode: "allow", states: { mtf: ["fast_div_bear"] } };

  const coilBreakout = baseRules("4h");
  coilBreakout.entry_conditions = [
    { type: "pattern", pattern: "bos", direction: "bullish", lookback: 5, timeframe: "4h" },
    { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "4h" },
  ];
  coilBreakout.market_state_gate = { mode: "allow", states: { range: ["compressed"] } };

  const rangeFade = baseRules("4h");
  rangeFade.entry_conditions = [
    { type: "pattern", pattern: "liquidity_sweep", direction: "bullish", lookback: 5, timeframe: "4h" },
  ];
  rangeFade.market_state_gate = { mode: "allow", states: { mtf: ["ranging_all"] } };

  const bearShort = baseRules("4h", "short");
  bearShort.entry_conditions = [
    { type: "pattern", pattern: "bos", direction: "bearish", lookback: 5, timeframe: "4h" },
    { type: "pattern", pattern: "daily_bias", direction: "bearish", ma_period: 20, timeframe: "4h" },
  ];
  bearShort.market_state_gate = { mode: "allow", states: { mtf: ["aligned_LH"] } };

  // The 30m fvg_long_no_bias config that was deployed paper-only on 2026-06-15.
  const fvgLong30m = baseRules("30m");
  fvgLong30m.entry_conditions = [
    { type: "pattern", pattern: "fvg", direction: "bullish", timeframe: "30m" },
  ];

  return [
    { key: "dip_buyer_4h", timeframe: "4h", rules: dipBuyer },
    { key: "breakdown_rider_4h", timeframe: "4h", rules: breakdownRider },
    { key: "coil_breakout_4h", timeframe: "4h", rules: coilBreakout },
    { key: "range_fade_4h", timeframe: "4h", rules: rangeFade },
    { key: "bear_short_4h", timeframe: "4h", rules: bearShort },
    { key: "fvg_long_30m", timeframe: "30m", rules: fvgLong30m },
  ];
}

/** A trade-as-pnl converted to a trade-as-R via the configured risk. */
function tradeToR(trade: BacktestTrade, rules: AlgorithmRules): number {
  const riskPct =
    rules.position_sizing?.type === "risk_per_trade"
      ? Number(rules.position_sizing.value)
      : 0.6;
  const riskDollars = (CAPITAL * riskPct) / 100;
  if (riskDollars <= 0) return 0;
  return trade.pnl / riskDollars;
}

interface SundayBoundary {
  date: Date;
}

/** All Sunday 23:00 UTC boundaries between `from` and `to`, inclusive
 *  of the first Sunday on/after `from` and last on/before `to`. */
function sundayBoundaries(from: Date, to: Date): SundayBoundary[] {
  const out: SundayBoundary[] = [];
  // Start at next Sunday 23:00 UTC at or after `from`.
  const d = new Date(from);
  d.setUTCHours(23, 0, 0, 0);
  // getUTCDay: Sun=0
  while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
  while (d.getTime() <= to.getTime()) {
    out.push({ date: new Date(d) });
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}

interface PauseEvent {
  type: "pause" | "resume";
  date: Date;
  reason: string;
}

interface ReplayResult {
  staticTrades: BacktestTrade[];
  autoLoopTrades: BacktestTrade[];
  events: PauseEvent[];
}

/** Walk through the trade list with weekly boundaries, applying decay /
 *  recovery checks and filtering out entries that occur during a paused
 *  window. */
function replayWithAutoLoop(
  trades: BacktestTrade[],
  rules: AlgorithmRules
): ReplayResult {
  if (trades.length === 0) {
    return { staticTrades: [], autoLoopTrades: [], events: [] };
  }
  // Build the timeline.
  const tradeR: DecayTrade[] = trades.map((t) => ({
    date: new Date(t.exit_date),
    r: tradeToR(t, rules),
  }));
  const first = new Date(trades[0].entry_date);
  const last = new Date(trades[trades.length - 1].exit_date);
  const sundays = sundayBoundaries(first, last);

  // Walk events: each Sunday is a checkpoint at which state may transition.
  let state: "active" | "paused" = "active";
  const events: PauseEvent[] = [];
  const sundayStates: { date: Date; state: "active" | "paused" }[] = [];

  let nextEventIdx = 0;
  // The detectors take CLOSED-trades-so-far. We feed them the trades
  // whose exit_date is < the Sunday boundary.
  for (const boundary of sundays) {
    const closedSoFar = tradeR.filter(
      (t) => t.date.getTime() < boundary.date.getTime()
    );
    if (state === "active") {
      const v: DecayVerdict = detectDecay(closedSoFar, { asOf: boundary.date });
      if (v.flagged) {
        state = "paused";
        events.push({ type: "pause", date: boundary.date, reason: v.reason ?? "decay" });
      }
    } else {
      const v: RecoveryVerdict = detectRecovery(closedSoFar, { asOf: boundary.date });
      if (v.recovered) {
        state = "active";
        events.push({ type: "resume", date: boundary.date, reason: v.reason ?? "recovery" });
      }
    }
    sundayStates.push({ date: boundary.date, state });
    nextEventIdx++;
  }

  // For each trade, determine the state at its ENTRY date and filter
  // out entries that occurred while paused.
  const stateAt = (when: Date): "active" | "paused" => {
    // Find the most recent Sunday boundary <= when. If none, "active"
    // (algos start active at the beginning of replay).
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
  maxDrawdown: number; // dollars
  maxDrawdownPct: number; // percent of capital
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

interface PerAlgoReport {
  config: string;
  static: EquityStats;
  auto_loop: EquityStats;
  events: { type: string; date: string; reason: string }[];
  pause_count: number;
  resume_count: number;
  trades_skipped_by_pause: number;
  false_positive_pauses: number;
}

/** Count pauses that, in hindsight, blocked trades that would have been
 *  profitable in aggregate (sum of skipped pnl > 0). Per pause event,
 *  look at trades between this pause and the next resume (or end) and
 *  see if their total pnl was positive. */
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
    const sum = skipped.reduce((s, t) => s + t.pnl, 0);
    if (sum > 0) count++;
  }
  return count;
}

async function main(): Promise<void> {
  const only = process.env.ONLY?.split(",").map((s) => s.trim());
  const configs = buildConfigs().filter((c) => !only || only.includes(c.key));

  console.log(
    `Auto-loop meta-backtest (issue #216) — capital $${CAPITAL.toLocaleString()}, friction ${FRICTION_SLIPPAGE_BPS}/${FRICTION_SPREAD_BPS} bps`
  );
  console.log(
    `Pre-registered: PAUSE 0.5R/20pp 14d n≥5 | RESUME 0.0R 14d n≥3 | weekly Sunday 23:00 UTC review\n`
  );

  // Pre-load all corpora once (the configs share 4h + 30m).
  const corpora = new Map<string, Corpus>();
  for (const tf of ["4h", "30m"] as const) {
    const has = configs.some((c) => c.timeframe === tf);
    if (!has) continue;
    console.log(`Loading ${tf} corpus...`);
    corpora.set(tf, await loadCorpus(tf));
  }
  // 1h needed for marketStateSeries
  const corpus1h = await loadCorpus("1h");
  const corpus4h = corpora.get("4h") ?? (await loadCorpus("4h"));

  const reports: PerAlgoReport[] = [];

  for (const c of configs) {
    const corpus = corpora.get(c.timeframe)!;
    const prices = new Map([[TICKER, corpus.bars]]);
    const marketStateSeries: MarketStateSeries = {
      bars4h: new Map([[TICKER, corpus4h.bars]]),
      oneHour: new Map([[TICKER, corpus1h.bars]]),
      daily: new Map([[TICKER, corpus.dailyBars]]),
      eurusd4h: corpus.eurusd4h,
    };
    // WORKAROUND for runPortfolioBacktest bug: on certain corpus
    // sizes (e.g. 18 months) the engine returns 0 trades, but the
    // same data sliced into smaller chunks produces trades correctly.
    // Walk-forward sidesteps this by chunking; we replicate that by
    // calling per 90-day non-overlapping window and concatenating
    // trades. Issue worth its own bug-fix PR — out of Level A scope.
    const CHUNK_DAYS = 90;
    const DAY_MS = 86_400_000;
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
        const chunkPrices = new Map([[TICKER, chunk]]);
        const chunkMetrics = runPortfolioBacktest(
          c.rules,
          chunkPrices,
          CAPITAL,
          [],
          null,
          c.rules.market_state_gate ? marketStateSeries : null
        );
        trades.push(...chunkMetrics.trades);
      }
    }
    trades.sort((a, b) =>
      new Date(a.exit_date).getTime() - new Date(b.exit_date).getTime()
    );

    const { staticTrades, autoLoopTrades, events } = replayWithAutoLoop(
      trades,
      c.rules
    );

    const stat = equityFromTrades(staticTrades, CAPITAL);
    const auto = equityFromTrades(autoLoopTrades, CAPITAL);
    const pauseEvents = events.filter((e) => e.type === "pause");
    const resumeEvents = events.filter((e) => e.type === "resume");
    const fpPauses = countFalsePositivePauses(staticTrades, events);

    const report: PerAlgoReport = {
      config: c.key,
      static: stat,
      auto_loop: auto,
      events: events.map((e) => ({
        type: e.type,
        date: e.date.toISOString(),
        reason: e.reason,
      })),
      pause_count: pauseEvents.length,
      resume_count: resumeEvents.length,
      trades_skipped_by_pause: stat.trades - auto.trades,
      false_positive_pauses: fpPauses,
    };
    reports.push(report);

    const delta = auto.totalReturn - stat.totalReturn;
    const deltaPct = stat.totalReturn !== 0 ? (delta / Math.abs(stat.totalReturn)) * 100 : 0;
    console.log(`\n=== ${c.key} (TF=${c.timeframe}) ===`);
    console.log(
      `  static:    total $${stat.totalReturn.toFixed(0).padStart(7)}  worstDD ${stat.maxDrawdownPct.toFixed(2)}%  ${stat.trades} trades  ${stat.winRate.toFixed(0)}% WR`
    );
    console.log(
      `  auto-loop: total $${auto.totalReturn.toFixed(0).padStart(7)}  worstDD ${auto.maxDrawdownPct.toFixed(2)}%  ${auto.trades} trades  ${auto.winRate.toFixed(0)}% WR`
    );
    console.log(
      `  Δ:         $${delta.toFixed(0)} (${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%)  ${pauseEvents.length} pauses · ${resumeEvents.length} resumes · ${fpPauses} false-positive pauses · ${stat.trades - auto.trades} trades skipped`
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `scripts/auto-loop-meta-backtest-${stamp}.json`;
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
          pause: "meanR drop ≥ 0.5R OR WR drop ≥ 20pp; n ≥ 5 both halves; 14d windows",
          resume: "meanR ≥ 0.0R; n ≥ 3; 14d window",
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
