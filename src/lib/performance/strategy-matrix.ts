/**
 * Strategy performance matrix — one row per deployed algorithm with
 * its strategy, ticker, timeframe, and backtest stats. Powers the
 * /performance grid view.
 *
 * Backtest stats are read from algorithms.backtest_results which is
 * populated by deploy scripts + the 2026-06-17 backfill
 * (scripts/backfill-backtest-results.ts). When backtest_results is
 * null the row still appears but with null metrics — operator can
 * sort dead rows to the bottom or filter them out.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type MatrixLiveStatus = "LIVE" | "paper" | "paused" | "archived" | "draft";

export interface StrategyMatrixRow {
  algorithm_id: string;
  algorithm_name: string;
  strategy_id: string | null;
  strategy_name: string | null;
  ticker: string | null;
  timeframe: string | null;
  asset_class: string | null;
  capital: number;
  status: MatrixLiveStatus;
  /** Backtest stats — null when backtest_results is missing on the algo row. */
  total_return: number | null;
  total_trades: number | null;
  max_drawdown: number | null;
  /** Derived: expected R per trade = (total_return / total_trades) / 1R$.
   *  1R$ = capital × risk_per_trade%. Null when ingredients missing. */
  expected_r_per_trade: number | null;
  /** Annualized expected $ based on (total_return / 6yr) × algo.capital ratio.
   *  Walk-forwards run 6yr horizons; this is a rough yearly. Null when
   *  inputs missing. */
  expected_annual_dollars: number | null;
}

interface AlgoRow {
  id: string;
  name: string;
  strategy_id: string | null;
  capital: number;
  status: string;
  live_trading_enabled: boolean | null;
  rules: Record<string, unknown> | null;
  backtest_results: Record<string, unknown> | null;
}

interface WatchlistRow {
  algorithm_id: string;
  ticker: string;
}

interface StrategyNameRow {
  id: string;
  name: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supa = SupabaseClient<any, any, any>;

const WALK_FORWARD_YEARS = 6; // walk-forward horizon used by deploy scripts

function liveStatusOf(status: string, live: boolean | null): MatrixLiveStatus {
  if (status === "paused") return "paused";
  if (status === "archived") return "archived";
  if (status === "draft") return "draft";
  if (live) return "LIVE";
  return "paper";
}

function riskPercent(rules: Record<string, unknown> | null): number | null {
  if (!rules) return null;
  const sizing = rules.position_sizing as Record<string, unknown> | undefined;
  if (!sizing) return null;
  const type = sizing.type as string;
  const value = typeof sizing.value === "number" ? sizing.value : null;
  if (value == null) return null;
  if (type === "risk_per_trade" || type === "conviction_scaled") return value;
  return null;
}

function timeframeOf(rules: Record<string, unknown> | null): string | null {
  if (!rules) return null;
  const tf = rules.timeframe;
  return typeof tf === "string" ? tf : null;
}

function assetClassOf(rules: Record<string, unknown> | null): string | null {
  if (!rules) return null;
  const ac = rules.asset_class;
  return typeof ac === "string" ? ac : null;
}

function computeMetrics(algo: AlgoRow): {
  total_return: number | null;
  total_trades: number | null;
  max_drawdown: number | null;
  expected_r_per_trade: number | null;
  expected_annual_dollars: number | null;
} {
  const br = algo.backtest_results;
  if (!br) {
    return {
      total_return: null,
      total_trades: null,
      max_drawdown: null,
      expected_r_per_trade: null,
      expected_annual_dollars: null,
    };
  }
  const total_return = typeof br.total_return === "number" ? br.total_return : null;
  const total_trades = typeof br.total_trades === "number" ? br.total_trades : null;
  const max_drawdown = typeof br.max_drawdown === "number" ? br.max_drawdown : null;
  const riskPct = riskPercent(algo.rules);
  const oneR = riskPct != null && riskPct > 0 ? algo.capital * (riskPct / 100) : null;
  const expected_r =
    total_return != null && total_trades != null && total_trades > 0 && oneR != null && oneR > 0
      ? total_return / total_trades / oneR
      : null;
  const annual =
    total_return != null
      ? Math.round((total_return / WALK_FORWARD_YEARS) * 100) / 100
      : null;
  return {
    total_return,
    total_trades,
    max_drawdown,
    expected_r_per_trade: expected_r,
    expected_annual_dollars: annual,
  };
}

export async function buildStrategyMatrix(supabase: Supa): Promise<StrategyMatrixRow[]> {
  const { data: algosRaw, error: algosErr } = await supabase
    .from("algorithms")
    .select(
      "id, name, strategy_id, capital, status, live_trading_enabled, rules, backtest_results"
    )
    .neq("status", "archived");
  if (algosErr) throw new Error(`strategy matrix algos query failed: ${algosErr.message}`);
  const algos = (algosRaw ?? []) as AlgoRow[];
  if (algos.length === 0) return [];

  const algoIds = algos.map((a) => a.id);
  const [{ data: watchlistRaw, error: wlErr }, { data: strategiesRaw, error: stErr }] = await Promise.all([
    supabase.from("algorithm_watchlist").select("algorithm_id, ticker").in("algorithm_id", algoIds),
    supabase
      .from("strategies")
      .select("id, name")
      .in(
        "id",
        [...new Set(algos.map((a) => a.strategy_id).filter(Boolean) as string[])]
      ),
  ]);
  if (wlErr) throw new Error(`strategy matrix watchlist query failed: ${wlErr.message}`);
  if (stErr) throw new Error(`strategy matrix strategies query failed: ${stErr.message}`);

  // Each algo deploys with ONE ticker in our workflow; if more than one
  // is in the watchlist we surface the first alphabetically (deterministic).
  const tickerByAlgo = new Map<string, string>();
  for (const w of (watchlistRaw ?? []) as WatchlistRow[]) {
    const existing = tickerByAlgo.get(w.algorithm_id);
    if (!existing || w.ticker.localeCompare(existing) < 0) {
      tickerByAlgo.set(w.algorithm_id, w.ticker);
    }
  }
  const strategyNameById = new Map<string, string>();
  for (const s of (strategiesRaw ?? []) as StrategyNameRow[]) {
    strategyNameById.set(s.id, s.name);
  }

  return algos.map((a) => {
    const metrics = computeMetrics(a);
    return {
      algorithm_id: a.id,
      algorithm_name: a.name,
      strategy_id: a.strategy_id,
      strategy_name: a.strategy_id ? (strategyNameById.get(a.strategy_id) ?? null) : null,
      ticker: tickerByAlgo.get(a.id) ?? null,
      timeframe: timeframeOf(a.rules),
      asset_class: assetClassOf(a.rules),
      capital: a.capital,
      status: liveStatusOf(a.status, a.live_trading_enabled),
      ...metrics,
    };
  });
}
