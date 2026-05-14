/**
 * Paper trading scan engine — evaluates active algorithms against their
 * watchlist tickers and opens/closes virtual positions.
 *
 * Uses the backtest engine's condition evaluation to guarantee consistency
 * between backtested and live-scanned signals.
 */
import {
  checkStagnantExit,
  resolveEntryBarIndex,
  type StagnantExitResult,
} from "@/lib/algorithm/stagnant-exit";
import { pnlInUsd, priceDeltaForRule } from "@/lib/constants/markets";
import { checkConditions, normalize, type Cache } from "@/lib/market-data/backtest-engine";
import { timeframeToInterval, type BarInterval } from "@/lib/market-data/interval";
import { getCachedPrices, savePricesToCache } from "@/lib/market-data/price-cache";
import { fetchDailyPrices, getFreshPricesForScan } from "@/lib/market-data/prices";
import { resampleToDaily } from "@/lib/market-data/resample";
import { fetchBatchQuotes } from "@/lib/market-data/twelve-data";
import type { PriceBar } from "@/lib/market-data/types";
import {
  isPatternCondition,
  isTechnicalCondition,
  type AlgorithmRules,
  type PatternCondition,
  type TechnicalCondition,
} from "@/types/algorithm";
import type { PaperPosition, PositionEvent } from "@/types/position";
import { maybeHaltOnDailyLoss, maybeWarnOnDailyLoss } from "./daily-halt";
import { DEFAULT_DRIFT_CONFIG, detectDrift, executeDriftHalt } from "./drift-detector";
import { evaluateEntry } from "./entry";
import { logActivity } from "./helpers";
import {
  executeLiveExit,
  resolveBrokerContext,
  type BrokerExecutionContext,
} from "./live-execution";
import { evaluateAndPrune } from "./pair-quality";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---- Types ----

export interface ScanResult {
  algorithm_id: string;
  algorithm_name: string;
  tickers_scanned: number;
  positions_opened: number;
  positions_closed: number;
  positions_updated: number;
  opened_details: PositionEvent[];
  closed_details: PositionEvent[];
  errors: { ticker: string; error: string }[];
}

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

// ---- Position management ----

/** Resolve the stagnant-exit gate for a single open position. Returns
 *  null when the gate is disabled. Telemetry-rich `StagnantExitResult`
 *  otherwise — including non-firing decisions — so the caller can log
 *  MFE / current_r / bars_open even when the trade exits for some
 *  other reason. The intent of running the gate FIRST is to PREEMPT
 *  the SL hit on losers that aren't going to recover; recording an
 *  intra-bar SL fill as the exit_reason would obscure that contribution. */
function evaluateStagnantExit(
  position: PaperPosition,
  rules: AlgorithmRules,
  ticker: string,
  bars: PriceBar[]
): StagnantExitResult | null {
  if (!rules.stagnant_exit?.enabled) return null;
  const entryBarIndex = resolveEntryBarIndex(bars, position.opened_at);
  // Derive stopDistance from the persisted SL price when available — it
  // captures the entry-time decision (including structural / rr_multiple
  // distances that can't be recomputed from the rule alone). Falls back
  // to priceDeltaForRule for legacy positions opened before stop_loss_price
  // was persisted, AND for the percentage / fixed / pips rules where the
  // recomputation is deterministic.
  const stopDistance =
    position.stop_loss_price != null
      ? Math.abs(position.entry_price - position.stop_loss_price)
      : priceDeltaForRule(rules.stop_loss, position.entry_price, ticker);
  return checkStagnantExit({
    bars,
    entryBarIndex,
    currentBarIndex: bars.length - 1,
    entryPrice: position.entry_price,
    side: position.side,
    stopDistance,
    config: rules.stagnant_exit,
  });
}


/** Slim algorithm shape needed by manageExistingPosition — id/name for
 *  logging and rules for the exit trigger check. The full
 *  AlgorithmWithWatchlist is a superset, so existing callers still
 *  satisfy this signature without changes. The manage-positions cron
 *  uses this directly (no watchlist required). */
export type AlgoForPositionMgmt = Pick<AlgorithmWithWatchlist, "id" | "name" | "rules">;

export async function manageExistingPosition(
  supabase: SupabaseClient,
  userId: string,
  algo: AlgoForPositionMgmt,
  ticker: string,
  position: PaperPosition,
  bars: PriceBar[],
  closes: number[],
  livePrice: number | null,
  brokerCtx: BrokerExecutionContext | null,
  dailyBars: PriceBar[] | null
): Promise<{ closed: number; updated: number; closeEvent?: PositionEvent }> {
  const currentPrice = livePrice ?? closes[closes.length - 1];
  const unrealizedPnl = pnlInUsd(
    ticker,
    position.side,
    position.entry_price,
    currentPrice,
    position.quantity
  );

  const stagnantResult = evaluateStagnantExit(position, algo.rules, ticker, bars);
  const exitCheck = stagnantResult?.exit
    ? "stagnant_no_excursion"
    : checkExitTrigger(position, currentPrice, algo.rules, bars, closes, dailyBars);

  if (exitCheck) {
    return closePositionForExit({
      supabase,
      userId,
      algo,
      ticker,
      position,
      exitCheck,
      currentPrice,
      realizedPnl: unrealizedPnl,
      stagnantResult,
      brokerCtx,
    });
  }

  await supabase
    .from("paper_positions")
    .update({ current_price: currentPrice, unrealized_pnl: unrealizedPnl })
    .eq("id", position.id);
  return { closed: 0, updated: 1 };
}

interface CloseExitArgs {
  supabase: SupabaseClient;
  userId: string;
  algo: AlgoForPositionMgmt;
  ticker: string;
  position: PaperPosition;
  exitCheck: string;
  currentPrice: number;
  realizedPnl: number;
  stagnantResult: StagnantExitResult | null;
  brokerCtx: BrokerExecutionContext | null;
}

/** Close path — DB update, broker mirror, activity log. Extracted so
 *  manageExistingPosition stays tight and so the close branch can be
 *  unit-tested independently of the price-management flow. */
async function closePositionForExit(
  a: CloseExitArgs
): Promise<{ closed: number; updated: number; closeEvent: PositionEvent }> {
  await a.supabase
    .from("paper_positions")
    .update({
      current_price: a.currentPrice,
      exit_price: a.currentPrice,
      unrealized_pnl: 0,
      realized_pnl: a.realizedPnl,
      exit_reason: a.exitCheck,
      status: "closed",
      closed_at: new Date().toISOString(),
    })
    .eq("id", a.position.id);

  if (a.brokerCtx) {
    await executeLiveExit({
      supabase: a.supabase,
      userId: a.userId,
      algorithmId: a.algo.id,
      paperPositionId: a.position.id,
      ticker: a.ticker,
      brokerPositionId: a.position.broker_position_id ?? null,
      closePrice: a.currentPrice,
      ctx: a.brokerCtx,
    });
  }

  let eventType = "position_closed";
  if (a.exitCheck === "stop_loss") eventType = "stop_loss_hit";
  else if (a.exitCheck === "take_profit") eventType = "take_profit_hit";

  await logActivity(a.supabase, a.userId, {
    algorithm_id: a.algo.id,
    position_id: a.position.id,
    event_type: eventType,
    ticker: a.ticker,
    details: {
      exit_price: a.currentPrice,
      realized_pnl: a.realizedPnl,
      exit_reason: a.exitCheck,
      // Stagnant gate telemetry — present even on non-stagnant exits so
      // analytics can mine the MFE distribution at exit time.
      stagnant_bars_open: a.stagnantResult?.bars_open,
      stagnant_max_bars: a.stagnantResult?.max_bars_threshold,
      stagnant_mfe_r: a.stagnantResult?.mfe_r,
      stagnant_current_r: a.stagnantResult?.current_r,
    },
  });

  return {
    closed: 1,
    updated: 0,
    closeEvent: { ticker: a.ticker, reason: a.exitCheck, pnl: a.realizedPnl, price: a.currentPrice },
  };
}

export function checkExitTrigger(
  position: PaperPosition,
  currentPrice: number,
  rules: AlgorithmRules,
  bars: PriceBar[],
  closes: number[],
  dailyBars: PriceBar[] | null
): string | null {
  const isLong = position.side === "long";

  // Stop loss
  if (position.stop_loss_price != null) {
    const slHit = isLong
      ? currentPrice <= position.stop_loss_price
      : currentPrice >= position.stop_loss_price;
    if (slHit) {
      return "stop_loss";
    }
  }

  // Take profit
  if (position.take_profit_price != null) {
    const tpHit = isLong
      ? currentPrice >= position.take_profit_price
      : currentPrice <= position.take_profit_price;
    if (tpHit) {
      return "take_profit";
    }
  }

  // Technical + pattern exit conditions (sentiment exits are evaluated
  // separately via the live signal pipeline; not handled here).
  const normalizedExit = normalize(rules.exit_conditions);
  const evaluableExit = normalizedExit.filter(
    (c) => isTechnicalCondition(c) || isPatternCondition(c)
  ) as Array<TechnicalCondition | PatternCondition>;
  if (evaluableExit.length > 0) {
    const cache: Cache = new Map();
    if (
      checkConditions(
        evaluableExit,
        {
          cache,
          closes,
          bars,
          i: closes.length - 1,
          higherTfBars: dailyBars ?? resampleToDaily(bars),
        },
        rules.exit_logic ?? rules.entry_logic
      )
    ) {
      return "exit_signal";
    }
  }

  return null;
}

// ---- Per-ticker processing ----

async function processTicker(
  supabase: SupabaseClient,
  userId: string,
  algo: AlgorithmWithWatchlist,
  ticker: string,
  positions: PaperPosition[],
  result: ScanResult,
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
) {
  try {
    // Primary-TF bars MUST reflect the most-recently-closed bar. Both
    // caches in this stack have 1h TTLs, so without an explicit
    // freshness check the LLM keeps seeing the same too-old bars across
    // back-to-back scans (and the bar-staleness gate keeps refusing).
    // See getFreshPricesForScan for the threshold + fallback semantics.
    const prices = await getFreshPricesForScan(ticker, "full", interval);
    if (prices.length < 10) {
      result.errors.push({ ticker, error: "Not enough price data" });
      result.tickers_scanned++;
      return;
    }

    // Fetch a separate compact daily series for higher-timeframe context
    // (daily_bias, multi-TF conditions). Compact 1h ≈ 100 bars ≈ 4 days,
    // which resamples to ~4 D1 bars — far short of the 20 detectDailyBias
    // needs. A dedicated D1 series gives us 100 daily bars, plenty.
    let dailyBars: PriceBar[] | null = null;
    if (interval !== "1day") {
      dailyBars = await getCachedPrices(ticker, "full", "1day");
      if (!dailyBars) {
        try {
          dailyBars = await fetchDailyPrices(ticker, "full", "1day");
          savePricesToCache(ticker, "full", dailyBars, "1day").catch(() => {});
        } catch {
          dailyBars = null;
        }
      }
    }

    const closes = prices.map((p) => p.close);
    const livePrice = liveQuotes.get(ticker.toUpperCase()) ?? null;

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

    const stillOpen = positions.filter((p) => p.status === "open");
    const openOnTicker = stillOpen.filter((p) => p.ticker === ticker).length;
    const maxPerTicker = algo.rules.max_per_ticker ?? 1;
    const totalCapped = stillOpen.length >= algo.rules.max_positions;
    const tickerCapped = openOnTicker >= maxPerTicker;
    // Run evaluateEntry even when capped — passing cappedReason makes it
    // dry-run (full gate ladder runs for telemetry, near-miss logged at
    // the would-have-opened step instead of placing an order). Without
    // this the cap silently drops potential entries and the considered
    // feed shows nothing during slot-full windows.
    let cappedReason: string | null = null;
    if (totalCapped) {
      cappedReason = `Capped: ${stillOpen.length}/${algo.rules.max_positions} positions open`;
    } else if (tickerCapped) {
      cappedReason = `Capped: ${openOnTicker}/${maxPerTicker} positions open on ${ticker}`;
    }

    const r = await evaluateEntry(
      supabase,
      userId,
      algo,
      ticker,
      prices,
      closes,
      positions,
      livePrice,
      brokerCtx,
      dailyBars,
      dxyBars,
      intermarket,
      cappedReason,
      force
    );
    result.positions_opened += r.opened;
    if (r.openEvent) {
      result.opened_details.push(r.openEvent);
      // Keep the in-memory positions array in sync so subsequent tickers
      // in the same scan see the updated count and respect max_positions.
      // We only need fields read by the cap checks (ticker + status); the
      // full row is reloaded on the next scan.
      positions.push({
        ticker: r.openEvent.ticker,
        status: "open",
      } as PaperPosition);
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

// ---- Core scan ----

/**
 * Scan a single algorithm against all its watchlist tickers.
 */
export async function scanAlgorithm(
  supabase: SupabaseClient,
  userId: string,
  algo: AlgorithmWithWatchlist,
  options: { force?: boolean } = {}
): Promise<ScanResult> {
  const force = options.force ?? false;
  const result: ScanResult = {
    algorithm_id: algo.id,
    algorithm_name: algo.name,
    tickers_scanned: 0,
    positions_opened: 0,
    positions_closed: 0,
    positions_updated: 0,
    opened_details: [],
    closed_details: [],
    errors: [],
  };

  // Skip auto-paused tickers — the pair-quality evaluator marks pairs
  // as auto_paused=true when their realised WR drops below the prune
  // threshold over a meaningful sample. They stay paused until the user
  // manually re-enables them in the watchlist UI.
  const activeWatchlist = algo.algorithm_watchlist.filter((w) => !w.auto_paused);
  const tickers = activeWatchlist.map((w) => w.ticker);
  if (tickers.length === 0) {
    return result;
  }

  await logActivity(supabase, userId, {
    algorithm_id: algo.id,
    event_type: "scan_started",
    details: { tickers_count: tickers.length },
  });

  if (await maybeHaltOnDailyLoss(supabase, userId, algo)) {
    return result;
  }
  // Soft warning at 40% of way to DLL — gives operator a heads-up
  // window before automated halt fires. Idempotent per UTC day.
  await maybeWarnOnDailyLoss(supabase, userId, algo);

  const { data: openPositions } = await supabase
    .from("paper_positions")
    .select("*")
    .eq("algorithm_id", algo.id)
    .eq("user_id", userId)
    .eq("status", "open");

  const positions = (openPositions ?? []) as PaperPosition[];

  // Fetch real-time prices in one batch call for accurate entry/exit pricing
  let liveQuotes = new Map<string, number>();
  try {
    liveQuotes = await fetchBatchQuotes(tickers);
  } catch {
    // Fall back to daily closes if real-time quotes unavailable
  }

  const interval = timeframeToInterval(algo.rules.timeframe);
  const brokerCtx = await resolveBrokerContext(
    supabase,
    userId,
    algo.broker_connection_id ?? null,
    algo.live_trading_enabled ?? false
  );

  // Fetch EUR/USD 1h bars ONCE per scan when either the DXY filter OR
  // the LLM-trader is on. Shared across all tickers in the run; cached
  // via the standard price-cache TTL so every-15-min scans don't
  // re-fetch the same bars. The LLM-trader's prompt context uses these
  // for the DXY directional row (mirrors backtest harness); without
  // them the LLM has been seeing "DXY: n/a" since activation.
  let dxyBars: PriceBar[] | null = null;
  const wantsDxy =
    algo.rules.dxy_filter?.enabled || algo.rules.llm_trader?.enabled;
  if (wantsDxy) {
    dxyBars = await getCachedPrices("EUR/USD", "full", "1h");
    if (!dxyBars) {
      try {
        dxyBars = await fetchDailyPrices("EUR/USD", "full", "1h");
        savePricesToCache("EUR/USD", "full", dxyBars, "1h").catch(() => {});
      } catch {
        dxyBars = null;
      }
    }
  }

  // Intermarket series (silver / 10Y yield / VIX) for the LLM-trader's
  // prompt context. Three daily series, fetched ONCE per scan when
  // `llm_trader.enabled` and the algo's asset class is commodity (the
  // gold-shaped XAU/XAG ratio + yield/VIX context isn't meaningful for
  // forex). Each tryFetch catches its own failure so a single missing
  // series doesn't blank the whole intermarket block. Cost: ~3 OANDA /
  // Yahoo calls per scan — both unmetered providers, no Twelve Data
  // quota impact.
  let intermarket: {
    silver?: PriceBar[];
    yield10y?: PriceBar[];
    vix?: PriceBar[];
  } | null = null;
  if (algo.rules.llm_trader?.enabled && algo.rules.asset_class === "commodity") {
    const tryFetch = async (
      ticker: string
    ): Promise<PriceBar[] | undefined> => {
      try {
        let bars = await getCachedPrices(ticker, "full", "1day");
        if (!bars) {
          bars = await fetchDailyPrices(ticker, "full", "1day");
          savePricesToCache(ticker, "full", bars, "1day").catch(() => {});
        }
        return bars && bars.length > 0 ? bars : undefined;
      } catch {
        return undefined;
      }
    };
    const [silver, yield10y, vix] = await Promise.all([
      tryFetch("XAG/USD"),
      tryFetch("^TNX"),
      tryFetch("^VIX"),
    ]);
    intermarket = { silver, yield10y, vix };
  }

  for (const ticker of tickers) {
    await processTicker(
      supabase,
      userId,
      algo,
      ticker,
      positions,
      result,
      liveQuotes,
      interval,
      brokerCtx,
      dxyBars,
      intermarket,
      force
    );
  }

  await logActivity(supabase, userId, {
    algorithm_id: algo.id,
    event_type: "scan_completed",
    details: {
      tickers_scanned: result.tickers_scanned,
      positions_opened: result.positions_opened,
      positions_closed: result.positions_closed,
      positions_updated: result.positions_updated,
      errors_count: result.errors.length,
    },
  });

  // Re-evaluate pair quality only when something actually changed —
  // stats don't move on quiet scans, so paying for the query each hour
  // is wasted. Triggered after closes since that's when win/loss counts
  // shift (opens don't change realised stats until they close).
  if (result.positions_closed > 0) {
    const evals = await evaluateAndPrune(supabase, algo.id);
    for (const e of evals) {
      if (e.pruned && e.reason !== "already_paused") {
        await logActivity(supabase, userId, {
          algorithm_id: algo.id,
          event_type: "pair_auto_paused",
          ticker: e.ticker,
          details: {
            reason: e.reason,
            stats: e.stats,
          },
        });
      }
    }
    // Performance-drift detector — surface (and on severe drift, halt)
    // when recent live performance has decayed enough vs the backtested
    // baseline that the strategy's edge looks compromised. Drift halt
    // disables live_trading_enabled but lets open positions play out
    // (different from the DLL halt which force-closes everything).
    const algoRow = await supabase
      .from("algorithms")
      .select("backtest_results")
      .eq("id", algo.id)
      .single();
    const baseline = (algoRow.data?.backtest_results ?? null) as
      | import("@/types/algorithm").BacktestResults
      | null;
    const driftConfig = {
      ...DEFAULT_DRIFT_CONFIG,
      minLiveWrPct: algo.rules.drift?.min_live_wr_pct,
    };
    const drift = await detectDrift(supabase, algo.id, baseline, driftConfig);
    if (drift.severity !== "none") {
      await logActivity(supabase, userId, {
        algorithm_id: algo.id,
        event_type: drift.severity === "halt" ? "drift_halt" : "drift_warn",
        details: {
          severity: drift.severity,
          reason: drift.reason,
          recent: drift.recent,
          baseline: drift.baseline,
        },
      });
      if (drift.severity === "halt") {
        await executeDriftHalt(supabase, userId, algo.id, drift);
      }
    }
  }

  await supabase
    .from("algorithms")
    .update({ last_scanned_at: new Date().toISOString() })
    .eq("id", algo.id);

  return result;
}
