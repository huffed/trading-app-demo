import {
  isPatternCondition,
  isTechnicalCondition,
  type AlgorithmRules,
  type EntryCondition,
  type ExitCondition,
} from "@/types/algorithm";
import { calculateMetrics } from "./backtest-metrics";
import {
  checkConditions as checkMixedConditions,
  type ConditionContext,
  type EvaluableCondition,
} from "./condition-evaluator";
import { buildVetoCheck, type EconomicEvent } from "./economic-calendar";
import { getValues, type Cache } from "./indicator-registry";
import { evaluateTechnical } from "./technical-evaluator";
import {
  applySlippage,
  buildPropFirmReport,
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
import type { BacktestMetrics, BacktestTrade, OpenPosition, PriceBar } from "./types";

export type { Cache } from "./indicator-registry";

export interface BacktestContext {
  symbol?: string;
  events?: EconomicEvent[];
}
/** Re-export for legacy import sites. */
export type { ConditionContext, EvaluableCondition };

export function checkConditions(
  conditions: EvaluableCondition[],
  ctx: ConditionContext,
  logic?: AlgorithmRules["entry_logic"]
): boolean {
  return checkMixedConditions(
    conditions,
    ctx,
    (c, c2) => evaluateTechnical(c, getValues(c.indicator, c2.cache, c2.closes), c2.closes, c2.cache, c2.i),
    logic
  );
}
export function normalize(
  conditions: (EntryCondition | ExitCondition)[]
): (EntryCondition | ExitCondition)[] {
  return conditions.map((c) => {
    if (!c.type && "indicator" in c) {
      return Object.assign({}, c, { type: "technical" as const }) as TechnicalCondition;
    }
    return c;
  });
}
const DEFAULT_MAX_POSITIONS = 1;
const DEFAULT_POSITION_SIZE_PCT = 10;
const DEFAULT_STOP_LOSS_PCT = 5;
const DEFAULT_TAKE_PROFIT_PCT = 15;

function buildSimConfig(rules: AlgorithmRules): SimConfig {
  const pf = rules.prop_firm;
  return {
    slippageBps: pf?.slippage_bps ?? 0,
    commissionPct: pf?.commission_pct ?? 0,
    maxPos: rules.max_positions ?? DEFAULT_MAX_POSITIONS,
    posSize: (rules.position_sizing?.value ?? DEFAULT_POSITION_SIZE_PCT) / 100,
    stopPct: (rules.stop_loss?.value ?? DEFAULT_STOP_LOSS_PCT) / 100,
    tpPct: (rules.take_profit?.value ?? DEFAULT_TAKE_PROFIT_PCT) / 100,
  };
}


function runSimulation(
  prices: PriceBar[],
  capital: number,
  rules: AlgorithmRules,
  entry: EvaluableCondition[],
  exit: EvaluableCondition[],
  vetoCheck: ((barDate: string) => boolean) | null,
  symbol?: string
): { trades: BacktestTrade[]; openPos: OpenPosition | null; state: SimState } {
  const pf = rules.prop_firm;
  const cfg = buildSimConfig(rules);
  const closes = prices.map((p) => p.close);
  const cache: Cache = new Map();
  const trades: BacktestTrade[] = [];
  const positions: {
    entryPrice: number;
    entryDate: string;
    notionalValue: number;
    marginRequired: number;
  }[] = [];
  const s = initialSimState(capital);
  let currentDayKey = "";
  let dailyHalted = false;

  for (let i = 1; i < prices.length; i++) {
    const bar = prices[i];
    const day = bar.date;
    // Daily bars have date "YYYY-MM-DD"; intraday bars carry full timestamps.
    const dayKey = day.split(/[ T]/)[0];
    if (dayKey !== currentDayKey) {
      if (currentDayKey !== "") finalizeDay(s, currentDayKey);
      currentDayKey = dayKey;
      dailyHalted = false;
    }
    const ctx: ConditionContext = { cache, closes, bars: prices, i };
    const signalExitFired =
      (exit.length > 0 && checkConditions(exit, ctx, rules.entry_logic)) ||
      s.drawdownBreached;
    for (let p = positions.length - 1; p >= 0; p--) {
      const pos = positions[p];
      const exitPrice = pickBacktestExitPrice(pos, bar, closes[i], cfg, signalExitFired);
      if (exitPrice !== null) {
        closeSimPosition(pos, dayKey, exitPrice, capital, cfg, s, trades);
        positions.splice(p, 1);
        if (pf) dailyHalted = enforcePropFirm(pf, s, capital, dayKey, dailyHalted);
      }
    }
    // Real prop-firm behaviour: DLL breach mid-bar force-closes all positions.
    if (dailyHalted) forceCloseAllPositions(positions, dayKey, closes[i], capital, cfg, s, trades);
    const vetoed = vetoCheck ? vetoCheck(day) : false;
    if (
      !s.killTriggered &&
      !s.drawdownBreached &&
      !dailyHalted &&
      !vetoed &&
      positions.length < cfg.maxPos &&
      checkConditions(entry, ctx, rules.entry_logic)
    ) {
      const entryPrice = applySlippage(closes[i], cfg.slippageBps, true);
      const sized = sizeForBacktest(rules, s.equity, entryPrice, symbol, cfg);
      const freeMargin = s.equity - s.marginUsed;
      // Skip the entry if there's not enough free margin (lot sizing only —
      // for percentage/fixed sizing margin equals notional and free margin
      // grows with equity, so this rarely binds).
      if (sized.margin <= freeMargin && sized.notional > 0) {
        s.marginUsed += sized.margin;
        positions.push({
          entryPrice,
          entryDate: day,
          notionalValue: sized.notional,
          marginRequired: sized.margin,
        });
      }
    }
  }
  // Finalise the very last day so its pnl contributes to the streak.
  if (currentDayKey !== "") {
    finalizeDay(s, currentDayKey);
  }
  const openPos = getOpenPosition(positions, closes);
  return { trades, openPos, state: s };
}

function getOpenPosition(
  positions: { entryPrice: number; entryDate: string; notionalValue: number }[],
  closes: number[]
): OpenPosition | null {
  // marginRequired exists on the live shape but doesn't matter for the
  // unrealized-pnl summary so we don't include it in this signature.
  if (positions.length === 0) {
    return null;
  }
  const lastPrice = closes[closes.length - 1];
  const pos = positions[0];
  const pnlPct = (lastPrice - pos.entryPrice) / pos.entryPrice;
  return {
    entry_date: pos.entryDate,
    entry_price: pos.entryPrice,
    current_price: lastPrice,
    side: "long",
    unrealized_pnl: Number((pos.notionalValue * pnlPct).toFixed(2)),
    unrealized_pnl_pct: Number((pnlPct * 100).toFixed(2)),
  };
}

export function runBacktest(
  rules: AlgorithmRules,
  prices: PriceBar[],
  capital: number,
  context?: BacktestContext
): BacktestMetrics {
  const entry = normalize(rules.entry_conditions);
  const exit = normalize(rules.exit_conditions);
  const evaluableEntry = entry.filter(
    (c) => isTechnicalCondition(c) || isPatternCondition(c)
  ) as EvaluableCondition[];
  const evaluableExit = exit.filter(
    (c) => isTechnicalCondition(c) || isPatternCondition(c)
  ) as EvaluableCondition[];
  const sentimentExcluded =
    entry.length - evaluableEntry.length + (exit.length - evaluableExit.length);
  const mode = sentimentExcluded > 0 ? ("technical_only" as const) : ("full" as const);

  if (evaluableEntry.length === 0) {
    return {
      ...calculateMetrics([], capital, prices, null),
      sentiment_conditions_excluded: sentimentExcluded,
      backtest_mode: mode,
    };
  }

  const vetoCheck = rules.news_veto?.enabled
    ? buildVetoCheck({ symbol: context?.symbol, events: context?.events, veto: rules.news_veto })
    : null;
  const { trades, openPos, state } = runSimulation(
    prices,
    capital,
    rules,
    evaluableEntry,
    evaluableExit,
    vetoCheck,
    context?.symbol
  );
  const result: BacktestMetrics = {
    ...calculateMetrics(trades, capital, prices, openPos),
    sentiment_conditions_excluded: sentimentExcluded,
    backtest_mode: mode,
  };

  if (rules.prop_firm) {
    result.prop_firm_report = buildPropFirmReport(
      rules.prop_firm,
      capital,
      trades,
      state.dailyPnl,
      state.totalSlippage,
      state.totalCommission,
      state.peakDrawdownPct,
      state.maxConsecLosses,
      state.killTriggered,
      state.drawdownBreached,
      state.maxConsecLosingDays
    );
  }
  return result;
}
