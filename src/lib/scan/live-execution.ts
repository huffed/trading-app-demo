/**
 * Live broker execution layer. The scan engine still maintains paper
 * positions as the source of truth for analytics and prop-firm compliance;
 * this module mirrors entries and exits to a real broker connection so the
 * trader can run the same algorithm on a funded account.
 *
 * Placement is best-effort: if the broker rejects an order or the network
 * is down we log it and store the error on the paper position, but we DON'T
 * roll back the paper position — that would create a divergence between
 * reported algorithm performance and the user's broker statement they
 * can't reconcile later. Better to record both honestly.
 */
import { getBrokerAdapter } from "@/lib/brokers/registry";
import { notionalToLots } from "@/lib/brokers/sizing";
import type { BrokerAdapter, BrokerConnection } from "@/lib/brokers/types";
import { notionalInUsd } from "@/lib/constants/markets";
import { logger } from "@/lib/logger";
import { checkDivergenceKill, haltAlgorithmForDivergence } from "./divergence";
import { logActivity } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface BrokerExecutionContext {
  adapter: BrokerAdapter;
  conn: BrokerConnection;
}

/**
 * Resolve the broker context for an algorithm. Returns null if the algo
 * isn't set up for live trading, the connection is disabled, or the
 * provider has no registered adapter.
 */
export async function resolveBrokerContext(
  supabase: SupabaseClient,
  userId: string,
  algoBrokerId: string | null,
  liveEnabled: boolean
): Promise<BrokerExecutionContext | null> {
  if (!liveEnabled || !algoBrokerId) return null;
  const { data } = await supabase
    .from("broker_connections")
    .select(
      "id, user_id, provider, api_token, account_id, region, status, refresh_token, token_expires_at, account_login"
    )
    .eq("id", algoBrokerId)
    .eq("user_id", userId)
    .single();
  if (!data || data.status === "disabled") return null;
  const adapter = getBrokerAdapter(data.provider as string);
  if (!adapter) {
    // Live trading was requested but the registered provider has no adapter
    // — without a warning here the algorithm silently falls back to paper-
    // only and the operator wouldn't know.
    logger.warn(
      "live-execution",
      `live_trading_enabled but no adapter for provider="${data.provider}" (broker_connection_id=${algoBrokerId}). Falling back to paper-only.`
    );
    return null;
  }
  return { adapter, conn: data as BrokerConnection };
}

interface EntryArgs {
  supabase: SupabaseClient;
  userId: string;
  algorithmId: string;
  paperPositionId: string;
  ticker: string;
  side: "long" | "short";
  notionalUsd: number;
  currentPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  ctx: BrokerExecutionContext;
  /** Algorithm capital (used as the denominator for the leverage sanity
   *  check just before order placement). */
  capital: number;
  /** Lot-based sizing: pass the raw lot count so we don't round-trip through
   *  USD notional (which is wrong for JPY crosses where price is in JPY). */
  lots?: number;
  /** Optional cumulative divergence kill switch. Evaluated post-fill so the
   *  freshly-captured broker_fill_price contributes to the rolling average. */
  divergenceRule?: { max_avg_bps: number; window_trades: number };
}

/** Hard cap on notional/capital ratio. 30 corresponds to typical retail
 *  forex 30:1 leverage; FTMO allows up to 100:1 but our algos are sized
 *  for ~1:1 of capital so anything above 30:1 is almost certainly a
 *  sizing-math bug, not deliberate leverage. The CHF/JPY blow-up sat at
 *  ~67×; this gate would have caught it. */
const MAX_NOTIONAL_TO_CAPITAL = 30;

/** Halt the algorithm if the rolling-average broker fill divergence has
 *  crossed the configured threshold. No-op when the rule is absent. */
async function maybeHaltOnDivergence(
  supabase: SupabaseClient,
  userId: string,
  algorithmId: string,
  rule: EntryArgs["divergenceRule"]
): Promise<void> {
  if (!rule) return;
  const result = await checkDivergenceKill(supabase, algorithmId, rule);
  if (result.tripped) {
    await haltAlgorithmForDivergence(supabase, userId, algorithmId, result, rule);
  }
}

/**
 * Place a real market order to mirror a freshly-opened paper position.
 * Records broker_order_id, broker_position_id, and the actual fill price
 * back onto the paper_positions row. Logs success or failure to activity.
 */
export async function executeLiveEntry(args: EntryArgs): Promise<void> {
  const { supabase, userId, algorithmId, paperPositionId, ticker, side, notionalUsd } = args;
  try {
    const { adapter, conn } = args.ctx;
    const spec = await adapter.fetchSymbolSpec(conn, ticker);
    let lots: number;
    if (args.lots != null && args.lots > 0) {
      // Honour exact lot-sized algorithms — floor to broker volume step so a
      // backtest-validated size (e.g. 0.125) never gets nudged UP into a
      // higher-risk regime. Min-volume clamp prevents a 0 deployment.
      const stepped = Math.floor(args.lots / spec.volumeStep) * spec.volumeStep;
      lots = Number(
        Math.min(Math.max(stepped, spec.minVolume), spec.maxVolume).toFixed(4)
      );
    } else {
      lots = notionalToLots(notionalUsd, args.currentPrice, spec);
    }
    if (lots <= 0) {
      throw new Error(
        `Computed lot size 0 for ${ticker} — minVolume=${spec.minVolume}, notional=${notionalUsd}.`
      );
    }
    // Defense-in-depth sanity check: if the implied notional is more
    // than MAX_NOTIONAL_TO_CAPITAL × capital, refuse to place. The
    // catalog guard in markets.ts catches missing-meta sizing bugs;
    // this catches any OTHER way oversized math could slip through
    // (broker spec returning a contractSize 100× ours, divide-by-zero
    // recovery returning Infinity, etc.). Independent failure mode.
    const impliedNotional = notionalInUsd(ticker, lots, args.currentPrice);
    if (args.capital > 0 && impliedNotional / args.capital > MAX_NOTIONAL_TO_CAPITAL) {
      throw new Error(
        `Position-size sanity check failed: ${ticker} lots=${lots.toFixed(4)} → ` +
          `notional $${impliedNotional.toFixed(0)} = ${(impliedNotional / args.capital).toFixed(1)}× capital ` +
          `(cap ${MAX_NOTIONAL_TO_CAPITAL}×). Refusing to place — likely sizing-math bug.`
      );
    }
    // Intentionally omit clientId — MetaApi's regex rejects hex/UUID-shaped
    // ids and we already correlate via the orderId/positionId in the response.
    const placed = await adapter.placeMarketOrder(conn, {
      appSymbol: ticker,
      side: side === "long" ? "buy" : "sell",
      volume: lots,
      stopLoss: args.stopLossPrice,
      takeProfit: args.takeProfitPrice,
      comment: `qt:${algorithmId.slice(0, 8)}`,
    });
    // Best-effort: fetch the freshly-placed position to capture the real
    // broker fill price. The trade endpoint doesn't include it. Falls back
    // to our scan price if the adapter can't find it (rare race) so the
    // column is never null when broker_position_id is set.
    const realFill = await adapter.fetchPosition(conn, placed.positionId);
    const brokerFillPrice = realFill?.openPrice ?? args.currentPrice;
    // Re-align paper quantity + notional to what actually got placed. Broker
    // floors lots to volumeStep (e.g. 0.125 → 0.12 on FTMO MT5), so the
    // paper-side intent (12,500 base units) drifts ~4% above the broker's
    // real position (12,000) — leading to paper P&L that doesn't match
    // FTMO's reported P&L. Snap them to the broker's truth.
    const brokerQuantity = lots * spec.contractSize;
    const brokerNotional = notionalInUsd(ticker, lots, args.currentPrice);
    await supabase
      .from("paper_positions")
      .update({
        broker_order_id: placed.orderId,
        broker_position_id: placed.positionId,
        broker_fill_price: brokerFillPrice,
        quantity: brokerQuantity,
        notional_value: brokerNotional,
        broker_error: null,
      })
      .eq("id", paperPositionId);
    await logActivity(supabase, userId, {
      algorithm_id: algorithmId,
      position_id: paperPositionId,
      event_type: "live_order_placed",
      ticker,
      details: {
        broker_order_id: placed.orderId,
        broker_position_id: placed.positionId,
        volume: lots,
        side,
      },
    });

    // Cumulative divergence check (extracted for line-count budget).
    await maybeHaltOnDivergence(supabase, userId, algorithmId, args.divergenceRule);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Live order failed";
    // Roll back the paper position. Broker rejected the order, so there
    // is no real exposure — leaving the row open with status='open' lets
    // the manage cron treat it as a real position and eventually "trigger"
    // paper SL/TP hits against zero actual exposure (bug surfaced
    // 2026-05-18: Sat-00:00-UTC entry rejected MARKET_CLOSED, then
    // "stopped out" 2 days later for -$441 paper-only loss). Close
    // cleanly with zero P&L and the distinct broker_rejected exit reason
    // so analytics can identify these voids vs real exits (constraint
    // added in migration 00038).
    await supabase
      .from("paper_positions")
      .update({
        status: "closed",
        closed_at: new Date().toISOString(),
        exit_reason: "broker_rejected",
        realized_pnl: 0,
        broker_error: msg,
      })
      .eq("id", paperPositionId);
    await logActivity(supabase, userId, {
      algorithm_id: algorithmId,
      position_id: paperPositionId,
      event_type: "live_order_failed",
      ticker,
      details: { error: msg, side, voided: true },
    });
  }
}

interface ExitArgs {
  supabase: SupabaseClient;
  userId: string;
  algorithmId: string;
  paperPositionId: string;
  ticker: string;
  brokerPositionId: string | null;
  closePrice: number;
  ctx: BrokerExecutionContext;
}

export async function executeLiveExit(args: ExitArgs): Promise<void> {
  const { supabase, userId, algorithmId, paperPositionId, ticker, brokerPositionId } = args;
  if (!brokerPositionId) return; // Paper position never had a real counterpart.
  try {
    const { adapter, conn } = args.ctx;
    const closed = await adapter.closePosition(conn, brokerPositionId);

    // Best-effort: fetch the broker's actual close fill + realised P&L
    // (profit + swap + commission) so the row reflects the broker's
    // truth instead of our local closePrice. The deal record sometimes
    // lags the close call by <60s on MetaApi, so a null here is normal
    // — the deferred reconciliation pass in manage.ts will retry until
    // it lands and stamp `broker_realized_synced_at` on success.
    const dealFetcher = adapter.fetchClosedDealForPosition;
    const dealResult = dealFetcher
      ? await dealFetcher.call(adapter, conn, brokerPositionId).catch(() => null)
      : null;

    const update: Record<string, unknown> = {
      broker_close_id: closed.orderId,
      broker_error: null,
    };
    if (dealResult) {
      update.broker_close_price = dealResult.price;
      update.realized_pnl = dealResult.realizedPnl;
      update.broker_realized_synced_at = new Date().toISOString();
    } else {
      // Provisional — local closePrice is the best we have until the
      // deferred reconciliation pass picks this row up.
      update.broker_close_price = args.closePrice;
    }

    await supabase
      .from("paper_positions")
      .update(update)
      .eq("id", paperPositionId);
    await logActivity(supabase, userId, {
      algorithm_id: algorithmId,
      position_id: paperPositionId,
      event_type: "live_order_closed",
      ticker,
      details: {
        broker_position_id: brokerPositionId,
        broker_order_id: closed.orderId,
        broker_realized_synced: dealResult != null,
        broker_close_price: dealResult?.price ?? args.closePrice,
        broker_realized_pnl: dealResult?.realizedPnl ?? null,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Live close failed";
    await supabase
      .from("paper_positions")
      .update({ broker_error: msg })
      .eq("id", paperPositionId);
    await logActivity(supabase, userId, {
      algorithm_id: algorithmId,
      position_id: paperPositionId,
      event_type: "live_close_failed",
      ticker,
      details: { error: msg, broker_position_id: brokerPositionId },
    });
  }
}
