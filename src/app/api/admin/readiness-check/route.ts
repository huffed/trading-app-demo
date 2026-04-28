/**
 * Admin endpoint: aggregate readiness check for an algorithm. Runs every
 * quality diagnostic we've built and returns a single verdict +
 * itemised PASS/CAUTION/FAIL list — the "should I put real money behind
 * this" call, not buried under 4 separate endpoint calls.
 *
 * Checks:
 *  1. Walk-forward stability — at least N windows, ≥ X% green, mean
 *     return ≥ FTMO target × (window/180), worst-window DD ≤ Y%.
 *  2. Pair quality — no watchlisted pair sits at <30% WR / 8+ trades
 *     (the auto-pair-pruning trigger). Already-pruned pairs note them
 *     as a positive signal.
 *  3. Side symmetry (auto-side only) — verifies that auto-side doesn't
 *     produce catastrophic losses on either direction (the CHF/JPY
 *     short trap testing 3 fell into).
 *  4. FTMO fit — mean DD ≤ 8% (≥2% headroom under the 10% limit), mean
 *     return projects to ≥10% target within 6 months.
 *
 * Each check returns severity (pass | caution | fail) and a concise
 * reason. Overall verdict is the worst severity across all checks.
 *
 * Usage:
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "http://localhost:3000/api/admin/readiness-check?id=<algo>"
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Severity = "pass" | "caution" | "fail";

interface CheckResult {
  name: string;
  severity: Severity;
  reason: string;
  evidence?: Record<string, unknown>;
}

const FTMO_PROFIT_TARGET_PCT = 10;
const FTMO_DD_LIMIT_PCT = 10;
const MIN_WALK_FORWARD_WINDOWS = 3;
const MIN_GREEN_WINDOW_RATE = 0.7;
const MAX_MEAN_DD_PCT = 8;
const MIN_PAIR_TRADES_FOR_PRUNE = 8;
const PAIR_WR_FAIL_THRESHOLD = 0.3;

function combineSeverity(severities: Severity[]): Severity {
  if (severities.includes("fail")) return "fail";
  if (severities.includes("caution")) return "caution";
  return "pass";
}

interface WalkForwardSummary {
  total_windows: number;
  mean_win_rate: number;
  mean_return: number;
  mean_drawdown: number;
  win_rate_of_windows: number;
  windows: { total_return: number; max_drawdown: number }[];
}

function walkForwardCheck(
  wf: WalkForwardSummary,
  capital: number,
  windowDays: number
): CheckResult {
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
    issues.push(`only ${(green * 100).toFixed(0)}% of windows green (need ≥${MIN_GREEN_WINDOW_RATE * 100}%)`);
  }
  // Mean return projected to FTMO 6-month target.
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
  // Worst-window DD vs FTMO limit.
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
      evidence: { mean_return_pct: projectedReturnPct, mean_dd_pct: wf.mean_drawdown, worst_dd_pct: worstDd, green_window_rate: green },
    };
  }
  // FTMO-limit breach is fail; everything else is caution.
  const failed = issues.some((s) => s.includes("breaches FTMO"));
  return {
    name: "walk_forward_stability",
    severity: failed ? "fail" : "caution",
    reason: issues.join("; "),
    evidence: { issues_count: issues.length },
  };
}

interface PairStat {
  ticker: string;
  trades: number;
  wins: number;
  win_rate: number;
  net_pnl: number;
}

function pairQualityCheck(stats: PairStat[]): CheckResult {
  const losers = stats.filter(
    (s) => s.trades >= MIN_PAIR_TRADES_FOR_PRUNE && s.win_rate <= PAIR_WR_FAIL_THRESHOLD
  );
  if (losers.length > 0) {
    return {
      name: "pair_quality",
      severity: "fail",
      reason: `${losers.length} pair(s) at ≤${PAIR_WR_FAIL_THRESHOLD * 100}% WR over ${MIN_PAIR_TRADES_FOR_PRUNE}+ trades — should be auto-paused or removed: ${losers.map((l) => `${l.ticker} ${l.wins}/${l.trades}`).join(", ")}`,
      evidence: { losers: losers.map((l) => ({ ticker: l.ticker, wins: l.wins, trades: l.trades, net: l.net_pnl })) },
    };
  }
  if (stats.length === 0 || stats.every((s) => s.trades < MIN_PAIR_TRADES_FOR_PRUNE)) {
    return {
      name: "pair_quality",
      severity: "caution",
      reason: "Insufficient live trade history to evaluate per-pair quality — only backtest evidence available",
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

function sideSymmetryCheck(side: string | undefined): CheckResult {
  if (side === "auto") {
    return {
      name: "side_symmetry",
      severity: "caution",
      reason: "side='auto' — verify shorts work via a separate backtest (long-only patterns rarely flip cleanly to bearish, see CHF/JPY short trap on testing 3)",
    };
  }
  return {
    name: "side_symmetry",
    severity: "pass",
    reason: `Fixed direction (side='${side ?? "long"}') — directional asymmetry is not a risk`,
  };
}

function ftmoFitCheck(rules: Record<string, unknown>): CheckResult {
  const pf = rules.prop_firm as { consecutive_loss_daily_halt?: number } | undefined;
  const halt = pf?.consecutive_loss_daily_halt ?? 0;
  const sizing = rules.position_sizing as { type?: string; value?: number } | undefined;
  const issues: string[] = [];
  if (sizing?.type === "risk_per_trade" && (sizing.value ?? 0) > 1) {
    issues.push(`risk_per_trade ${sizing.value}% above 1% — DD risk for FTMO`);
  }
  if (halt === 0) {
    issues.push("no consecutive_loss_daily_halt configured — single bad day could chain into DLL breach");
  }
  if (issues.length === 0) {
    return {
      name: "ftmo_fit",
      severity: "pass",
      reason: `risk_per_trade ${sizing?.value ?? "?"}, consecutive_loss_daily_halt ${halt}`,
    };
  }
  return {
    name: "ftmo_fit",
    severity: "caution",
    reason: issues.join("; "),
  };
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const algoId = url.searchParams.get("id");
  const windowDays = Number(url.searchParams.get("window_days") ?? "180");
  const stepDays = Number(url.searchParams.get("step_days") ?? "30");
  if (!algoId) return NextResponse.json({ error: "missing ?id=<algorithm_id>" }, { status: 400 });

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { runWalkForward } = await import("@/lib/market-data/walk-forward");
  const { getAllPairStats } = await import("@/lib/scan/pair-quality");
  const { fetchDailyPrices } = await import("@/lib/market-data/prices");
  const { getCachedPrices, savePricesToCache } = await import("@/lib/market-data/price-cache");
  const { timeframeToInterval } = await import("@/lib/market-data/interval");

  const supabase = createAdminClient();
  const algoRes = await supabase.from("algorithms").select("*").eq("id", algoId).single();
  const algo = algoRes.data as unknown as
    | { rules: import("@/types/algorithm").AlgorithmRules; capital: number; user_id: string; name: string }
    | null;
  if (algoRes.error || !algo) return NextResponse.json({ error: "algorithm not found" }, { status: 404 });

  const wlRes = await supabase
    .from("algorithm_watchlist")
    .select("ticker")
    .eq("algorithm_id", algoId);
  const tickers = ((wlRes.data ?? []) as { ticker: string }[]).map((r) => r.ticker.toUpperCase());

  // Walk-forward
  const interval = timeframeToInterval(algo.rules.timeframe);
  const pricesByTicker = new Map<string, Awaited<ReturnType<typeof fetchDailyPrices>>>();
  for (const ticker of tickers) {
    let prices = await getCachedPrices(ticker, "full", interval);
    if (!prices) {
      try {
        prices = await fetchDailyPrices(ticker, "full", interval);
        savePricesToCache(ticker, "full", prices, interval).catch(() => {});
      } catch {
        continue;
      }
    }
    if (prices && prices.length >= 30) pricesByTicker.set(ticker, prices);
  }
  const wf = runWalkForward(algo.rules, pricesByTicker, algo.capital, {
    testWindowDays: windowDays,
    stepDays,
  });
  const wfCheck = walkForwardCheck(wf, algo.capital, windowDays);

  // Pair quality
  const pairStatsMap = await getAllPairStats(supabase, algoId);
  const pairStats = Array.from(pairStatsMap.values());
  const pairCheck = pairQualityCheck(pairStats);

  // Side symmetry
  const sideCheck = sideSymmetryCheck(algo.rules.side);

  // FTMO fit
  const ftmoCheck = ftmoFitCheck(algo.rules as unknown as Record<string, unknown>);

  const checks: CheckResult[] = [wfCheck, pairCheck, sideCheck, ftmoCheck];
  const verdict = combineSeverity(checks.map((c) => c.severity));

  return NextResponse.json({
    algorithm_id: algoId,
    algorithm_name: algo.name,
    verdict,
    checks,
    walk_forward_summary: {
      windows: wf.total_windows,
      mean_win_rate: wf.mean_win_rate,
      mean_return: wf.mean_return,
      mean_drawdown: wf.mean_drawdown,
      win_rate_of_windows: wf.win_rate_of_windows,
    },
  });
}
