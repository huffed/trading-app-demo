// CB.H1 pass 14 (2026-06-22): `runSimulation` + `buildSimConfig` +
// `getOpenPosition` extracted to `./backtest-simulation.ts`. This file
// stays focused on the public `runBacktest` orchestrator.
// CB.C6 (2026-06-20): condition-evaluation utilities now live in their own
// neutral module. backtest-engine imports them back for use inside the
// simulation loop; the live scan path imports from the new module directly
// (no more live → backtest-engine dependency).
import {
  checkConditions,
  collectOtherTimeframes,
  convictionMultiplierForRules,
  countConditionsMet,
  countTimeframesAgreeing,
  evaluateConditionsDetailed,
  normalize,
  type Cache,
  type ConditionContext,
  type EvaluableCondition,
} from "@/lib/conditions/evaluate";
import {
  isPatternCondition,
  isTechnicalCondition,
  type AlgorithmRules,
} from "@/types/algorithm";
import { calculateMetrics } from "./backtest-metrics";
import { runSimulation } from "./backtest-simulation";
import { buildVetoCheck, type EconomicEvent } from "./economic-calendar";
import { buildPropFirmReport } from "./prop-firm-backtest";
import type { BacktestMetrics, PriceBar } from "./types";

export interface BacktestContext {
  symbol?: string;
  events?: EconomicEvent[];
}

// CB.C6 back-compat re-exports — keep existing import sites that pull
// these from backtest-engine.ts working until/unless we migrate them to
// `@/lib/conditions/evaluate` directly. New code SHOULD import from the
// new module; these re-exports exist so the refactor is non-breaking.
export {
  checkConditions,
  collectOtherTimeframes,
  convictionMultiplierForRules,
  countConditionsMet,
  countTimeframesAgreeing,
  evaluateConditionsDetailed,
  normalize,
};
export type { Cache, ConditionContext, EvaluableCondition };

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
