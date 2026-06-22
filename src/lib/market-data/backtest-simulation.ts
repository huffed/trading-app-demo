/**
 * Backtest simulation loop — extracted from `backtest-engine.ts` on
 * 2026-06-22 (CB.H1 pass 14). The 199-LOC `runSimulation` plus its two
 * pure helpers (`buildSimConfig`, `getOpenPosition`) all live here so
 * the backtest entry-point file stays focused on the public API
 * (runBacktest) + result shaping.
 */
import { checkAtrLiquidity } from "@/lib/algorithm/intraday-atr-gate";
import { checkStagnantExit } from "@/lib/algorithm/stagnant-exit";
import {
  checkConditions,
  collectOtherTimeframes,
  convictionMultiplierForRules,
  type Cache,
  type ConditionContext,
  type EvaluableCondition,
} from "@/lib/conditions/evaluate";
import {
  DEFAULT_MAX_POSITIONS,
  DEFAULT_POSITION_SIZE_PCT,
  DEFAULT_STOP_LOSS_PCT,
  DEFAULT_TAKE_PROFIT_PCT,
} from "@/lib/constants/defaults";
import { priceDeltaForRule } from "@/lib/constants/markets";
import type { AlgorithmRules } from "@/types/algorithm";
import { isWeakTrendByAdx } from "./adx-filter";
import { resolveSide } from "./auto-side";
import { type BarsBundle } from "./condition-evaluator";
import {
  applySlippage,
  closeSimPosition,
  enforcePropFirm,
  finalizeDay,
  forceCloseAllPositions,
  initialSimState,
  pickBacktestExitPrice,
  sizeForBacktest,
  type SimConfig,
  type SimState,
} from "./prop-firm-backtest";
import { isRangingByAtr } from "./regime-filter";
import { alignBarIndex, resampleTo, resampleToDaily } from "./resample";
import type { BacktestTrade, OpenPosition, PriceBar } from "./types";

export function buildSimConfig(rules: AlgorithmRules): SimConfig {
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

export function runSimulation(
  prices: PriceBar[],
  capital: number,
  rules: AlgorithmRules,
  entry: EvaluableCondition[],
  exit: EvaluableCondition[],
  vetoCheck: ((barDate: string) => boolean) | null,
  symbol?: string
): { trades: BacktestTrade[]; openPos: OpenPosition | null; state: SimState } {
  const loopCtx = buildSimLoopCtx(prices, capital, rules, entry, exit, vetoCheck, symbol);
  const { positions, closes, s, trades } = loopCtx;
  let currentDayKey = "";
  let dailyHalted = false;
  for (let i = 1; i < prices.length; i++) {
    const bar = prices[i];
    const day = bar.date;
    const dayKey = day.split(/[ T]/)[0];
    if (dayKey !== currentDayKey) {
      if (currentDayKey !== "") finalizeDay(s, currentDayKey);
      currentDayKey = dayKey;
      dailyHalted = false;
    }
    dailyHalted = processSimBar(loopCtx, i, dayKey, day, bar, dailyHalted);
  }
  if (currentDayKey !== "") {
    finalizeDay(s, currentDayKey);
  }
  const openPos = getOpenPosition(positions, closes);
  return { trades, openPos, state: s };
}

/** Build the immutable per-run context that the loop iterates over.
 *  Centralises the timeframe/cache/state setup so runSimulation stays
 *  short. */
function buildSimLoopCtx(
  prices: PriceBar[],
  capital: number,
  rules: AlgorithmRules,
  entry: EvaluableCondition[],
  exit: EvaluableCondition[],
  vetoCheck: ((barDate: string) => boolean) | null,
  symbol: string | undefined
): SimLoopCtx {
  const pf = rules.prop_firm;
  const cfg = buildSimConfig(rules);
  const closes = prices.map((p) => p.close);
  const cache: Cache = new Map();
  const higherTfBars = resampleToDaily(prices);
  const primaryTf = rules.timeframe.toLowerCase();
  const otherTfs = collectOtherTimeframes(entry, exit, primaryTf);
  const tfBars = new Map<string, PriceBar[]>();
  const tfCaches = new Map<string, Cache>();
  for (const tf of otherTfs) {
    tfBars.set(tf, resampleTo(prices, tf));
    tfCaches.set(tf, new Map());
  }
  return {
    positions: [],
    prices,
    closes,
    cfg,
    rules,
    symbol,
    pf,
    capital,
    s: initialSimState(capital),
    trades: [],
    vetoCheck,
    higherTfBars,
    primaryTf,
    fixedSide: rules.side ?? "long",
    otherTfs,
    tfBars,
    tfCaches,
    cache,
    entry,
    exit,
  };
}

interface SimLoopCtx {
  positions: Array<{
    entryPrice: number;
    entryDate: string;
    entryBarIndex: number;
    notionalValue: number;
    marginRequired: number;
    side: "long" | "short";
  }>;
  prices: PriceBar[];
  closes: number[];
  cfg: SimConfig;
  rules: AlgorithmRules;
  symbol: string | undefined;
  pf: AlgorithmRules["prop_firm"];
  capital: number;
  s: SimState;
  trades: BacktestTrade[];
  vetoCheck: ((barDate: string) => boolean) | null;
  higherTfBars: PriceBar[];
  primaryTf: string;
  fixedSide: "long" | "short" | "auto";
  otherTfs: string[];
  tfBars: Map<string, PriceBar[]>;
  tfCaches: Map<string, Cache>;
  cache: Cache;
  entry: EvaluableCondition[];
  exit: EvaluableCondition[];
}

/** Per-bar simulation step — runs exit-side gates, closes triggered
 *  positions, force-closes on DLL breach, then evaluates a potential
 *  entry. Mirrors the live cron's tick order (close-side > open-side). */
function processSimBar(
  c: SimLoopCtx,
  i: number,
  dayKey: string,
  day: string,
  bar: PriceBar,
  dailyHalted: boolean
): boolean {
  const resolved = resolveSide(c.fixedSide, c.higherTfBars, bar.date);
  const byTimeframe = buildByTimeframeBundles(c.otherTfs, c.tfBars, c.tfCaches, c.prices, i);
  const ctx: ConditionContext = {
    cache: c.cache,
    closes: c.closes,
    bars: c.prices,
    i,
    higherTfBars: c.higherTfBars,
    directionOverride: resolved?.directionOverride,
    byTimeframe,
    primaryTimeframe: c.primaryTf,
  };
  const signalExitFired =
    (c.exit.length > 0 && checkConditions(c.exit, ctx, c.rules.exit_logic ?? c.rules.entry_logic)) ||
    c.s.drawdownBreached;
  const halted = closePositionsForBar({
    positions: c.positions,
    bar,
    prices: c.prices,
    closes: c.closes,
    cfg: c.cfg,
    rules: c.rules,
    symbol: c.symbol,
    pf: c.pf,
    signalExitFired,
    dayKey,
    capital: c.capital,
    s: c.s,
    trades: c.trades,
    dailyHalted,
    i,
  });
  if (halted) forceCloseAllPositions(c.positions, dayKey, c.closes[i], c.capital, c.cfg, c.s, c.trades, c.symbol);
  if (
    canOpenNewEntry(c.s, c.rules, c.vetoCheck, day, c.prices, c.higherTfBars, i, halted, resolved, c.positions.length, c.cfg.maxPos) &&
    checkConditions(c.entry, ctx, c.rules.entry_logic)
  ) {
    tryOpenSimEntry({ resolved: resolved!, rules: c.rules, entry: c.entry, ctx, closes: c.closes, cfg: c.cfg, s: c.s, symbol: c.symbol, positions: c.positions, day, i });
  }
  return halted;
}

/** Build per-TF condition-context bundles aligned to the primary bar's date. */
function buildByTimeframeBundles(
  otherTfs: string[],
  tfBars: Map<string, PriceBar[]>,
  tfCaches: Map<string, Cache>,
  prices: PriceBar[],
  i: number
): Map<string, BarsBundle> | undefined {
  if (otherTfs.length === 0) return undefined;
  const byTimeframe = new Map<string, BarsBundle>();
  for (const tf of otherTfs) {
    const tfArr = tfBars.get(tf)!;
    const idx = alignBarIndex(tfArr, prices[i].date);
    if (idx < 0) continue;
    byTimeframe.set(tf, {
      bars: tfArr,
      closes: tfArr.map((b) => b.close),
      cache: tfCaches.get(tf)!,
      i: idx,
    });
  }
  return byTimeframe;
}

interface ClosePositionsArgs {
  positions: Array<{
    entryPrice: number;
    entryDate: string;
    entryBarIndex: number;
    notionalValue: number;
    marginRequired: number;
    side: "long" | "short";
  }>;
  bar: PriceBar;
  prices: PriceBar[];
  closes: number[];
  cfg: SimConfig;
  rules: AlgorithmRules;
  symbol: string | undefined;
  pf: AlgorithmRules["prop_firm"];
  signalExitFired: boolean;
  dayKey: string;
  capital: number;
  s: SimState;
  trades: BacktestTrade[];
  dailyHalted: boolean;
  i: number;
}

/** Walk open positions back-to-front and close any that hit SL/TP/signal/stagnant. */
function closePositionsForBar(a: ClosePositionsArgs): boolean {
  let dailyHalted = a.dailyHalted;
  for (let p = a.positions.length - 1; p >= 0; p--) {
    const pos = a.positions[p];
    const stagnantFired = a.rules.stagnant_exit?.enabled
      ? checkStagnantExit({
          bars: a.prices,
          entryBarIndex: pos.entryBarIndex,
          currentBarIndex: a.i,
          entryPrice: pos.entryPrice,
          side: pos.side ?? "long",
          stopDistance: priceDeltaForRule(a.rules.stop_loss, pos.entryPrice, a.symbol),
          config: a.rules.stagnant_exit,
        }).exit
      : false;
    const decision = pickBacktestExitPrice(pos, a.bar, a.closes[a.i], a.cfg, a.signalExitFired || stagnantFired, a.symbol);
    if (decision !== null) {
      const reason =
        decision.reason === "signal_exit" && stagnantFired && !a.signalExitFired
          ? "stagnant_exit"
          : decision.reason;
      closeSimPosition(pos, a.dayKey, decision.price, a.capital, a.cfg, a.s, a.trades, a.symbol, reason);
      a.positions.splice(p, 1);
      if (a.pf) dailyHalted = enforcePropFirm(a.pf, a.s, a.capital, a.dayKey, dailyHalted);
    }
  }
  return dailyHalted;
}

interface TryOpenSimEntryArgs {
  resolved: NonNullable<ReturnType<typeof resolveSide>>;
  rules: AlgorithmRules;
  entry: EvaluableCondition[];
  ctx: ConditionContext;
  closes: number[];
  cfg: SimConfig;
  s: SimState;
  symbol: string | undefined;
  positions: Array<{
    entryPrice: number;
    entryDate: string;
    entryBarIndex: number;
    notionalValue: number;
    marginRequired: number;
    side: "long" | "short";
  }>;
  day: string;
  i: number;
}

/** Open a backtest position when all gates pass — applies slippage,
 *  computes conviction multiplier, sizes, and pushes to the positions
 *  array if free-margin permits. */
function tryOpenSimEntry(a: TryOpenSimEntryArgs): void {
  const side = a.resolved.side;
  const entryPrice = applySlippage(a.closes[a.i], a.cfg.slippageBps, side === "long");
  const convictionMult = convictionMultiplierForRules(a.rules, a.entry, a.ctx);
  const sized = sizeForBacktest(a.rules, a.s.equity, entryPrice, a.symbol, a.cfg, convictionMult);
  const freeMargin = a.s.equity - a.s.marginUsed;
  if (sized.margin <= freeMargin && sized.notional > 0) {
    a.s.marginUsed += sized.margin;
    a.positions.push({
      entryPrice,
      entryDate: a.day,
      entryBarIndex: a.i,
      notionalValue: sized.notional,
      marginRequired: sized.margin,
      side,
    });
  }
}

/** All entry-side preconditions (kill switch / DLL halt / news veto /
 *  regime / ADX / liquidity / side resolved / position cap). Returns true
 *  when ALL preconditions pass + we should evaluate the entry conditions. */
function canOpenNewEntry(
  s: SimState,
  rules: AlgorithmRules,
  vetoCheck: ((barDate: string) => boolean) | null,
  day: string,
  prices: PriceBar[],
  higherTfBars: PriceBar[],
  i: number,
  dailyHalted: boolean,
  resolved: ReturnType<typeof resolveSide>,
  positionCount: number,
  maxPos: number
): boolean {
  if (s.killTriggered || s.drawdownBreached || dailyHalted || s.entryHaltedToday) return false;
  if (vetoCheck && vetoCheck(day)) return false;
  if (resolved === null) return false;
  if (positionCount >= maxPos) return false;
  if (rules.regime_filter?.enabled && isRangingByAtr(prices, i, rules.regime_filter).skip) return false;
  if (rules.adx_filter?.enabled) {
    const dIdx = alignBarIndex(higherTfBars, prices[i].date);
    if (dIdx >= 0 && isWeakTrendByAdx(higherTfBars, dIdx, rules.adx_filter).skip) return false;
  }
  if (checkAtrLiquidity(prices, i).skip) return false;
  return true;
}

export function getOpenPosition(
  positions: {
    entryPrice: number;
    entryDate: string;
    notionalValue: number;
    side?: "long" | "short";
  }[],
  closes: number[]
): OpenPosition | null {
  if (positions.length === 0) {
    return null;
  }
  const lastPrice = closes[closes.length - 1];
  const pos = positions[0];
  const side = pos.side ?? "long";
  const pnlPct =
    side === "long"
      ? (lastPrice - pos.entryPrice) / pos.entryPrice
      : (pos.entryPrice - lastPrice) / pos.entryPrice;
  return {
    entry_date: pos.entryDate,
    entry_price: pos.entryPrice,
    current_price: lastPrice,
    side,
    unrealized_pnl: Number((pos.notionalValue * pnlPct).toFixed(2)),
    unrealized_pnl_pct: Number((pnlPct * 100).toFixed(2)),
  };
}
