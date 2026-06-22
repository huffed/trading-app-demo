"use server";

import { fetchEconomicCalendar } from "@/lib/market-data/economic-calendar";
import { timeframeToInterval } from "@/lib/market-data/interval";
import { runPortfolioBacktest } from "@/lib/market-data/portfolio-backtest";
import { getCachedPrices, savePricesToCache } from "@/lib/market-data/price-cache";
import { fetchDailyPrices } from "@/lib/market-data/prices";
import type { BacktestTrade, PriceBar } from "@/lib/market-data/types";
import { getAuthedUser } from "@/lib/supabase/get-authed-user";
import { fromJson, rulesFromRow } from "@/lib/supabase/row-mappers";
import { type ActionResult } from "@/types/action-result";
import { cloneWithAxes, snapshotFixedAxes } from "./axis-mapper";
import {
  AXES,
  type AxisKey,
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
    const payload = fromJson<Omit<GeometrySweep, "ran_at">>(data.cells);
    return { success: true, data: { ...payload, ran_at: data.ran_at } };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Load failed" };
  }
}

function buildCell(
  xVal: number | boolean,
  yVal: number | boolean,
  trades: BacktestTrade[],
  capital: number
): GeometryCell {
  if (trades.length === 0) {
    return {
      x: xVal,
      y: yVal,
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
  for (const yKey of Object.keys(perYear)) {
    perYear[yKey].pnl = Math.round(perYear[yKey].pnl * 100) / 100;
    perYear[yKey].win_pct = Math.round((yearWins[yKey] / perYear[yKey].trades) * 1000) / 10;
  }
  const totalReturn = Math.round(cum * 100) / 100;
  const maxDd = Math.round(maxDdPct * 100) / 100;
  return {
    x: xVal,
    y: yVal,
    total_return: totalReturn,
    max_drawdown: maxDd,
    total_trades: sorted.length,
    win_rate: Math.round((wins / sorted.length) * 1000) / 10,
    avg_pnl: Math.round((cum / sorted.length) * 100) / 100,
    calmar: maxDd > 0 ? Math.round((totalReturn / maxDd) * 100) / 100 : null,
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
  algorithmId: string,
  xAxis: AxisKey,
  yAxis: AxisKey
): Promise<ActionResult<GeometrySweep>> {
  if (!algorithmId) return { success: false, error: "missing algorithm id" };
  if (xAxis === yAxis) return { success: false, error: "X and Y axes must differ" };
  try {
    const { supabase, user } = await getAuthedUser();
    const algoRes = await supabase
      .from("algorithms")
      .select("rules, capital")
      .eq("id", algorithmId)
      .eq("user_id", user.id)
      .single();
    if (algoRes.error) return { success: false, error: algoRes.error.message };
    // CB.H3 (2026-06-20): canonical Json→AlgorithmRules bridge.
    const rules = rulesFromRow(algoRes.data.rules);
    const capital = algoRes.data.capital;
    if (rules.llm_trader?.enabled) {
      return { success: false, error: "Geometry sweep doesn't apply to LLM-trader algorithms." };
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

    // CB.L2 (2026-06-20): replaces `bars.at(-1)!.date` non-null assertion +
    // the doubly-spread `[...values][0][0]`. Caller already checked
    // `pricesByTicker.size > 0`; pick the first non-empty bar series.
    // News-veto events span the price-data window — first bar = window
    // open, last bar = window close. If the first series happened to be
    // empty (shouldn't, but the type allows it), skip news-veto rather
    // than throw.
    const firstBars = pricesByTicker.values().next().value ?? [];
    const events =
      rules.news_veto?.enabled && firstBars.length > 0
        ? await fetchEconomicCalendar(
            new Date(firstBars[0].date),
            new Date(firstBars[firstBars.length - 1].date)
          )
        : [];

    const xDef = AXES[xAxis];
    const yDef = AXES[yAxis];
    const cells: GeometryCell[] = [];
    // B.1.24 (Stage 3, 2026-06-19 EVE): geometry-sweep caller — gates
    // intentionally OFF. Sensitivity-analysis sweeps need to attribute
    // verdict shifts to rule changes ALONE; gates would conflate axis
    // effects with portfolio-state coupling. See caller-policy doc in
    // `portfolio-backtest.ts` + CLAUDE.md Phase B.1.9.
    for (const yVal of yDef.values) {
      for (const xVal of xDef.values) {
        const variant = cloneWithAxes(rules, xAxis, yAxis, xVal, yVal);
        const result = runPortfolioBacktest(variant, pricesByTicker, capital, { events });
        cells.push(buildCell(xVal, yVal, result.trades, capital));
      }
    }

    const ranAt = new Date().toISOString();
    const sweep: GeometrySweep = {
      cells,
      x_axis: xAxis,
      y_axis: yAxis,
      x_values: [...xDef.values],
      y_values: [...yDef.values],
      fixed: snapshotFixedAxes(rules, xAxis, yAxis),
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

/** Apply a cell's full config to the algo's rules. Both axes get
 *  written; the operator can re-sweep to explore other dimensions
 *  after applying. REFUSES live_trading_enabled=true. */
export async function applyCellConfigAction(
  algorithmId: string,
  xAxis: AxisKey,
  yAxis: AxisKey,
  xVal: number | boolean,
  yVal: number | boolean
): Promise<ActionResult<{ x: number | boolean; y: number | boolean }>> {
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
    // CB.H3 (2026-06-20): canonical bridge for rules; live_trading_enabled
    // is already a typed DB column.
    const rules = rulesFromRow(algoRes.data.rules);
    if (algoRes.data.live_trading_enabled) {
      return {
        success: false,
        error:
          "Refusing to update geometry on a live-trading algorithm. Disable live trading first.",
      };
    }
    const next = cloneWithAxes(rules, xAxis, yAxis, xVal, yVal);
    const up = await supabase
      .from("algorithms")
      .update({ rules: next as never })
      .eq("id", algorithmId)
      .eq("user_id", user.id);
    if (up.error) return { success: false, error: up.error.message };
    return { success: true, data: { x: xVal, y: yVal } };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Apply failed" };
  }
}
