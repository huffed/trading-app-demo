"use server";

import { fetchEconomicCalendar } from "@/lib/market-data/economic-calendar";
import { timeframeToInterval } from "@/lib/market-data/interval";
import { runPortfolioBacktest } from "@/lib/market-data/portfolio-backtest";
import { getCachedPrices, savePricesToCache } from "@/lib/market-data/price-cache";
import { fetchDailyPrices } from "@/lib/market-data/prices";
import type { BacktestTrade, PriceBar } from "@/lib/market-data/types";
import { getAuthedUser } from "@/lib/supabase/get-authed-user";
import { type ActionResult } from "@/lib/types/action-result";
import type { AlgorithmRules } from "@/types/algorithm";
import {
  LOOKBACK_GRID,
  RR_GRID,
  type GeometryCell,
  type GeometrySweep,
} from "./types";

export async function getGeometrySweepAction(
  algorithmId: string
): Promise<ActionResult<GeometrySweep | null>> {
  if (!algorithmId) return { success: false, error: "missing algorithm id" };
  try {
    const { supabase, user } = await getAuthedUser();
    const { data, error } = await supabase
      .from("algorithm_geometry_sweeps")
      .select("cells, ran_at")
      .eq("user_id", user.id)
      .eq("algorithm_id", algorithmId)
      .maybeSingle();
    if (error) return { success: false, error: error.message };
    if (!data) return { success: true, data: null };
    const cells = data.cells as unknown as GeometrySweep;
    return { success: true, data: { ...cells, ran_at: data.ran_at } };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Load failed" };
  }
}

function cloneRulesWithGeometry(
  rules: AlgorithmRules,
  rr: number,
  lookback: number
): AlgorithmRules {
  const next = JSON.parse(JSON.stringify(rules)) as AlgorithmRules;
  if (!next.take_profit) next.take_profit = { type: "rr_multiple", value: rr };
  else (next.take_profit as { type: string; value: number }).value = rr;
  if (!next.stop_loss) next.stop_loss = { type: "swing_anchor", value: 0.1, lookback };
  else (next.stop_loss as { type: string; lookback?: number }).lookback = lookback;
  return next;
}

function buildCell(
  rr: number,
  lookback: number,
  trades: BacktestTrade[],
  capital: number
): GeometryCell {
  if (trades.length === 0) {
    return {
      rr,
      lookback,
      total_return: 0,
      max_drawdown: 0,
      total_trades: 0,
      win_rate: 0,
      avg_pnl: 0,
      calmar: null,
      dd_breached: false,
      per_year: {},
    };
  }
  const sorted = [...trades].sort(
    (a, b) => new Date(a.exit_date).getTime() - new Date(b.exit_date).getTime()
  );
  let cum = 0;
  let peak = 0;
  let maxDdPct = 0;
  let wins = 0;
  const perYear: Record<string, { trades: number; pnl: number; win_pct: number }> = {};
  const yearWins: Record<string, number> = {};
  for (const t of sorted) {
    const pnl = t.pnl;
    cum += pnl;
    if (pnl > 0) wins++;
    if (cum > peak) peak = cum;
    const ddPct = ((peak - cum) / capital) * 100;
    if (ddPct > maxDdPct) maxDdPct = ddPct;
    const y = t.exit_date.slice(0, 4);
    if (!perYear[y]) {
      perYear[y] = { trades: 0, pnl: 0, win_pct: 0 };
      yearWins[y] = 0;
    }
    perYear[y].trades++;
    perYear[y].pnl += pnl;
    if (pnl > 0) yearWins[y]++;
  }
  for (const y of Object.keys(perYear)) {
    perYear[y].pnl = Math.round(perYear[y].pnl * 100) / 100;
    perYear[y].win_pct = Math.round((yearWins[y] / perYear[y].trades) * 1000) / 10;
  }
  const totalReturn = Math.round(cum * 100) / 100;
  const maxDd = Math.round(maxDdPct * 100) / 100;
  return {
    rr,
    lookback,
    total_return: totalReturn,
    max_drawdown: maxDd,
    total_trades: sorted.length,
    win_rate: Math.round((wins / sorted.length) * 1000) / 10,
    avg_pnl: Math.round((cum / sorted.length) * 100) / 100,
    // Calmar = return / DD%. Higher is better. Caller uses this to
    // surface the best risk-adjusted cell. Null when DD is 0 (avoid
    // divide-by-zero) — caller treats null as 'no DD recorded'.
    calmar: maxDd > 0 ? Math.round((totalReturn / maxDd) * 100) / 100 : null,
    // dd_breached: would need engine state to know exactly. Cell consumer
    // uses max_drawdown vs algo.prop_firm.max_drawdown to decide.
    dd_breached: false,
    per_year: perYear,
  };
}

async function loadPricesForTickers(
  tickers: string[],
  interval: ReturnType<typeof timeframeToInterval>
): Promise<Map<string, PriceBar[]>> {
  const out = new Map<string, PriceBar[]>();
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
    if (prices && prices.length >= 30) out.set(ticker, prices);
  }
  return out;
}

export async function runGeometrySweepAction(
  algorithmId: string
): Promise<ActionResult<GeometrySweep>> {
  if (!algorithmId) return { success: false, error: "missing algorithm id" };
  try {
    const { supabase, user } = await getAuthedUser();
    const algoRes = await supabase
      .from("algorithms")
      .select("rules, capital")
      .eq("id", algorithmId)
      .eq("user_id", user.id)
      .single();
    if (algoRes.error) return { success: false, error: algoRes.error.message };
    const rules = (algoRes.data as unknown as { rules: AlgorithmRules }).rules;
    const capital = (algoRes.data as unknown as { capital: number }).capital;
    if (rules.llm_trader?.enabled) {
      return {
        success: false,
        error: "Geometry sweep doesn't apply to LLM-trader algorithms.",
      };
    }
    const slType = (rules.stop_loss as { type?: string } | undefined)?.type;
    const tpType = (rules.take_profit as { type?: string } | undefined)?.type;
    if (slType !== "swing_anchor" || tpType !== "rr_multiple") {
      return {
        success: false,
        error: `Sweep requires stop_loss.type='swing_anchor' + take_profit.type='rr_multiple'. Algo has ${slType ?? "none"}/${tpType ?? "none"}.`,
      };
    }
    const wlRes = await supabase
      .from("algorithm_watchlist")
      .select("ticker")
      .eq("algorithm_id", algorithmId);
    const tickers = ((wlRes.data ?? []) as { ticker: string }[]).map((w) => w.ticker.toUpperCase());
    if (tickers.length === 0) return { success: false, error: "Algorithm watchlist is empty" };

    const interval = timeframeToInterval(rules.timeframe);
    const pricesByTicker = await loadPricesForTickers(tickers, interval);
    if (pricesByTicker.size === 0) return { success: false, error: "No price history available" };

    const events = rules.news_veto?.enabled
      ? await fetchEconomicCalendar(
          new Date([...pricesByTicker.values()][0][0].date),
          new Date([...pricesByTicker.values()][0].at(-1)!.date)
        )
      : [];

    const cells: GeometryCell[] = [];
    for (const rr of RR_GRID) {
      for (const lookback of LOOKBACK_GRID) {
        const variant = cloneRulesWithGeometry(rules, rr, lookback);
        const result = runPortfolioBacktest(variant, pricesByTicker, capital, events);
        cells.push(buildCell(rr, lookback, result.trades, capital));
      }
    }

    const ranAt = new Date().toISOString();
    const sweep: GeometrySweep = {
      cells,
      grid: { rr: [...RR_GRID], lookback: [...LOOKBACK_GRID] },
      ran_at: ranAt,
    };
    await supabase
      .from("algorithm_geometry_sweeps")
      .delete()
      .eq("user_id", user.id)
      .eq("algorithm_id", algorithmId);
    const ins = await supabase
      .from("algorithm_geometry_sweeps")
      .insert({ user_id: user.id, algorithm_id: algorithmId, ran_at: ranAt, cells: sweep as never });
    if (ins.error) return { success: false, error: ins.error.message };
    return { success: true, data: sweep };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Sweep failed" };
  }
}

export async function applyGeometryConfigAction(
  algorithmId: string,
  rr: number,
  lookback: number
): Promise<ActionResult<{ rr: number; lookback: number }>> {
  if (!algorithmId) return { success: false, error: "missing algorithm id" };
  try {
    const { supabase, user } = await getAuthedUser();
    const algoRes = await supabase
      .from("algorithms")
      .select("rules, live_trading_enabled")
      .eq("id", algorithmId)
      .eq("user_id", user.id)
      .single();
    if (algoRes.error) return { success: false, error: algoRes.error.message };
    const row = algoRes.data as unknown as {
      rules: AlgorithmRules;
      live_trading_enabled: boolean | null;
    };
    if (row.live_trading_enabled) {
      return {
        success: false,
        error:
          "Refusing to update geometry on a live-trading algorithm. Disable live trading first; mirrors the scripts/update-library-geometry-*.ts safety rule.",
      };
    }
    const next = cloneRulesWithGeometry(row.rules, rr, lookback);
    const up = await supabase
      .from("algorithms")
      .update({ rules: next as never })
      .eq("id", algorithmId)
      .eq("user_id", user.id);
    if (up.error) return { success: false, error: up.error.message };
    return { success: true, data: { rr, lookback } };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Apply failed" };
  }
}
