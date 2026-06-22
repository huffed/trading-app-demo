/**
 * Readiness sub-checks — pure functions extracted from
 * `readiness-check.ts` on 2026-06-22 (CB.H1 pass 11). Each returns a
 * `ReadinessCheckResult` (pass/caution/fail + reason + evidence). The
 * orchestrator (`runReadinessCheck`) calls these and combines verdicts.
 *
 * All thresholds are pinned here as module-level constants so a single
 * grep finds every gate value. The thresholds intentionally mirror FTMO
 * standard (`max_static_dd=10`, `max_daily_dd=5`, etc.); see also
 * `[[feedback_winner_rule_return_within_ftmo]]` for the WR floor.
 */
import type { AlgorithmRules } from "@/types/algorithm";

export type ReadinessSeverity = "pass" | "caution" | "fail";

export interface ReadinessCheckResult {
  name: string;
  severity: ReadinessSeverity;
  reason: string;
  evidence?: Record<string, unknown>;
}

export interface WalkForwardSummary {
  total_windows: number;
  mean_win_rate: number;
  mean_return: number;
  mean_drawdown: number;
  win_rate_of_windows: number;
  windows: { total_return: number; max_drawdown: number }[];
}

export interface PairStat {
  ticker: string;
  trades: number;
  wins: number;
  win_rate: number;
  net_pnl: number;
}

const FTMO_PROFIT_TARGET_PCT = 10;
const FTMO_DD_LIMIT_PCT = 10;
const MIN_WALK_FORWARD_WINDOWS = 3;
const MIN_GREEN_WINDOW_RATE = 0.7;
const MAX_MEAN_DD_PCT = 8;
const MIN_PAIR_TRADES_FOR_PRUNE = 8;
const PAIR_WR_FAIL_THRESHOLD = 0.3;

export function combineSeverity(severities: ReadinessSeverity[]): ReadinessSeverity {
  if (severities.includes("fail")) return "fail";
  if (severities.includes("caution")) return "caution";
  return "pass";
}

export function walkForwardCheck(
  wf: WalkForwardSummary,
  capital: number,
  windowDays: number
): ReadinessCheckResult {
  if (wf.total_windows < MIN_WALK_FORWARD_WINDOWS) {
    return {
      name: "walk_forward_stability",
      severity: "caution",
      reason: `Only ${wf.total_windows} window(s) — need ≥${MIN_WALK_FORWARD_WINDOWS} for confidence. Pull more historical data or shorten the window size.`,
      evidence: { total_windows: wf.total_windows },
    };
  }
  const green = wf.win_rate_of_windows;
  const issues: string[] = [];
  if (green < MIN_GREEN_WINDOW_RATE) {
    issues.push(
      `only ${(green * 100).toFixed(0)}% of windows green (need ≥${MIN_GREEN_WINDOW_RATE * 100}%)`
    );
  }
  const projectedReturnPct = capital > 0 ? (wf.mean_return / capital) * 100 : 0;
  const targetForWindow = (FTMO_PROFIT_TARGET_PCT * windowDays) / 180;
  if (projectedReturnPct < targetForWindow) {
    issues.push(
      `mean return ${projectedReturnPct.toFixed(1)}% per ${windowDays}d window below FTMO ${targetForWindow.toFixed(1)}% pace`
    );
  }
  if (wf.mean_drawdown > MAX_MEAN_DD_PCT) {
    issues.push(`mean DD ${wf.mean_drawdown.toFixed(1)}% above safety cap ${MAX_MEAN_DD_PCT}%`);
  }
  const worstDd = Math.max(...wf.windows.map((w) => w.max_drawdown));
  if (worstDd >= FTMO_DD_LIMIT_PCT) {
    issues.push(`worst window DD ${worstDd.toFixed(1)}% breaches FTMO ${FTMO_DD_LIMIT_PCT}% limit`);
  } else if (worstDd >= FTMO_DD_LIMIT_PCT - 2) {
    issues.push(`worst window DD ${worstDd.toFixed(1)}% within 2pp of FTMO limit`);
  }
  if (issues.length === 0) {
    return {
      name: "walk_forward_stability",
      severity: "pass",
      reason: `${wf.total_windows} windows, ${(green * 100).toFixed(0)}% green, mean ret ${projectedReturnPct.toFixed(1)}%, mean DD ${wf.mean_drawdown.toFixed(2)}%, worst DD ${worstDd.toFixed(2)}%`,
      evidence: {
        mean_return_pct: projectedReturnPct,
        mean_dd_pct: wf.mean_drawdown,
        worst_dd_pct: worstDd,
        green_window_rate: green,
      },
    };
  }
  const failed = issues.some((s) => s.includes("breaches FTMO"));
  return {
    name: "walk_forward_stability",
    severity: failed ? "fail" : "caution",
    reason: issues.join("; "),
    evidence: { issues_count: issues.length },
  };
}

export function pairQualityCheck(stats: PairStat[]): ReadinessCheckResult {
  const losers = stats.filter(
    (s) => s.trades >= MIN_PAIR_TRADES_FOR_PRUNE && s.win_rate <= PAIR_WR_FAIL_THRESHOLD
  );
  if (losers.length > 0) {
    return {
      name: "pair_quality",
      severity: "fail",
      reason: `${losers.length} pair(s) at ≤${PAIR_WR_FAIL_THRESHOLD * 100}% WR over ${MIN_PAIR_TRADES_FOR_PRUNE}+ trades — should be auto-paused or removed: ${losers
        .map((l) => `${l.ticker} ${l.wins}/${l.trades}`)
        .join(", ")}`,
      evidence: {
        losers: losers.map((l) => ({
          ticker: l.ticker,
          wins: l.wins,
          trades: l.trades,
          net: l.net_pnl,
        })),
      },
    };
  }
  if (stats.length === 0 || stats.every((s) => s.trades < MIN_PAIR_TRADES_FOR_PRUNE)) {
    return {
      name: "pair_quality",
      severity: "caution",
      reason:
        "Insufficient live trade history to evaluate per-pair quality — only backtest evidence available",
      evidence: { evaluated_pairs: stats.length },
    };
  }
  return {
    name: "pair_quality",
    severity: "pass",
    reason: `All ${stats.length} pairs above ${PAIR_WR_FAIL_THRESHOLD * 100}% WR floor over their live samples`,
    evidence: { evaluated_pairs: stats.length },
  };
}

export function sideSymmetryCheck(side: string | undefined): ReadinessCheckResult {
  if (side === "auto") {
    return {
      name: "side_symmetry",
      severity: "caution",
      reason:
        "side='auto' — verify shorts work via a separate backtest (long-only patterns rarely flip cleanly to bearish, see CHF/JPY short trap on testing 3)",
    };
  }
  return {
    name: "side_symmetry",
    severity: "pass",
    reason: `Fixed direction (side='${side ?? "long"}') — directional asymmetry is not a risk`,
  };
}

export function ftmoFitCheck(rules: AlgorithmRules): ReadinessCheckResult {
  const halt = rules.prop_firm?.consecutive_loss_daily_halt ?? 0;
  const sizing = rules.position_sizing;
  const issues: string[] = [];
  if (sizing.type === "risk_per_trade" && sizing.value > 1) {
    issues.push(`risk_per_trade ${sizing.value}% above 1% — DD risk for FTMO`);
  }
  if (halt === 0) {
    issues.push(
      "no consecutive_loss_daily_halt configured — single bad day could chain into DLL breach"
    );
  }
  if (issues.length === 0) {
    return {
      name: "ftmo_fit",
      severity: "pass",
      reason: `position_sizing ${sizing.type}=${sizing.value}, consecutive_loss_daily_halt ${halt}`,
    };
  }
  return {
    name: "ftmo_fit",
    severity: "caution",
    reason: issues.join("; "),
  };
}
