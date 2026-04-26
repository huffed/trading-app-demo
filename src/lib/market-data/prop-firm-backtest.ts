import type { PropFirmRules } from "@/types/algorithm";
import type { BacktestTrade, PropFirmReport } from "./types";

export interface SimState {
  equity: number;
  peakEquity: number;
  peakDrawdownPct: number;
  consecutiveLosses: number;
  maxConsecLosses: number;
  totalSlippage: number;
  totalCommission: number;
  killTriggered: boolean;
  drawdownBreached: boolean;
  dailyPnl: Record<string, number>;
}

export interface SimConfig {
  slippageBps: number;
  commissionPct: number;
  maxPos: number;
  posSize: number;
  stopPct: number;
  tpPct: number;
}

export function closeSimPosition(
  pos: { entryPrice: number; entryDate: string },
  day: string,
  exitPrice: number,
  capital: number,
  cfg: SimConfig,
  s: SimState,
  trades: BacktestTrade[]
) {
  const pnlPct = (exitPrice - pos.entryPrice) / pos.entryPrice;
  const commission = capital * cfg.posSize * (cfg.commissionPct / 100) * 2;
  const pnl = Number((capital * cfg.posSize * pnlPct - commission).toFixed(2));
  s.totalSlippage +=
    ((pos.entryPrice + exitPrice) * (cfg.slippageBps / 10000) * capital * cfg.posSize) / exitPrice;
  s.totalCommission += commission;
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
  if (pf.max_consecutive_losses > 0 && s.consecutiveLosses >= pf.max_consecutive_losses) {
    s.killTriggered = true;
  }
  if (pf.daily_loss_limit > 0 && ((s.dailyPnl[day] ?? 0) / capital) * 100 <= -pf.daily_loss_limit) {
    return true;
  }
  return dailyHalted;
}

export function applySlippage(price: number, bps: number, isBuy: boolean): number {
  const slip = price * (bps / 10000);
  return isBuy ? price + slip : price - slip;
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
  drawdownBreached: boolean
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
    failReasons.push(`${maxConsecLosses} consecutive losses triggered kill switch`);
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
