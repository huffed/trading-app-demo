import { notionalInUsd, riskToLots } from "@/lib/constants/markets";
import type { AlgorithmRules, PropFirmRules } from "@/types/algorithm";
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
}

export interface SimConfig {
  slippageBps: number;
  /** Bid/ask spread the broker charges per side, in bps. Separate from
   *  slippage so the user can dial each independently. */
  spreadBps: number;
  commissionPct: number;
  maxPos: number;
  posSize: number;
  stopPct: number;
  tpPct: number;
}

export function closeSimPosition(
  pos: { entryPrice: number; entryDate: string; notionalValue: number; marginRequired?: number },
  day: string,
  exitPrice: number,
  capital: number,
  cfg: SimConfig,
  s: SimState,
  trades: BacktestTrade[]
) {
  const pnlPct = (exitPrice - pos.entryPrice) / pos.entryPrice;
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
    side: "long",
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
  cfg: SimConfig
): { notional: number; margin: number } {
  const sizing = rules.position_sizing;
  if (sizing?.type === "lots" || sizing?.type === "risk_per_trade") {
    // Both paths produce a lot count. risk_per_trade derives it from SL +
    // equity so the same algo config produces equivalent % returns on any
    // capital size — strategy scales automatically.
    let lots: number;
    if (sizing.type === "lots") {
      lots = sizing.value;
    } else {
      const slPct = rules.stop_loss.type === "percentage" ? rules.stop_loss.value : 1;
      lots = riskToLots(symbol ?? "", equity, sizing.value, currentPrice, slPct);
    }
    const notional = notionalInUsd(symbol ?? "", lots, currentPrice);
    return { notional, margin: notional / (rules.leverage ?? 30) };
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
 */
export function pickBacktestExitPrice(
  pos: { entryPrice: number },
  bar: { high: number; low: number },
  closePrice: number,
  cfg: SimConfig,
  signalExitFired: boolean
): number | null {
  const stopPrice = pos.entryPrice * (1 - cfg.stopPct);
  const tpPrice = pos.entryPrice * (1 + cfg.tpPct);
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
