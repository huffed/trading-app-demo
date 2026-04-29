import {
  clampLotsToConstraints,
  getBacktestVolumeConstraints,
  notionalInUsd,
  priceDeltaForRule,
  riskToLots,
  ruleAsPctOfEntry,
} from "@/lib/constants/markets";
import type {
  AlgorithmRules,
  PropFirmRules,
  StopLoss,
  TakeProfit,
} from "@/types/algorithm";
import type { BacktestTrade, PropFirmReport } from "./types";

export interface SimState {
  equity: number;
  peakEquity: number;
  peakDrawdownPct: number;
  consecutiveLosses: number;
  maxConsecLosses: number;
  /** Streak of consecutive losing CALENDAR DAYS (resets on a positive day). */
  consecutiveLosingDays: number;
  maxConsecLosingDays: number;
  /** Sum of margin currently locked up across all open positions. Only
   *  meaningful when leverage is in play (position_sizing.type === "lots"). */
  marginUsed: number;
  totalSlippage: number;
  totalCommission: number;
  killTriggered: boolean;
  drawdownBreached: boolean;
  dailyPnl: Record<string, number>;
  /** Soft halt: blocks NEW entries for the rest of the calendar day after
   *  N consecutive losses. Lets open positions run to their stops/TPs.
   *  Distinct from dailyHalted (DLL force-close) and killTriggered
   *  (challenge-fail kill). Resets in finalizeDay so next session opens
   *  fresh. */
  entryHaltedToday: boolean;
}

export interface SimConfig {
  slippageBps: number;
  /** Bid/ask spread the broker charges per side, in bps. Separate from
   *  slippage so the user can dial each independently. */
  spreadBps: number;
  commissionPct: number;
  maxPos: number;
  posSize: number;
  /** Stop / TP rule in original form. Resolved per-position against the
   *  entry price + symbol so pip-typed rules produce correct prices on
   *  forex pairs with different pip sizes (EUR/USD vs USD/JPY). */
  stopLoss: StopLoss;
  takeProfit: TakeProfit;
}

export function closeSimPosition(
  pos: {
    entryPrice: number;
    entryDate: string;
    notionalValue: number;
    marginRequired?: number;
    side?: "long" | "short";
  },
  day: string,
  exitPrice: number,
  capital: number,
  cfg: SimConfig,
  s: SimState,
  trades: BacktestTrade[]
) {
  const side = pos.side ?? "long";
  // Direction-aware percent change: longs profit on price rising, shorts
  // profit on price falling. Notional × pct is the gross trade pnl.
  const pnlPct =
    side === "long"
      ? (exitPrice - pos.entryPrice) / pos.entryPrice
      : (pos.entryPrice - exitPrice) / pos.entryPrice;
  // Position notional was sized off equity-at-open, so wins compound naturally
  // as equity grows and losses shrink positions during drawdowns.
  const notional = pos.notionalValue;
  const commission = notional * (cfg.commissionPct / 100) * 2;
  // Spread is a round-trip cost (paid on entry + exit) deducted directly
  // from realised pnl. 1 pip on EUR/USD ≈ 1.4 bp; 5 bp ≈ 0.7 pip per side.
  const spreadCost = notional * (cfg.spreadBps / 10000) * 2;
  const pnl = Number((notional * pnlPct - commission - spreadCost).toFixed(2));
  s.totalSlippage +=
    ((pos.entryPrice + exitPrice) * (cfg.slippageBps / 10000) * notional) / exitPrice;
  s.totalCommission += commission + spreadCost;
  // Refund the margin this position was holding (lot-based sizing only).
  if (pos.marginRequired) {
    s.marginUsed = Math.max(0, s.marginUsed - pos.marginRequired);
  }
  trades.push({
    entry_date: pos.entryDate,
    exit_date: day,
    entry_price: pos.entryPrice,
    exit_price: exitPrice,
    side,
    pnl,
  });
  s.equity += pnl;
  s.peakEquity = Math.max(s.peakEquity, s.equity);
  s.peakDrawdownPct = Math.max(s.peakDrawdownPct, ((s.peakEquity - s.equity) / capital) * 100);
  s.dailyPnl[day] = (s.dailyPnl[day] ?? 0) + pnl;
  if (pnl < 0) {
    s.consecutiveLosses++;
    s.maxConsecLosses = Math.max(s.maxConsecLosses, s.consecutiveLosses);
  } else {
    s.consecutiveLosses = 0;
  }
}

export function enforcePropFirm(
  pf: PropFirmRules,
  s: SimState,
  capital: number,
  day: string,
  dailyHalted: boolean
): boolean {
  const ddPct = ((s.peakEquity - s.equity) / capital) * 100;
  if (pf.max_drawdown > 0 && ddPct >= pf.max_drawdown) {
    s.drawdownBreached = true;
  }
  // max_consecutive_losses == 0 disables the kill switch.
  if (pf.max_consecutive_losses > 0) {
    const unit = pf.consecutive_loss_unit ?? "trades";
    const streak = unit === "days" ? s.consecutiveLosingDays : s.consecutiveLosses;
    if (streak >= pf.max_consecutive_losses) {
      s.killTriggered = true;
    }
  }
  // Soft daily halt — separate from the kill switch. Stops new entries
  // for the rest of the day once N consecutive losing trades fire, but
  // leaves open positions to play out. Resets in finalizeDay.
  const softLimit = pf.consecutive_loss_daily_halt ?? 0;
  if (softLimit > 0 && s.consecutiveLosses >= softLimit) {
    s.entryHaltedToday = true;
  }
  if (pf.daily_loss_limit > 0) {
    // Defensive buffer: halt EARLY at `halt_pct%` of DLL so the engine
    // force-close fires before we actually breach the published limit.
    // Default 100 = halt at exact DLL (legacy behaviour).
    const haltPct = (pf.daily_loss_halt_pct ?? 100) / 100;
    const haltThreshold = -pf.daily_loss_limit * haltPct;
    if (((s.dailyPnl[day] ?? 0) / capital) * 100 <= haltThreshold) {
      return true;
    }
  }
  return dailyHalted;
}

export function initialSimState(capital: number): SimState {
  return {
    equity: capital,
    peakEquity: capital,
    peakDrawdownPct: 0,
    consecutiveLosses: 0,
    maxConsecLosses: 0,
    consecutiveLosingDays: 0,
    maxConsecLosingDays: 0,
    marginUsed: 0,
    totalSlippage: 0,
    totalCommission: 0,
    killTriggered: false,
    drawdownBreached: false,
    dailyPnl: {},
    entryHaltedToday: false,
  };
}

/**
 * Called at the moment we cross to a new calendar day. Updates the
 * losing-days counter from the day that just ended.
 */
export function finalizeDay(s: SimState, dayKey: string) {
  const pnl = s.dailyPnl[dayKey] ?? 0;
  if (pnl < 0) {
    s.consecutiveLosingDays += 1;
    s.maxConsecLosingDays = Math.max(s.maxConsecLosingDays, s.consecutiveLosingDays);
  } else if (pnl > 0) {
    s.consecutiveLosingDays = 0;
  }
  // Days with exactly 0 pnl (no trades) leave the streak unchanged.
  // Reset the soft entry-halt so tomorrow opens fresh.
  s.entryHaltedToday = false;
}

export function applySlippage(price: number, bps: number, isBuy: boolean): number {
  const slip = price * (bps / 10000);
  return isBuy ? price + slip : price - slip;
}

/**
 * Size a new position for the backtest engine. Returns notional + margin
 * required. For percentage/fixed sizing margin == notional (no leverage).
 * For lot-based sizing notional = lots × contractSize × price and
 * margin = notional / leverage.
 */
export function sizeForBacktest(
  rules: AlgorithmRules,
  equity: number,
  currentPrice: number,
  symbol: string | undefined,
  cfg: SimConfig,
  convictionMultiplier: number = 1
): { notional: number; margin: number } {
  const sizing = rules.position_sizing;
  if (
    sizing?.type === "lots" ||
    sizing?.type === "risk_per_trade" ||
    sizing?.type === "conviction_scaled"
  ) {
    // All three paths produce a lot count. risk_per_trade and
    // conviction_scaled derive it from SL + equity so the same algo
    // config produces equivalent % returns on any capital size —
    // strategy scales automatically. conviction_scaled additionally
    // multiplies base risk % by the caller-provided multiplier.
    let lots: number;
    if (sizing.type === "lots") {
      lots = sizing.value;
    } else {
      const slPct = ruleAsPctOfEntry(rules.stop_loss, currentPrice, symbol);
      const effectiveRiskPct =
        sizing.type === "conviction_scaled"
          ? sizing.value * Math.max(1, convictionMultiplier)
          : sizing.value;
      lots = riskToLots(symbol ?? "", equity, effectiveRiskPct, currentPrice, slPct);
    }
    // Clamp to the same volume step / min / max real brokers enforce so
    // backtest results don't depend on fractional lots a broker would
    // reject. Returns 0 when below min — caller treats as "skip entry",
    // matching live broker rejecting an under-min order.
    lots = clampLotsToConstraints(
      lots,
      getBacktestVolumeConstraints(symbol ?? "", rules.asset_class)
    );
    const notional = notionalInUsd(symbol ?? "", lots, currentPrice);
    // Cap effective leverage so backtest doesn't underestimate margin
    // requirements relative to what a real broker enforces. Prop-firm
    // accounts top out around 1:30 (FTMO MT5 typical); retail accounts
    // can go higher (1:100 to 1:500) but the user opts in by setting
    // rules.leverage explicitly. With prop_firm context the cap is
    // 30 — anything above is almost certainly a sizing bug given the
    // operator's known account types.
    const requested = rules.leverage ?? 30;
    const effectiveLeverage = rules.prop_firm ? Math.min(requested, 30) : requested;
    return { notional, margin: notional / effectiveLeverage };
  }
  if (sizing?.type === "fixed_amount") return { notional: sizing.value, margin: sizing.value };
  if (sizing?.type === "fixed_quantity") {
    const notional = sizing.value * currentPrice;
    return { notional, margin: notional };
  }
  const notional = equity * cfg.posSize;
  return { notional, margin: notional };
}

/**
 * Compute the exit price for an open position on the current bar. Stops
 * and TPs fill at the configured level (intra-bar via bar.high/low);
 * signal-based exits fill at the close. Stops win ties.
 *
 * Long: SL is below entry, TP is above. Stop hits when bar.low ≤ SL.
 * Short: SL is above entry, TP is below. Stop hits when bar.high ≥ SL.
 */
export function pickBacktestExitPrice(
  pos: { entryPrice: number; side?: "long" | "short" },
  bar: { high: number; low: number },
  closePrice: number,
  cfg: SimConfig,
  signalExitFired: boolean,
  symbol?: string
): number | null {
  const side = pos.side ?? "long";
  const slDelta = priceDeltaForRule(cfg.stopLoss, pos.entryPrice, symbol);
  const tpDelta = priceDeltaForRule(cfg.takeProfit, pos.entryPrice, symbol);
  if (side === "short") {
    const stopPrice = pos.entryPrice + slDelta;
    const tpPrice = pos.entryPrice - tpDelta;
    // Stops win ties — checked before TP.
    if (bar.high >= stopPrice) return applySlippage(stopPrice, cfg.slippageBps, true);
    if (bar.low <= tpPrice) return applySlippage(tpPrice, cfg.slippageBps, true);
    if (signalExitFired) return applySlippage(closePrice, cfg.slippageBps, true);
    return null;
  }
  const stopPrice = pos.entryPrice - slDelta;
  const tpPrice = pos.entryPrice + tpDelta;
  if (bar.low <= stopPrice) return applySlippage(stopPrice, cfg.slippageBps, false);
  if (bar.high >= tpPrice) return applySlippage(tpPrice, cfg.slippageBps, false);
  if (signalExitFired) return applySlippage(closePrice, cfg.slippageBps, false);
  return null;
}

/**
 * Real prop-firm DLL behaviour: when daily loss hits the limit, the
 * platform closes ALL open positions automatically. This is the
 * shared force-close routine for both single-ticker and portfolio
 * backtests.
 */
export function forceCloseAllPositions(
  positions: {
    entryPrice: number;
    entryDate: string;
    notionalValue: number;
    marginRequired: number;
  }[],
  dayKey: string,
  closePrice: number,
  capital: number,
  cfg: SimConfig,
  s: SimState,
  trades: BacktestTrade[]
): void {
  if (positions.length === 0) return;
  const exitPrice = applySlippage(closePrice, cfg.slippageBps, false);
  for (let p = positions.length - 1; p >= 0; p--) {
    closeSimPosition(positions[p], dayKey, exitPrice, capital, cfg, s, trades);
    positions.splice(p, 1);
  }
}

export function buildPropFirmReport(
  pf: PropFirmRules,
  capital: number,
  trades: BacktestTrade[],
  dailyPnl: Record<string, number>,
  totalSlippage: number,
  totalCommission: number,
  peakDrawdownPct: number,
  maxConsecLosses: number,
  killTriggered: boolean,
  drawdownBreached: boolean,
  maxConsecLosingDays: number = 0
): PropFirmReport {
  const totalProfit = trades.reduce((s, t) => s + t.pnl, 0);
  const dailyLosses = Object.values(dailyPnl);
  const dailyLossPctValues = dailyLosses.map((d) => (d / capital) * 100);
  const maxDailyLoss = dailyLossPctValues.length > 0 ? Math.min(...dailyLossPctValues) : 0;
  const dailyLossBreaches = dailyLossPctValues.filter((d) => d <= -pf.daily_loss_limit).length;

  // Consistency: no single day's profit > X% of total profit
  const totalPositiveProfit = dailyLosses.filter((d) => d > 0).reduce((s, d) => s + d, 0);
  let worstDayPct = 0;
  let consistencyPass = true;
  if (totalPositiveProfit > 0) {
    const dailyProfitPcts = dailyLosses
      .filter((d) => d > 0)
      .map((d) => (d / totalPositiveProfit) * 100);
    worstDayPct = dailyProfitPcts.length > 0 ? Math.max(...dailyProfitPcts) : 0;
    consistencyPass = worstDayPct <= pf.consistency_rule;
  }

  const profitTargetMet = (totalProfit / capital) * 100 >= pf.profit_target;

  const failReasons: string[] = [];
  if (dailyLossBreaches > 0) {
    failReasons.push(`Daily loss limit breached ${dailyLossBreaches} time(s)`);
  }
  if (drawdownBreached) {
    failReasons.push(`Max drawdown exceeded ${pf.max_drawdown}%`);
  }
  if (killTriggered) {
    const unit = pf.consecutive_loss_unit ?? "trades";
    const observed = unit === "days" ? maxConsecLosingDays : maxConsecLosses;
    failReasons.push(`${observed} consecutive losing ${unit} triggered kill switch`);
  }
  if (!consistencyPass) {
    failReasons.push(
      `Single day contributed ${worstDayPct.toFixed(0)}% of total profit (limit: ${pf.consistency_rule}%)`
    );
  }
  if (!profitTargetMet) {
    failReasons.push(
      `Profit target ${pf.profit_target}% not met (achieved: ${((totalProfit / capital) * 100).toFixed(1)}%)`
    );
  }

  return {
    daily_loss_breaches: dailyLossBreaches,
    max_daily_loss: Number(Math.abs(maxDailyLoss).toFixed(2)),
    peak_drawdown: Number(peakDrawdownPct.toFixed(2)),
    drawdown_breached: drawdownBreached,
    max_consecutive_losses: maxConsecLosses,
    kill_switch_triggered: killTriggered,
    consistency_pass: consistencyPass,
    worst_day_pct_of_profit: Number(worstDayPct.toFixed(1)),
    total_slippage: Number(totalSlippage.toFixed(2)),
    total_commission: Number(totalCommission.toFixed(2)),
    profit_target_met: profitTargetMet,
    evaluation_result: failReasons.length === 0 && profitTargetMet ? "pass" : "fail",
    fail_reasons: failReasons,
  };
}
