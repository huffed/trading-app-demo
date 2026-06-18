import {
  clampLotsToConstraints,
  getBacktestVolumeConstraints,
  getContractSize,
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
  /** Peak-to-trough trailing drawdown as % of starting capital.
   *  RISK STAT — not used for halt decisions (FTMO uses static). */
  peakDrawdownPct: number;
  /** Static-from-start drawdown — max(0, (capital - equity) / capital × 100).
   *  This is the actual FTMO breach metric. Only positive when equity
   *  is BELOW starting capital. */
  peakStaticDdPct: number;
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
  /** Commission in dollars per lot per round-turn (open + close combined).
   *  How retail / prop-firm brokers actually charge: FTMO forex majors
   *  ~$7/lot, gold typically $7-10/lot. Applied alongside commissionPct
   *  — they're additive so an algo can be configured for either or
   *  both. Defaults to 0 for backwards compat. */
  commissionPerLot: number;
  maxPos: number;
  posSize: number;
  /** Stop / TP rule in original form. Resolved per-position against the
   *  entry price + symbol so pip-typed rules produce correct prices on
   *  forex pairs with different pip sizes (EUR/USD vs USD/JPY). */
  stopLoss: StopLoss;
  takeProfit: TakeProfit;
}

/** Significant-loss cutoff for R-aware consecutive-loss counting. Mirrors
 *  the live `SIGNIFICANT_LOSS_R_THRESHOLD` in `src/lib/scan/consec-loss-halt.ts`.
 *  Losses below 0.25R don't count toward the daily streak (avoids micro
 *  stagnant-cut nips falsely tripping the halt). Wins still reset. */
const SIGNIFICANT_LOSS_R_THRESHOLD = 0.25;

export function closeSimPosition(
  pos: {
    entryPrice: number;
    entryDate: string;
    notionalValue: number;
    marginRequired?: number;
    side?: "long" | "short";
    /** Optional SL distance in price units (captured at entry in
     *  portfolio-backtest). When provided + > 0, enables R-aware
     *  consecutive-loss counting to match live behaviour. When omitted,
     *  legacy "any loss counts" behaviour is preserved for backtest-engine
     *  callers using the simpler position type. */
    slDistance?: number;
  },
  day: string,
  exitPrice: number,
  capital: number,
  cfg: SimConfig,
  s: SimState,
  trades: BacktestTrade[],
  symbol?: string,
  exitReason?: BacktestTrade["exit_reason"]
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
  const pctCommission = notional * (cfg.commissionPct / 100) * 2;
  // Per-lot commission: derive lots from notional / (contractSize × entry).
  // Symbol is optional for legacy callers; without it we skip the lot-
  // based fee entirely. Forex/commodity routes always pass it.
  let lotCommission = 0;
  if (symbol && cfg.commissionPerLot > 0) {
    const contract = getContractSize(symbol);
    if (contract > 0 && pos.entryPrice > 0) {
      const lots = notional / (contract * pos.entryPrice);
      lotCommission = Math.abs(lots) * cfg.commissionPerLot;
    }
  }
  const commission = pctCommission + lotCommission;
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
    ...(exitReason ? { exit_reason: exitReason } : {}),
  });
  s.equity += pnl;
  s.peakEquity = Math.max(s.peakEquity, s.equity);
  // Peak-to-trough trailing — kept as a RISK STAT, not used for the
  // halt decision below (FTMO uses static from-start drawdown).
  s.peakDrawdownPct = Math.max(s.peakDrawdownPct, ((s.peakEquity - s.equity) / capital) * 100);
  // Static-from-start drawdown — only positive when equity is below
  // starting capital. This is the actual FTMO breach metric, exposed
  // for stats so backtest cells can be filtered on the real rule.
  s.peakStaticDdPct = Math.max(s.peakStaticDdPct, Math.max(0, ((capital - s.equity) / capital) * 100));
  s.dailyPnl[day] = (s.dailyPnl[day] ?? 0) + pnl;
  // Streak counter. R-aware when slDistance provided (mirrors live
  // consec-loss-halt.ts): wins reset, significant losses (≥ 0.25R)
  // increment, micro losses (< 0.25R) are SKIPPED (don't reset, don't
  // count). When slDistance is missing, legacy "any loss counts"
  // behaviour preserved for backtest-engine callers.
  if (pnl >= 0) {
    s.consecutiveLosses = 0;
  } else if (pos.slDistance != null && pos.slDistance > 0 && pos.entryPrice > 0) {
    // R-aware path: oneR (in $) = notional × (slDistance / entryPrice).
    const oneR = pos.notionalValue * (pos.slDistance / pos.entryPrice);
    if (oneR > 0 && Math.abs(pnl) / oneR >= SIGNIFICANT_LOSS_R_THRESHOLD) {
      s.consecutiveLosses++;
      s.maxConsecLosses = Math.max(s.maxConsecLosses, s.consecutiveLosses);
    }
    // Micro loss → skip (don't increment, don't reset).
  } else {
    // Legacy path: any loss counts.
    s.consecutiveLosses++;
    s.maxConsecLosses = Math.max(s.maxConsecLosses, s.consecutiveLosses);
  }
}

export function enforcePropFirm(
  pf: PropFirmRules,
  s: SimState,
  capital: number,
  day: string,
  dailyHalted: boolean
): boolean {
  // FTMO standard challenge: breach when CURRENT equity drops below
  // (starting_capital × (1 - max_drawdown_pct/100)). Static floor from
  // initial balance — does NOT trail with peak equity. Equivalent
  // formulation: (capital - equity) / capital × 100 >= max_drawdown_pct.
  //
  // Engine previously used peak-to-trough trailing which is stricter
  // than FTMO's actual rule — it would halt algos in profit after a
  // routine pullback even when actual equity was well above the FTMO
  // $9K floor (for $10K accounts). Diagnostic 2026-06-18 confirmed
  // USD/JPY FVG-DailyBias-Long 4h was a false failure under the old
  // rule — actual FTMO-compliant return was +$18,285 (+183%) over
  // 6yr, never below starting capital. Operator's FTMO dashboard
  // numbers ($5K daily limit + $8,977.86 max permitted on a $100K
  // account with $1,022 already lost) confirmed static-from-start
  // is the right rule. See [[feedback_target_recalibrated_2_to_3_pct]]
  // — that target reset was based on the buggy engine and may be
  // re-evaluated.
  const ddPct = ((capital - s.equity) / capital) * 100;
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
    peakStaticDdPct: 0,
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
  convictionMultiplier: number = 1,
  /** Pre-computed SL distance in price units. Required for structural
   *  rule types (swing_anchor / rr_multiple) whose distance can't be
   *  derived from the rule + entry price alone. For percentage / fixed
   *  / pips rules, omitting this is fine — the function falls back to
   *  ruleAsPctOfEntry which handles those types deterministically. */
  slDistanceOverride?: number
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
      const slPct =
        slDistanceOverride !== undefined && currentPrice > 0
          ? (slDistanceOverride / currentPrice) * 100
          : ruleAsPctOfEntry(rules.stop_loss, currentPrice, symbol);
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
 *
 * If `pos.trailingState.currentSlPrice` is set, the trailing/breakeven-
 * adjusted SL takes precedence over the rule-derived default. The TP
 * is still computed from cfg — trailing replaces the lower-bound SL,
 * not the upper-bound TP. Caller is responsible for updating the
 * trailing state before invoking (e.g., portfolio-backtest's
 * runCloseLoop).
 */
/** Result of intra-bar exit check. The reason is paired with the price
 *  so callers can tag the BacktestTrade with which mechanic fired —
 *  unlocks per-outcome analysis on top of the trade list (e.g., MFE/MAE
 *  per exit reason). */
export interface BacktestExitDecision {
  price: number;
  reason: "stop_loss_hit" | "take_profit_hit" | "signal_exit";
}

export function pickBacktestExitPrice(
  pos: {
    entryPrice: number;
    side?: "long" | "short";
    trailingState?: { currentSlPrice: number };
    /** SL distance captured at entry. Stored on the position so the
     *  intra-bar SL/TP check uses the entry-bar resolved value, even
     *  for swing_anchor / rr_multiple rules that depend on entry-time
     *  context (recent bars, computed SL distance). When omitted (legacy
     *  callers, single-ticker engine before structural-SL), falls back
     *  to recomputing via priceDeltaForRule with the cfg rules. */
    slDistance?: number;
    tpDistance?: number;
  },
  bar: { high: number; low: number },
  closePrice: number,
  cfg: SimConfig,
  signalExitFired: boolean,
  symbol?: string
): BacktestExitDecision | null {
  const side = pos.side ?? "long";
  const slDelta = pos.slDistance ?? priceDeltaForRule(cfg.stopLoss, pos.entryPrice, symbol);
  const tpDelta = pos.tpDistance ?? priceDeltaForRule(cfg.takeProfit, pos.entryPrice, symbol);
  if (side === "short") {
    const baseStopPrice = pos.entryPrice + slDelta;
    const stopPrice = pos.trailingState?.currentSlPrice ?? baseStopPrice;
    const tpPrice = pos.entryPrice - tpDelta;
    // Stops win ties — checked before TP.
    if (bar.high >= stopPrice) return { price: applySlippage(stopPrice, cfg.slippageBps, true), reason: "stop_loss_hit" };
    if (bar.low <= tpPrice) return { price: applySlippage(tpPrice, cfg.slippageBps, true), reason: "take_profit_hit" };
    if (signalExitFired) return { price: applySlippage(closePrice, cfg.slippageBps, true), reason: "signal_exit" };
    return null;
  }
  const baseStopPrice = pos.entryPrice - slDelta;
  const stopPrice = pos.trailingState?.currentSlPrice ?? baseStopPrice;
  const tpPrice = pos.entryPrice + tpDelta;
  if (bar.low <= stopPrice) return { price: applySlippage(stopPrice, cfg.slippageBps, false), reason: "stop_loss_hit" };
  if (bar.high >= tpPrice) return { price: applySlippage(tpPrice, cfg.slippageBps, false), reason: "take_profit_hit" };
  if (signalExitFired) return { price: applySlippage(closePrice, cfg.slippageBps, false), reason: "signal_exit" };
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
    /** Optional per-position ticker — set on the portfolio path so commission-
     *  per-lot can use the right contract size. Single-ticker callers pass the
     *  outer symbol via the `symbol` parameter instead. */
    ticker?: string;
  }[],
  dayKey: string,
  closePrice: number,
  capital: number,
  cfg: SimConfig,
  s: SimState,
  trades: BacktestTrade[],
  symbol?: string
): void {
  if (positions.length === 0) return;
  const exitPrice = applySlippage(closePrice, cfg.slippageBps, false);
  for (let p = positions.length - 1; p >= 0; p--) {
    const pos = positions[p];
    closeSimPosition(pos, dayKey, exitPrice, capital, cfg, s, trades, pos.ticker ?? symbol, "force_close");
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
