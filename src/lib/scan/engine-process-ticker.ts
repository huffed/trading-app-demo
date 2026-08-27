/**
 * Per-ticker scan handler — extracted from `scan/engine.ts` on
 * 2026-06-22 (CB.H1 pass 17). Fetches fresh bars + daily series, walks
 * each open position through manageExistingPosition, then evaluates a
 * potential entry via evaluateEntry (always — capped is dry-run for
 * telemetry, not silent drop).
 */
import { type BarInterval } from "@/lib/market-data/interval";
import { getFreshPricesForScan } from "@/lib/market-data/prices";
import type { PriceBar } from "@/lib/market-data/types";
import type { AlgorithmRules } from "@/types/algorithm";
import type { PaperPosition } from "@/types/position";
import { manageExistingPosition } from "./engine-position-mgmt";
import { evaluateEntry } from "./entry";
import { logActivity } from "./helpers";
import type { BrokerExecutionContext } from "./live-execution";
import type { SupabaseClient } from "@supabase/supabase-js";

interface AlgorithmWithWatchlist {
  id: string;
  name: string;
  description: string;
  rules: AlgorithmRules;
  capital: number;
  status: string;
  algorithm_watchlist: { ticker: string; name: string; auto_paused?: boolean }[];
  live_trading_enabled?: boolean;
  broker_connection_id?: string | null;
}

interface ScanResultLike {
  tickers_scanned: number;
  positions_opened: number;
  positions_closed: number;
  positions_updated: number;
  opened_details: { ticker: string; reason: string; pnl: number; price: number }[];
  closed_details: { ticker: string; reason: string; pnl: number; price: number }[];
  errors: { ticker: string; error: string }[];
}

export async function processTicker(
  supabase: SupabaseClient,
  userId: string,
  algo: AlgorithmWithWatchlist,
  ticker: string,
  positions: PaperPosition[],
  result: ScanResultLike,
  liveQuotes: Map<string, number>,
  interval: BarInterval,
  brokerCtx: BrokerExecutionContext | null,
  dxyBars: PriceBar[] | null,
  intermarket: {
    silver?: PriceBar[];
    yield10y?: PriceBar[];
    vix?: PriceBar[];
  } | null,
  force: boolean
): Promise<void> {
  try {
    const prices = await getFreshPricesForScan(ticker, "full", interval);
    if (prices.length < 10) {
      result.errors.push({ ticker, error: "Not enough price data" });
      result.tickers_scanned++;
      return;
    }

    const dailyBars = await loadDailyBarsForScan(ticker, interval);
    const closes = prices.map((p) => p.close);
    const livePrice = liveQuotes.get(ticker.toUpperCase()) ?? null;

    await manageExistingForTicker({
      supabase,
      userId,
      algo,
      ticker,
      prices,
      closes,
      livePrice,
      brokerCtx,
      dailyBars,
      positions,
      result,
    });

    const cappedReason = computeCappedReason(positions, ticker, algo.rules.max_per_ticker, algo.rules.max_positions);

    const r = await evaluateEntry({
      supabase,
      userId,
      algo,
      ticker,
      bars: prices,
      closes,
      allOpenPositions: positions,
      livePrice,
      brokerCtx,
      dailyBars,
      dxyBars,
      intermarket,
      cappedReason,
      force,
    });
    result.positions_opened += r.opened;
    if (r.openEvent) {
      result.opened_details.push(r.openEvent);
      const placeholder: Partial<PaperPosition> = {
        ticker: r.openEvent.ticker,
        status: "open",
      };
      positions.push(placeholder as PaperPosition);
    }
    result.tickers_scanned++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    result.errors.push({ ticker, error: msg });
    await logActivity(supabase, userId, {
      algorithm_id: algo.id,
      event_type: "error",
      ticker,
      details: { error: msg },
    });
  }
}

/** Fetch the dedicated D1 series for higher-TF context (daily_bias /
 *  regime / ADX). E2.25.c-completion (2026-08-27): this loader previously
 *  read `getCachedPrices` under the 7-DAY daily TTL, so live daily_bias
 *  ran on a D1 series up to a week stale — the exact gap E2.25.c fixed in
 *  `getFreshPricesForScan` (26h refresh margin) but this call site never
 *  adopted. Observed live: the XAU D1 row sat 3 sessions stale (Aug 21 →
 *  Aug 27) while scans kept hitting the TTL-valid cache. Now routed
 *  through the liveCron fresh path; null on failure (downstream copes). */
async function loadDailyBarsForScan(
  ticker: string,
  interval: BarInterval
): Promise<PriceBar[] | null> {
  if (interval === "1day") return null;
  try {
    return await getFreshPricesForScan(ticker, "full", "1day");
  } catch {
    return null;
  }
}

interface ManageExistingArgs {
  supabase: SupabaseClient;
  userId: string;
  algo: AlgorithmWithWatchlist;
  ticker: string;
  prices: PriceBar[];
  closes: number[];
  livePrice: number | null;
  brokerCtx: BrokerExecutionContext | null;
  dailyBars: PriceBar[] | null;
  positions: PaperPosition[];
  result: ScanResultLike;
}

/** Walk every open position on this ticker through manageExistingPosition. */
async function manageExistingForTicker(a: ManageExistingArgs): Promise<void> {
  const { supabase, userId, algo, ticker, prices, closes, livePrice, brokerCtx, dailyBars, positions, result } = a;
  const existingForTicker = positions.filter((p) => p.ticker === ticker);
  for (const existing of existingForTicker) {
    const r = await manageExistingPosition(
      supabase,
      userId,
      algo,
      ticker,
      existing,
      prices,
      closes,
      livePrice,
      brokerCtx,
      dailyBars
    );
    result.positions_closed += r.closed;
    result.positions_updated += r.updated;
    if (r.closeEvent) {
      result.closed_details.push(r.closeEvent);
    }
  }
}

/** Per-ticker cap reasoning — returns the human-readable reason string when
 *  capped, or null when there's room. */
function computeCappedReason(
  positions: PaperPosition[],
  ticker: string,
  maxPerTicker: number | undefined,
  maxPositions: number
): string | null {
  const stillOpen = positions.filter((p) => p.status === "open");
  const openOnTicker = stillOpen.filter((p) => p.ticker === ticker).length;
  const cap = maxPerTicker ?? 1;
  if (stillOpen.length >= maxPositions) {
    return `Capped: ${stillOpen.length}/${maxPositions} positions open`;
  }
  if (openOnTicker >= cap) {
    return `Capped: ${openOnTicker}/${cap} positions open on ${ticker}`;
  }
  return null;
}
