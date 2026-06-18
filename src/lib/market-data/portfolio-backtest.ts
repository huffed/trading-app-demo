/**
 * Portfolio backtest — runs the algorithm across multiple watchlist tickers
 * simultaneously with a single shared capital pool. Per-ticker indicator
 * caches and positions, shared SimState (equity, dailyPnl, kill switch).
 *
 * max_positions caps the TOTAL number of open positions across all tickers;
 * max_per_ticker still caps pyramiding on each individual symbol.
 */
import { checkDxyDirection } from "@/lib/algorithm/dxy-filter";
import { checkAtrLiquidity } from "@/lib/algorithm/intraday-atr-gate";
import {
  checkMarketStateGateConfig,
  computePositionInRangePct,
  type GateContext,
} from "@/lib/algorithm/market-state-gate";
import { checkStagnantExit } from "@/lib/algorithm/stagnant-exit";
import {
  computeSlDistance,
  computeTpDistance,
  takeProfitRuleForSide,
} from "@/lib/algorithm/structural-sl";
import {
  initTrailingState,
  trailingFeaturesEnabled,
  updateTrailingState,
  type TrailingState,
} from "@/lib/algorithm/trailing-stop";
import { atr14 } from "./market-state";
import {
  DEFAULT_MAX_POSITIONS,
  DEFAULT_POSITION_SIZE_PCT,
  DEFAULT_STOP_LOSS_PCT,
  DEFAULT_TAKE_PROFIT_PCT,
} from "@/lib/constants/defaults";
import {
  computeMarketState4h,
  lastIdxAtOrBefore,
  type MarketState,
} from "@/lib/market-data/market-state";
import {
  isPatternCondition,
  isTechnicalCondition,
  type AlgorithmRules,
  type PatternCondition,
  type TechnicalCondition,
} from "@/types/algorithm";
import { isWeakTrendByAdx } from "./adx-filter";
import { resolveSide } from "./auto-side";
import {
  checkConditions,
  collectOtherTimeframes,
  convictionMultiplierForRules,
  normalize,
} from "./backtest-engine";
import { calculateMetrics } from "./backtest-metrics";
import { type BarsBundle } from "./condition-evaluator";
import {
  buildVetoCheck,
  getEventCurrencies,
  type EconomicEvent,
} from "./economic-calendar";
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
import { isRangingByAtr } from "./regime-filter";
import { alignBarIndex, resampleTo, resampleToDaily } from "./resample";
import type {
  BacktestMetrics,
  BacktestTrade,
  PerTickerSummary,
  PriceBar,
} from "./types";

interface PortfolioPosition {
  entryPrice: number;
  entryDate: string;
  /** Bar index at which the position was opened. Used by the stagnant-exit
   *  gate to compute MFE / bars-open without scanning the full series. */
  entryBarIndex: number;
  notionalValue: number;
  marginRequired: number;
  ticker: string;
  side: "long" | "short";
  /** SL / TP distances in price units, captured ONCE at entry. Stored
   *  rather than recomputed because swing_anchor and rr_multiple depend
   *  on entry-bar context (recent bars / resolved SL distance) that
   *  shouldn't drift across the position's life. Subsequent calls
   *  (trailing init, stagnant gate, exit-price detection) read these
   *  fields directly. */
  slDistance: number;
  tpDistance: number;
  /** Trailing-stop / breakeven state. Set when either feature is enabled
   *  on the rule. Updated each bar via `updateTrailingState`. The
   *  `currentSlPrice` field overrides the rule-derived SL inside
   *  `pickBacktestExitPrice` via the `stopPriceOverride` arg. */
  trailingState?: TrailingState;
}

interface TickerState {
  bars: PriceBar[];
  /** Resampled D1 view of `bars`, used by daily_bias pattern conditions. */
  higherTfBars: PriceBar[];
  /** Per-non-primary-timeframe resampled bars + cache. Built once per
   *  ticker; bar index is realigned each iteration via alignBarIndex. */
  tfBars: Map<string, PriceBar[]>;
  tfCaches: Map<string, Cache>;
  closes: number[];
  cache: Cache;
  positions: PortfolioPosition[];
  vetoCheck: ((barDate: string) => boolean) | null;
  /** Economic events in scope for this ticker — passed verbatim to
   *  pattern conditions like `post_news_window`. Same array across all
   *  tickers (events are global), kept on state for entryCtx assembly. */
  newsEvents: EconomicEvent[];
  /** Currencies whose news affects this ticker (via getEventCurrencies).
   *  Computed once per ticker so post_news_window can filter to relevant
   *  events without per-bar work. */
  relevantCurrencies: string[];
  /** Optional DXY proxy bars (EUR/USD 1h) shared across all ticker
   *  states in a run. Populated only when caller passes proxyBars to
   *  runPortfolioBacktest AND the algo has dxy_filter configured. */
  dxyBars: PriceBar[] | null;
  /** Full-depth series for market_state_gate evaluation. The state
   *  percentile windows (~1y of 4h bars) must see deep history — the
   *  window-sliced sim bars would silently shift every percentile and
   *  diverge gate decisions from live. Null when the caller supplied no
   *  marketStateSeries (gated algos then fail closed, mirroring live). */
  stateSeries: {
    bars4h: PriceBar[];
    oneHour: PriceBar[];
    daily: PriceBar[];
    eurusd4h: PriceBar[];
  } | null;
  /** Index of the most recently processed bar (for fast lookup as the
   *  unified timeline advances). */
  cursor: number;
}

/** Full-depth (NOT window-sliced) series for market_state_gate
 *  evaluation during validation runs. Keyed by ticker; `daily` falls
 *  back to a resample of `bars4h` when native daily candles aren't
 *  supplied. Walk-forward callers pass this once — windows keep their
 *  sliced sim bars while gate states are computed against full history,
 *  exactly how live computes them. */
export interface MarketStateSeries {
  bars4h: Map<string, PriceBar[]>;
  oneHour: Map<string, PriceBar[]>;
  daily?: Map<string, PriceBar[]>;
  eurusd4h: PriceBar[];
}


function buildSimConfig(rules: AlgorithmRules): SimConfig {
  const pf = rules.prop_firm;
  return {
    slippageBps: pf?.slippage_bps ?? 0,
    spreadBps: pf?.spread_bps ?? 0,
    commissionPct: pf?.commission_pct ?? 0,
    commissionPerLot: pf?.commission_per_lot ?? 0,
    maxPos: rules.max_positions ?? DEFAULT_MAX_POSITIONS,
    posSize: (rules.position_sizing?.value ?? DEFAULT_POSITION_SIZE_PCT) / 100,
    stopLoss: rules.stop_loss ?? { type: "percentage", value: DEFAULT_STOP_LOSS_PCT },
    takeProfit: rules.take_profit ?? { type: "percentage", value: DEFAULT_TAKE_PROFIT_PCT },
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
  events: EconomicEvent[],
  proxyBars: PriceBar[] | null,
  marketStateSeries: MarketStateSeries | null = null
): Map<string, TickerState> {
  // Pre-resolve unique non-primary timeframes from the rule's conditions
  // so each ticker resamples once and reuses across the simulation loop.
  const primaryTf = rules.timeframe.toLowerCase();
  const otherTfs = collectOtherTimeframes(
    rules.entry_conditions,
    rules.exit_conditions,
    primaryTf
  );
  const out = new Map<string, TickerState>();
  for (const [ticker, prices] of pricesByTicker) {
    const tfBars = new Map<string, PriceBar[]>();
    const tfCaches = new Map<string, Cache>();
    for (const tf of otherTfs) {
      tfBars.set(tf, resampleTo(prices, tf));
      tfCaches.set(tf, new Map());
    }
    out.set(ticker, {
      bars: prices,
      higherTfBars: resampleToDaily(prices),
      tfBars,
      tfCaches,
      closes: prices.map((p) => p.close),
      cache: new Map(),
      positions: [],
      vetoCheck: rules.news_veto?.enabled
        ? buildVetoCheck({ symbol: ticker, events, veto: rules.news_veto })
        : null,
      newsEvents: events,
      relevantCurrencies: getEventCurrencies(ticker),
      dxyBars: proxyBars,
      stateSeries: (() => {
        const fullBars4h = marketStateSeries?.bars4h.get(ticker);
        if (!fullBars4h || fullBars4h.length === 0) return null;
        return {
          bars4h: fullBars4h,
          oneHour: marketStateSeries?.oneHour.get(ticker) ?? [],
          daily: marketStateSeries?.daily?.get(ticker) ?? resampleToDaily(fullBars4h),
          eurusd4h: marketStateSeries?.eurusd4h ?? [],
        };
      })(),
      cursor: -1,
    });
  }
  return out;
}

/** Market state at a sim bar, computed against the FULL-depth series
 *  (never the window slice). Returns null — which the gate fails closed
 *  on — when no series was supplied or the primary TF isn't 4h (states
 *  are defined on the 4h frame; lower-TF frames arrive with S4). */
function marketStateForBar(
  state: TickerState,
  barDate: string,
  rules: AlgorithmRules
): MarketState | null {
  const ss = state.stateSeries;
  if (!ss || rules.timeframe.toLowerCase() !== "4h") return null;
  const idx = lastIdxAtOrBefore(ss.bars4h, barDate);
  if (idx < 0) return null;
  return computeMarketState4h(
    { bars4h: ss.bars4h, oneHourBars: ss.oneHour, dailyBars: ss.daily, eurusd4h: ss.eurusd4h },
    idx
  );
}

/** Build the per-non-primary-timeframe bundle map for the current bar.
 *  Each TF's bars are aligned to the primary's "now" via alignBarIndex.
 *  Returns undefined when the algo has no non-primary timeframes. */
function buildByTimeframe(
  state: TickerState,
  primaryDate: string
): Map<string, BarsBundle> | undefined {
  if (state.tfBars.size === 0) return undefined;
  const out = new Map<string, BarsBundle>();
  for (const [tf, bars] of state.tfBars) {
    const idx = alignBarIndex(bars, primaryDate);
    if (idx < 0) continue;
    out.set(tf, {
      bars,
      closes: bars.map((b) => b.close),
      cache: state.tfCaches.get(tf)!,
      i: idx,
    });
  }
  return out.size > 0 ? out : undefined;
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
        {
        cache: state.cache,
        closes: state.closes,
        bars: state.bars,
        higherTfBars: state.higherTfBars,
        i,
        byTimeframe: buildByTimeframe(state, state.bars[i].date),
        primaryTimeframe: rules.timeframe.toLowerCase(),
      },
        rules.exit_logic ?? rules.entry_logic
      )) ||
    s.drawdownBreached;
  const bar = state.bars[i];
  for (let p = state.positions.length - 1; p >= 0; p--) {
    const pos = state.positions[p];
    // Update trailing-stop / breakeven state BEFORE checking SL/TP hits.
    // The position's `trailingState.currentSlPrice` is what
    // pickBacktestExitPrice will use for the SL check — see prop-firm-
    // backtest.ts. MFE updates against bar.high (long) / bar.low (short),
    // then breakeven + trailing layers ratchet the SL up.
    if (pos.trailingState) {
      pos.trailingState = updateTrailingState({
        side: pos.side,
        entryPrice: pos.entryPrice,
        initialSlDistance: pos.slDistance,
        currentBar: bar,
        state: pos.trailingState,
        trailingStop: rules.trailing_stop,
        breakevenMove: rules.breakeven_move,
      });
    }
    // Per-position stagnant gate. Same module live uses, so the
    // backtest cuts losers at the same bar count + MFE thresholds the
    // manage cron will apply to the real-time positions.
    const stagnantFired = rules.stagnant_exit?.enabled
      ? checkStagnantExit({
          bars: state.bars,
          entryBarIndex: pos.entryBarIndex,
          currentBarIndex: i,
          entryPrice: pos.entryPrice,
          side: pos.side,
          stopDistance: pos.slDistance,
          config: rules.stagnant_exit,
        }).exit
      : false;
    const decision = pickBacktestExitPrice(
      pos,
      bar,
      state.closes[i],
      cfg,
      signalExitFired || stagnantFired,
      ticker
    );
    if (decision !== null) {
      // Reason precedence: pickBacktestExitPrice returns "signal_exit" when
      // SL/TP didn't hit and the signal/stagnant force-close fired.
      // Refine to "stagnant_exit" when that's what actually triggered.
      const reason: BacktestTrade["exit_reason"] =
        decision.reason === "signal_exit" && stagnantFired && !signalExitFired
          ? "stagnant_exit"
          : decision.reason;
      closeSimPosition(pos, dayKey, decision.price, capital, cfg, s, trades, ticker, reason);
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
    closeSimPosition(state.positions[p], dayKey, exitPrice, capital, cfg, s, trades, ticker, "force_close");
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
  entryHaltedToday: boolean;
  vetoed: boolean;
  totalOpenCount: number;
  onTickerCount: number;
}

function canEnter(rules: AlgorithmRules, cfg: SimConfig, gate: EntryGate): boolean {
  if (gate.killTriggered || gate.drawdownBreached || gate.dailyHalted || gate.vetoed) return false;
  if (gate.entryHaltedToday) return false;
  if (gate.totalOpenCount >= cfg.maxPos) return false;
  const perTickerCap = rules.max_per_ticker ?? 1;
  return gate.onTickerCount < perTickerCap;
}

/** A sibling algo's open position window — passed to `runPortfolioBacktest`
 *  for direction-conflict simulation (Phase B.1 backtest fidelity).
 *
 *  Use `tradesAsSiblingWindows(otherAlgoTrades)` to derive these from
 *  another backtest run's trades. The engine checks at each candidate
 *  entry whether any window contains the bar date AND has opposite side.
 *
 *  `risk_dollars` (optional) attaches the at-risk $ for risk-pool halt
 *  simulation. When present, the risk-pool gate sums risk_dollars of
 *  all overlapping siblings + candidate, refuses if combined > cap %. */
export interface SiblingTradeWindow {
  ticker: string;
  side: "long" | "short";
  entry_date: string;
  exit_date: string;
  risk_dollars?: number;
}

/** Phase B.1 fidelity (2026-06-18 PM) — backtest equivalent of live
 *  lib/scan/risk-pool-halt.ts. Caps combined open-$ risk across sibling
 *  algos on the same broker. Refuses entries that would push (current
 *  combined + candidate) above pool_cap_pct%.
 *
 *  Live default: 3% pool cap. Phase B.1 default: 4% (operator's accepted
 *  cap per 2026-06-12 decision per [[project_funded_trading]]). */
export interface RiskPoolConfig {
  enabled: boolean;
  /** Combined risk cap as % of reference_capital. Default 4%. */
  pool_cap_pct: number;
  /** Capital to convert combined-risk-$ → %. Defaults to algo's own
   *  capital if not provided. */
  reference_capital?: number;
}

/** Phase B.1 fidelity (2026-06-18 PM) — backtest equivalent of the live
 *  broker spread gate (`src/lib/algorithm/spread-gate.ts`). Live checks
 *  `(ask - bid) / pip > catalog_typical × 2.5`. Backtest has no bid/ask
 *  data, so substitutes ATR-ratio proxy: `current_ATR(14) / median_ATR
 *  (last N bars) > threshold_multiplier` → infer wide-spread regime →
 *  refuse entry.
 *
 *  Rationale: real broker spreads widen during high-volatility periods
 *  (events, low-liquidity hours). ATR is the available proxy for "market
 *  stress." When ATR is 2.5× its median, spreads are likely 2.5× typical. */
export interface SpreadGateConfig {
  enabled: boolean;
  /** Trigger refusal when current ATR / median ATR > this. Default 2.5
   *  matches the live SPREAD_GATE_MULTIPLIER on bid/ask. */
  threshold_multiplier: number;
  /** Lookback bars for the rolling median ATR baseline. Default 200. */
  atr_lookback_bars: number;
}

/** Convert a trade list into sibling-window form for direction-conflict
 *  + risk-pool simulation. Trades without `ticker` (single-ticker legacy)
 *  are dropped — caller should ensure all trades carry ticker.
 *
 *  Optional `riskDollarsPerTrade` attaches the at-risk $ per trade for
 *  risk-pool halt. Pass `algo.capital × algo.position_sizing.value / 100`
 *  when the algo uses risk_per_trade sizing. */
export function tradesAsSiblingWindows(
  trades: BacktestTrade[],
  riskDollarsPerTrade?: number
): SiblingTradeWindow[] {
  const out: SiblingTradeWindow[] = [];
  for (const t of trades) {
    if (!t.ticker || !t.side) continue;
    const w: SiblingTradeWindow = {
      ticker: t.ticker,
      side: t.side,
      entry_date: t.entry_date,
      exit_date: t.exit_date,
    };
    if (riskDollarsPerTrade != null) w.risk_dollars = riskDollarsPerTrade;
    out.push(w);
  }
  return out;
}

function hasDirectionConflict(
  ticker: string,
  proposedSide: "long" | "short",
  currentDate: string,
  siblings: SiblingTradeWindow[]
): boolean {
  const opposite: "long" | "short" = proposedSide === "long" ? "short" : "long";
  for (const s of siblings) {
    if (s.ticker !== ticker) continue;
    if (s.side !== opposite) continue;
    if (s.entry_date <= currentDate && currentDate < s.exit_date) return true;
  }
  return false;
}

/** Phase B.1 risk-pool halt simulation. Sums risk_dollars of overlapping
 *  siblings at `currentDate` and tests if (combined + candidate) > cap.
 *  Mirrors lib/scan/risk-pool-halt.ts but operates on sibling windows
 *  rather than DB-queried open positions. */
function hasRiskPoolBreach(
  siblings: SiblingTradeWindow[],
  candidateRiskUsd: number,
  currentDate: string,
  referenceCapital: number,
  poolCapPct: number
): boolean {
  if (referenceCapital <= 0) return false;
  let combined = 0;
  for (const s of siblings) {
    if (s.risk_dollars == null) continue;
    if (s.entry_date <= currentDate && currentDate < s.exit_date) {
      combined += s.risk_dollars;
    }
  }
  const combinedPct = ((combined + candidateRiskUsd) / referenceCapital) * 100;
  return combinedPct > poolCapPct;
}

/** Phase B.1 spread-gate proxy. Returns true (refuse entry) when
 *  current ATR(14) / median ATR over `lookback` bars exceeds the
 *  multiplier. Approximation for "broker spread blown out" in absence
 *  of bid/ask data. */
function hasWideSpreadProxy(
  bars: PriceBar[],
  idx: number,
  config: SpreadGateConfig
): boolean {
  if (idx < 14) return false;
  const currentAtr = atr14(bars, idx);
  if (currentAtr == null || currentAtr <= 0) return false;
  // Collect median ATR over lookback window
  const start = Math.max(14, idx - config.atr_lookback_bars);
  const samples: number[] = [];
  for (let j = start; j < idx; j++) {
    const v = atr14(bars, j);
    if (v != null && v > 0) samples.push(v);
  }
  if (samples.length < 30) return false; // not enough history; don't refuse
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  if (median <= 0) return false;
  return currentAtr / median > config.threshold_multiplier;
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
  dailyHalted: boolean,
  /** Phase B.1 backtest fidelity — sibling-algo open positions block
   *  opposite-direction entries (live behavior; previously unsimulated). */
  siblingBlockingTrades: SiblingTradeWindow[] = [],
  /** Phase B.1 backtest fidelity — refuses entries when ATR-ratio proxy
   *  indicates wide-spread regime. Approximates live spread gate. */
  spreadGate: SpreadGateConfig | null = null,
  /** Phase B.1 backtest fidelity — caps combined open-risk-$ across
   *  sibling algos. Refuses entry if (open siblings' risk + candidate
   *  risk) / reference_capital > pool_cap_pct. */
  riskPool: RiskPoolConfig | null = null,
  /** Algo's own capital × risk_pct (in $) — used as candidate's risk
   *  contribution for the risk-pool check. Caller computes this from
   *  rules.position_sizing.value at top-level. */
  algoRiskDollars: number = 0
): void {
  const vetoed = state.vetoCheck ? state.vetoCheck(state.bars[i].date) : false;
  const gate: EntryGate = {
    killTriggered: s.killTriggered,
    drawdownBreached: s.drawdownBreached,
    dailyHalted,
    entryHaltedToday: s.entryHaltedToday,
    vetoed,
    totalOpenCount: totalOpen(states),
    onTickerCount: state.positions.length,
  };
  if (!canEnter(rules, cfg, gate)) return;
  // Intraday ATR liquidity gate — match live engine. Skips entries
  // when the recent primary-timeframe ATR is in the bottom 20% of the
  // lookback distribution. Adaptive replacement for the clock-time
  // session filter that was tied to one specific UTC window.
  if (checkAtrLiquidity(state.bars, i).skip) {
    return;
  }
  // Volatility-regime gate. Use the resampled D1 series so the
  // percentile is stable regardless of primary timeframe (1h vs 15m
  // would otherwise give different verdicts on the same calendar day).
  if (rules.regime_filter?.enabled && state.higherTfBars.length > 0) {
    // Align D1 index to the primary bar's date so we don't peek ahead.
    const dIdx = alignBarIndex(state.higherTfBars, state.bars[i].date);
    if (dIdx >= 0) {
      const regime = isRangingByAtr(state.higherTfBars, dIdx, rules.regime_filter);
      if (regime.skip) return;
    }
  }
  // ADX trend-strength gate — same D1 alignment as the regime filter.
  if (rules.adx_filter?.enabled && state.higherTfBars.length > 0) {
    const dIdx = alignBarIndex(state.higherTfBars, state.bars[i].date);
    if (dIdx >= 0) {
      const adx = isWeakTrendByAdx(state.higherTfBars, dIdx, rules.adx_filter);
      if (adx.skip) return;
    }
  }
  // Resolve active side from rules.side (auto mode reads D1 bias on this
  // ticker — different tickers can trade different directions in the
  // same scan when the algo is regime-adaptive).
  const resolved = resolveSide(rules.side ?? "long", state.higherTfBars, state.bars[i].date);
  if (resolved === null) return;
  const side = resolved.side;
  // Phase B.1 fidelity: direction-conflict gate (mirrors scan/entry.ts:417).
  // When a sibling algo has an OPEN opposite-direction position on the
  // same ticker at this bar date, the live engine refuses the entry to
  // avoid net-zero exposure with double spread cost. Backtest now
  // simulates this; caller passes siblingBlockingTrades from another
  // algo's backtest result (use tradesAsSiblingWindows helper).
  if (siblingBlockingTrades.length > 0
      && hasDirectionConflict(ticker, side, state.bars[i].date, siblingBlockingTrades)) {
    return;
  }
  // Phase B.1 fidelity: spread gate (mirrors lib/algorithm/spread-gate.ts).
  // Live refuses entries when broker spread exceeds catalog typical × 2.5.
  // Backtest substitutes ATR-ratio proxy: refuse when current ATR(14) >
  // threshold_multiplier × rolling median ATR. Approximates "stressed
  // market = wide spread" regime without bid/ask data.
  if (spreadGate?.enabled && hasWideSpreadProxy(state.bars, i, spreadGate)) {
    return;
  }
  // Phase B.1 fidelity: risk-pool halt (mirrors lib/scan/risk-pool-halt.ts).
  // Live caps combined open SL-$ across sibling algos sharing the broker.
  // Backtest sums risk_dollars from overlapping sibling windows + candidate
  // risk and refuses if combined > pool_cap_pct of reference_capital.
  if (riskPool?.enabled && algoRiskDollars > 0) {
    const refCapital = riskPool.reference_capital ?? s.equity;
    if (hasRiskPoolBreach(siblingBlockingTrades, algoRiskDollars, state.bars[i].date, refCapital, riskPool.pool_cap_pct)) {
      return;
    }
  }
  // DXY directional gate. Opt-in per algo. Skips entries when the
  // dollar-index direction (via EUR/USD proxy) over the lookback
  // contradicts the proposed side. Per-algo, not blanket — empirically
  // validated as material uplift on the 15m short gold algo only.
  if (rules.dxy_filter?.enabled && state.dxyBars && state.dxyBars.length > 0) {
    const dxy = checkDxyDirection({
      side,
      currentTimestamp: state.bars[i].date,
      proxyBars: state.dxyBars,
      config: rules.dxy_filter,
    });
    if (dxy.block) return;
  }
  const entryCtx = {
    cache: state.cache,
    closes: state.closes,
    bars: state.bars,
    higherTfBars: state.higherTfBars,
    i,
    directionOverride: resolved.directionOverride,
    news_events: state.newsEvents,
    relevant_currencies: state.relevantCurrencies,
  };
  if (!checkConditions(techEntry, entryCtx, rules.entry_logic)) {
    return;
  }
  // Market-state gate (regime-library dormancy) — same checker live uses.
  // Runs AFTER conditions so the windowed-percentile state math only
  // executes on bars where the strategy actually fired.
  if (rules.market_state_gate) {
    const ms = marketStateForBar(state, state.bars[i].date, rules);
    const gateCtx: GateContext = {
      entryHourUtc: new Date(state.bars[i].date).getUTCHours(),
      positionInRangePct: computePositionInRangePct(
        state.bars.slice(Math.max(0, i - 19), i + 1),
        state.closes[i]
      ),
    };
    if (!checkMarketStateGateConfig(rules.market_state_gate, ms, gateCtx).allowed) return;
  }
  const entryPrice = applySlippage(state.closes[i], cfg.slippageBps, side === "long");
  // Conviction-scaled sizing: dispatch to condition-count or
  // tf-agreement curve based on rules.position_sizing.conviction_metric.
  // Multiplier = 1 for non-conviction sizing types → flat behaviour
  // preserved.
  const convictionMult = convictionMultiplierForRules(rules, techEntry, entryCtx);
  // Capture SL/TP distances ONCE at entry. swing_anchor reads recent
  // bars to find the swing extreme; rr_multiple needs the resolved SL
  // distance. Both are stored on the position so post-entry calls
  // (trailing, stagnant, exit, sizing) read directly without recomputing.
  // Computed BEFORE sizing because risk_per_trade sizing needs the SL
  // distance to derive lot count.
  const slDistance = computeSlDistance(rules.stop_loss, side, entryPrice, ticker, state.bars, i);
  const tpDistance = computeTpDistance(
    takeProfitRuleForSide(rules, side),
    slDistance,
    entryPrice,
    ticker,
    undefined,
    // Level-based TP rules read the previous day's extreme; the
    // resampled-D1 series is the sim's daily view (native daily when the
    // caller supplied marketStateSeries.daily would be marginally truer,
    // but higherTfBars is what every other D1-aware gate in this sim
    // uses — consistency wins).
    state.higherTfBars.length > 0
      ? { side, entryDate: state.bars[i].date, dailyBars: state.higherTfBars }
      : undefined
  );
  const sized = sizeForBacktest(
    rules,
    s.equity,
    entryPrice,
    ticker,
    cfg,
    convictionMult,
    slDistance
  );
  const freeMargin = s.equity - s.marginUsed;
  if (sized.margin > freeMargin || sized.notional <= 0) return;
  s.marginUsed += sized.margin;
  // Initialise trailing state when either feature is enabled.
  let initialTrailingState: TrailingState | undefined;
  if (trailingFeaturesEnabled(rules)) {
    const initialSlPrice = side === "long" ? entryPrice - slDistance : entryPrice + slDistance;
    // Compute ATR(14) at entry — used only by the ATR-variant of
    // trailing_stop. Cheap; always captured so the rule type can be
    // switched without re-entering positions.
    const initialAtr = atr14(state.bars, i) ?? undefined;
    initialTrailingState = initTrailingState({ entryPrice, initialSlPrice, initialAtr });
  }
  state.positions.push({
    entryPrice,
    entryDate: state.bars[i].date,
    entryBarIndex: i,
    notionalValue: sized.notional,
    marginRequired: sized.margin,
    ticker,
    side,
    slDistance,
    tpDistance,
    trailingState: initialTrailingState,
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
  events: EconomicEvent[] = [],
  /** Optional EUR/USD bars used as DXY proxy for the dxy_filter gate.
   *  When null AND the algo has dxy_filter enabled, the gate behaves
   *  as a no-op (logs no_data status). Required when validating the
   *  filter via inspect-algo overlay. */
  proxyBars: PriceBar[] | null = null,
  /** Full-depth series for market_state_gate evaluation — REQUIRED when
   *  validating a gated algo; without it the gate fails closed and the
   *  run produces zero entries (loudly wrong rather than silently
   *  unfaithful). See MarketStateSeries. */
  marketStateSeries: MarketStateSeries | null = null,
  /** Phase B.1 backtest fidelity (2026-06-18 PM) — sibling algos' open
   *  position windows that block opposite-direction entries on the same
   *  ticker. Pass `tradesAsSiblingWindows(otherAlgoTrades)`. Empty by
   *  default = no direction-conflict simulation (legacy behaviour). */
  siblingBlockingTrades: SiblingTradeWindow[] = [],
  /** Phase B.1 backtest fidelity — ATR-ratio proxy for live spread gate.
   *  Default null = no spread simulation. Recommended config: enabled=true,
   *  threshold_multiplier=2.5 (matches live SPREAD_GATE_MULTIPLIER),
   *  atr_lookback_bars=200. */
  spreadGate: SpreadGateConfig | null = null,
  /** Phase B.1 backtest fidelity — caps combined open-risk-$ across
   *  sibling algos. Default null = no risk-pool simulation. Recommended:
   *  enabled=true, pool_cap_pct=4 (operator's accepted cap per 2026-06-12). */
  riskPool: RiskPoolConfig | null = null
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
  const states = initTickerStates(rules, pricesByTicker, events, proxyBars, marketStateSeries);
  const timeline = buildTimeline(pricesByTicker);
  const s = initialSimState(capital);
  const trades: BacktestTrade[] = [];
  let currentDayKey = "";
  let dailyHalted = false;
  // Phase B.1: pre-compute candidate risk-$ for risk-pool halt simulation.
  // Uses capital × risk_pct (risk_per_trade sizing convention).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sizingValue = ((rules as any).position_sizing?.value ?? 0) as number;
  const algoRiskDollars = capital * (sizingValue / 100);

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
      tryOpenEntry(state, i, ticker, rules, techEntry, cfg, s, states, dailyHalted, siblingBlockingTrades, spreadGate, riskPool, algoRiskDollars);
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
