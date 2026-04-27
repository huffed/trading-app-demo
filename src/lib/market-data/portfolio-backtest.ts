/**
 * Portfolio backtest — runs the algorithm across multiple watchlist tickers
 * simultaneously with a single shared capital pool. Per-ticker indicator
 * caches and positions, shared SimState (equity, dailyPnl, kill switch).
 *
 * max_positions caps the TOTAL number of open positions across all tickers;
 * max_per_ticker still caps pyramiding on each individual symbol.
 */
import {
  isPatternCondition,
  isTechnicalCondition,
  type AlgorithmRules,
  type PatternCondition,
  type TechnicalCondition,
} from "@/types/algorithm";
import { checkConditions, normalize } from "./backtest-engine";
import { calculateMetrics } from "./backtest-metrics";
import { buildVetoCheck, type EconomicEvent } from "./economic-calendar";
import { type Cache } from "./indicator-registry";
import {
  applySlippage,
  buildPropFirmReport,
  closeSimPosition,
  enforcePropFirm,
  finalizeDay,
  initialSimState,
  pickBacktestExitPrice,
  sizeForBacktest,
  type SimConfig,
  type SimState,
} from "./prop-firm-backtest";
import type {
  BacktestMetrics,
  BacktestTrade,
  PerTickerSummary,
  PriceBar,
} from "./types";

interface PortfolioPosition {
  entryPrice: number;
  entryDate: string;
  notionalValue: number;
  marginRequired: number;
  ticker: string;
}

interface TickerState {
  bars: PriceBar[];
  closes: number[];
  cache: Cache;
  positions: PortfolioPosition[];
  vetoCheck: ((barDate: string) => boolean) | null;
  /** Index of the most recently processed bar (for fast lookup as the
   *  unified timeline advances). */
  cursor: number;
}

const DEFAULT_MAX_POSITIONS = 1;
const DEFAULT_POSITION_SIZE_PCT = 10;
const DEFAULT_STOP_LOSS_PCT = 5;
const DEFAULT_TAKE_PROFIT_PCT = 15;

function buildSimConfig(rules: AlgorithmRules): SimConfig {
  const pf = rules.prop_firm;
  return {
    slippageBps: pf?.slippage_bps ?? 0,
    spreadBps: pf?.spread_bps ?? 0,
    commissionPct: pf?.commission_pct ?? 0,
    maxPos: rules.max_positions ?? DEFAULT_MAX_POSITIONS,
    posSize: (rules.position_sizing?.value ?? DEFAULT_POSITION_SIZE_PCT) / 100,
    stopPct: (rules.stop_loss?.value ?? DEFAULT_STOP_LOSS_PCT) / 100,
    tpPct: (rules.take_profit?.value ?? DEFAULT_TAKE_PROFIT_PCT) / 100,
  };
}

function buildTimeline(pricesByTicker: Map<string, PriceBar[]>): string[] {
  const set = new Set<string>();
  for (const prices of pricesByTicker.values()) {
    for (const p of prices) set.add(p.date);
  }
  return Array.from(set).sort();
}

function initTickerStates(
  rules: AlgorithmRules,
  pricesByTicker: Map<string, PriceBar[]>,
  events: EconomicEvent[]
): Map<string, TickerState> {
  const out = new Map<string, TickerState>();
  for (const [ticker, prices] of pricesByTicker) {
    out.set(ticker, {
      bars: prices,
      closes: prices.map((p) => p.close),
      cache: new Map(),
      positions: [],
      vetoCheck: rules.news_veto?.enabled
        ? buildVetoCheck({ symbol: ticker, events, veto: rules.news_veto })
        : null,
      cursor: -1,
    });
  }
  return out;
}

/**
 * Advance the ticker's cursor to the bar matching `timestamp`. Returns the
 * bar index (or -1 if this ticker has no bar at that timestamp).
 */
function advanceCursor(state: TickerState, timestamp: string): number {
  while (state.cursor + 1 < state.bars.length && state.bars[state.cursor + 1].date <= timestamp) {
    state.cursor++;
  }
  if (state.cursor < 0) return -1;
  return state.bars[state.cursor].date === timestamp ? state.cursor : -1;
}

interface CloseLoopResult {
  dailyHalted: boolean;
}

function runCloseLoop(
  state: TickerState,
  i: number,
  ticker: string,
  rules: AlgorithmRules,
  techExit: Array<TechnicalCondition | PatternCondition>,
  cfg: SimConfig,
  capital: number,
  s: SimState,
  trades: BacktestTrade[],
  dayKey: string,
  dailyHaltedIn: boolean
): CloseLoopResult {
  let dailyHalted = dailyHaltedIn;
  const pf = rules.prop_firm;
  const signalExitFired =
    (techExit.length > 0 &&
      checkConditions(
        techExit,
        { cache: state.cache, closes: state.closes, bars: state.bars, i },
        rules.entry_logic
      )) ||
    s.drawdownBreached;
  const bar = state.bars[i];
  for (let p = state.positions.length - 1; p >= 0; p--) {
    const pos = state.positions[p];
    const exitPrice = pickBacktestExitPrice(pos, bar, state.closes[i], cfg, signalExitFired);
    if (exitPrice !== null) {
      closeSimPosition(pos, dayKey, exitPrice, capital, cfg, s, trades);
      // Tag the just-recorded trade with its ticker for portfolio breakdown.
      const t = trades[trades.length - 1];
      if (t) t.ticker = ticker;
      state.positions.splice(p, 1);
      if (pf) dailyHalted = enforcePropFirm(pf, s, capital, dayKey, dailyHalted);
    }
  }
  return { dailyHalted };
}

function forceCloseTicker(
  state: TickerState,
  ticker: string,
  closePrice: number,
  dayKey: string,
  cfg: SimConfig,
  capital: number,
  s: SimState,
  trades: BacktestTrade[]
): void {
  if (state.positions.length === 0) return;
  const exitPrice = applySlippage(closePrice, cfg.slippageBps, false);
  for (let p = state.positions.length - 1; p >= 0; p--) {
    closeSimPosition(state.positions[p], dayKey, exitPrice, capital, cfg, s, trades);
    const t = trades[trades.length - 1];
    if (t) t.ticker = ticker;
    state.positions.splice(p, 1);
  }
}

function totalOpen(states: Map<string, TickerState>): number {
  let n = 0;
  for (const st of states.values()) n += st.positions.length;
  return n;
}

interface EntryGate {
  killTriggered: boolean;
  drawdownBreached: boolean;
  dailyHalted: boolean;
  vetoed: boolean;
  totalOpenCount: number;
  onTickerCount: number;
}

function canEnter(rules: AlgorithmRules, cfg: SimConfig, gate: EntryGate): boolean {
  if (gate.killTriggered || gate.drawdownBreached || gate.dailyHalted || gate.vetoed) return false;
  if (gate.totalOpenCount >= cfg.maxPos) return false;
  const perTickerCap = rules.max_per_ticker ?? 1;
  return gate.onTickerCount < perTickerCap;
}

function tryOpenEntry(
  state: TickerState,
  i: number,
  ticker: string,
  rules: AlgorithmRules,
  techEntry: Array<TechnicalCondition | PatternCondition>,
  cfg: SimConfig,
  s: SimState,
  states: Map<string, TickerState>,
  dailyHalted: boolean
): void {
  const vetoed = state.vetoCheck ? state.vetoCheck(state.bars[i].date) : false;
  const gate: EntryGate = {
    killTriggered: s.killTriggered,
    drawdownBreached: s.drawdownBreached,
    dailyHalted,
    vetoed,
    totalOpenCount: totalOpen(states),
    onTickerCount: state.positions.length,
  };
  if (!canEnter(rules, cfg, gate)) return;
  if (
    !checkConditions(
      techEntry,
      { cache: state.cache, closes: state.closes, bars: state.bars, i },
      rules.entry_logic
    )
  ) {
    return;
  }
  const entryPrice = applySlippage(state.closes[i], cfg.slippageBps, true);
  const sized = sizeForBacktest(rules, s.equity, entryPrice, ticker, cfg);
  const freeMargin = s.equity - s.marginUsed;
  if (sized.margin > freeMargin || sized.notional <= 0) return;
  s.marginUsed += sized.margin;
  state.positions.push({
    entryPrice,
    entryDate: state.bars[i].date,
    notionalValue: sized.notional,
    marginRequired: sized.margin,
    ticker,
  });
}

function buildPerTickerSummary(
  states: Map<string, TickerState>,
  trades: BacktestTrade[],
  capital: number
): PerTickerSummary[] {
  const summaries: PerTickerSummary[] = [];
  for (const ticker of states.keys()) {
    const tickerTrades = trades.filter((t) => t.ticker === ticker);
    const wins = tickerTrades.filter((t) => t.pnl > 0).length;
    const pnl = tickerTrades.reduce((sum, t) => sum + t.pnl, 0);
    summaries.push({
      ticker,
      trades: tickerTrades.length,
      return_pct: capital > 0 ? Number(((pnl / capital) * 100).toFixed(2)) : 0,
      win_rate:
        tickerTrades.length > 0 ? Number(((wins / tickerTrades.length) * 100).toFixed(1)) : 0,
    });
  }
  return summaries.sort((a, b) => b.return_pct - a.return_pct);
}

export function runPortfolioBacktest(
  rules: AlgorithmRules,
  pricesByTicker: Map<string, PriceBar[]>,
  capital: number,
  events: EconomicEvent[] = []
): BacktestMetrics {
  const entry = normalize(rules.entry_conditions);
  const exit = normalize(rules.exit_conditions);
  const techEntry = entry.filter(
    (c) => isTechnicalCondition(c) || isPatternCondition(c)
  ) as Array<TechnicalCondition | PatternCondition>;
  const techExit = exit.filter(
    (c) => isTechnicalCondition(c) || isPatternCondition(c)
  ) as Array<TechnicalCondition | PatternCondition>;
  const sentimentExcluded = entry.length - techEntry.length + (exit.length - techExit.length);
  const mode = sentimentExcluded > 0 ? ("technical_only" as const) : ("full" as const);

  // Use the first ticker's prices for the equity-curve metric helpers.
  const firstTickerPrices = Array.from(pricesByTicker.values())[0] ?? [];

  if (techEntry.length === 0 || pricesByTicker.size === 0) {
    return {
      ...calculateMetrics([], capital, firstTickerPrices, null),
      sentiment_conditions_excluded: sentimentExcluded,
      backtest_mode: mode,
      per_ticker: [],
    };
  }

  const cfg = buildSimConfig(rules);
  const states = initTickerStates(rules, pricesByTicker, events);
  const timeline = buildTimeline(pricesByTicker);
  const s = initialSimState(capital);
  const trades: BacktestTrade[] = [];
  let currentDayKey = "";
  let dailyHalted = false;

  for (const timestamp of timeline) {
    const dayKey = timestamp.split(/[ T]/)[0];
    if (dayKey !== currentDayKey) {
      if (currentDayKey !== "") finalizeDay(s, currentDayKey);
      currentDayKey = dayKey;
      dailyHalted = false;
    }

    // Phase 1: process exits across all tickers that have a bar at this timestamp.
    const activeTickers: { ticker: string; state: TickerState; i: number }[] = [];
    for (const [ticker, state] of states) {
      const i = advanceCursor(state, timestamp);
      if (i < 1) continue;
      activeTickers.push({ ticker, state, i });
      const r = runCloseLoop(state, i, ticker, rules, techExit, cfg, capital, s, trades, dayKey, dailyHalted);
      dailyHalted = r.dailyHalted;
    }

    // Phase 2: if DLL halted mid-bar, force-close every ticker's positions.
    if (dailyHalted) {
      for (const { ticker, state, i } of activeTickers) {
        forceCloseTicker(state, ticker, state.closes[i], dayKey, cfg, capital, s, trades);
      }
    }

    // Phase 3: try to open new entries on each active ticker.
    for (const { ticker, state, i } of activeTickers) {
      tryOpenEntry(state, i, ticker, rules, techEntry, cfg, s, states, dailyHalted);
    }
  }
  if (currentDayKey !== "") finalizeDay(s, currentDayKey);

  const result: BacktestMetrics = {
    ...calculateMetrics(trades, capital, firstTickerPrices, null),
    sentiment_conditions_excluded: sentimentExcluded,
    backtest_mode: mode,
    per_ticker: buildPerTickerSummary(states, trades, capital),
  };

  if (rules.prop_firm) {
    result.prop_firm_report = buildPropFirmReport(
      rules.prop_firm,
      capital,
      trades,
      s.dailyPnl,
      s.totalSlippage,
      s.totalCommission,
      s.peakDrawdownPct,
      s.maxConsecLosses,
      s.killTriggered,
      s.drawdownBreached,
      s.maxConsecLosingDays
    );
  }
  return result;
}
