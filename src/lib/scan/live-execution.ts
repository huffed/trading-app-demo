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
import {
  closePosition as metaClose,
  fetchPosition,
  fetchSymbolSpec,
  notionalToLots,
  placeMarketOrder,
  toBrokerSymbol,
  type MetaApiRegion,
} from "@/lib/brokers/metaapi";
import { notionalInUsd } from "@/lib/constants/markets";
import { checkDivergenceKill, haltAlgorithmForDivergence } from "./divergence";
import { logActivity } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface BrokerExecutionContext {
  connectionId: string;
  apiToken: string;
  accountId: string;
  region: MetaApiRegion;
}

/**
 * Resolve the broker context for an algorithm. Returns null if the algo
 * isn't set up for live trading (no connection, or live_trading_enabled
 * is false). Cached lookups would belong here in the future.
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
    .select("id, api_token, account_id, region, status, provider")
    .eq("id", algoBrokerId)
    .eq("user_id", userId)
    .single();
  if (!data || data.provider !== "metaapi" || data.status === "disabled") return null;
  return {
    connectionId: data.id as string,
    apiToken: data.api_token as string,
    accountId: data.account_id as string,
    region: (data.region as MetaApiRegion) ?? "london",
  };
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
  /** Lot-based sizing: pass the raw lot count so we don't round-trip through
   *  USD notional (which is wrong for JPY crosses where price is in JPY). */
  lots?: number;
  /** Optional cumulative divergence kill switch. Evaluated post-fill so the
   *  freshly-captured broker_fill_price contributes to the rolling average. */
  divergenceRule?: { max_avg_bps: number; window_trades: number };
}

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
    const spec = await fetchSymbolSpec(args.ctx.apiToken, args.ctx.accountId, args.ctx.region, ticker);
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
    // Intentionally omit clientId — MetaApi's regex rejects hex/UUID-shaped
    // ids and we already correlate via the orderId/positionId in the response.
    const placed = await placeMarketOrder(args.ctx.apiToken, args.ctx.accountId, args.ctx.region, {
      symbol: toBrokerSymbol(ticker),
      side: side === "long" ? "buy" : "sell",
      volume: lots,
      stopLoss: args.stopLossPrice,
      takeProfit: args.takeProfitPrice,
      comment: `qt:${algorithmId.slice(0, 8)}`,
    });
    // Best-effort: fetch the freshly-placed position to capture the real
    // broker fill price. The trade endpoint doesn't include it. Falls back
    // to our scan price if MetaApi 404s (rare race) so the column is never
    // null when broker_position_id is set.
    const realFill = await fetchPosition(
      args.ctx.apiToken,
      args.ctx.accountId,
      args.ctx.region,
      placed.positionId
    );
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
    await supabase
      .from("paper_positions")
      .update({ broker_error: msg })
      .eq("id", paperPositionId);
    await logActivity(supabase, userId, {
      algorithm_id: algorithmId,
      position_id: paperPositionId,
      event_type: "live_order_failed",
      ticker,
      details: { error: msg, side },
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
    const closed = await metaClose(
      args.ctx.apiToken,
      args.ctx.accountId,
      args.ctx.region,
      brokerPositionId
    );
    await supabase
      .from("paper_positions")
      .update({
        broker_close_id: closed.orderId,
        broker_close_price: args.closePrice,
        broker_error: null,
      })
      .eq("id", paperPositionId);
    await logActivity(supabase, userId, {
      algorithm_id: algorithmId,
      position_id: paperPositionId,
      event_type: "live_order_closed",
      ticker,
      details: { broker_position_id: brokerPositionId, broker_order_id: closed.orderId },
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
