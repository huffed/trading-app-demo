/**
 * MetaApi MT5 adapter — wraps the existing low-level metaapi.ts functions
 * and exposes them through the unified BrokerAdapter interface so the
 * scan engine + flatten path can dispatch by provider rather than
 * importing MetaApi directly.
 */
import {
  closePosition,
  describeMetaApiError,
  fetchAccountInfo,
  fetchPosition,
  fetchPositions,
  fetchSnapshot,
  fetchSymbolSpec as metaFetchSymbolSpec,
  placeMarketOrder,
  toBrokerSymbol,
  type MetaApiPosition,
  type MetaApiRegion,
} from "./metaapi";
import type {
  BrokerAdapter,
  BrokerConnection,
  BrokerPosition,
  MarketOrderInput,
  MarketOrderResult,
} from "./types";

function regionFor(conn: BrokerConnection): MetaApiRegion {
  return (conn.region as MetaApiRegion | null) ?? "london";
}

/** Translate MetaApi's MT5 position-type strings into the unified
 *  buy/sell shape used across the adapter layer. */
function adaptPosition(p: MetaApiPosition): BrokerPosition {
  return {
    id: p.id,
    symbol: p.symbol,
    side: p.type === "POSITION_TYPE_SELL" ? "sell" : "buy",
    volume: p.volume,
    openPrice: p.openPrice,
    currentPrice: p.currentPrice,
    profit: p.profit,
    swap: p.swap,
    commission: p.commission,
    time: p.time,
    stopLoss: p.stopLoss,
    takeProfit: p.takeProfit,
  };
}

export const metaApiMt5Adapter: BrokerAdapter = {
  provider: "metaapi",

  async fetchAccountInfo(conn) {
    return fetchAccountInfo(conn.api_token, conn.account_id, regionFor(conn));
  },

  async fetchPositions(conn) {
    const raw = await fetchPositions(conn.api_token, conn.account_id, regionFor(conn));
    return raw.map(adaptPosition);
  },

  async fetchPosition(conn, positionId) {
    const raw = await fetchPosition(conn.api_token, conn.account_id, regionFor(conn), positionId);
    return raw ? adaptPosition(raw) : null;
  },

  async fetchSnapshot(conn) {
    const snap = await fetchSnapshot(conn.api_token, conn.account_id, regionFor(conn));
    return {
      account: snap.account,
      positions: snap.positions.map(adaptPosition),
      fetched_at: snap.fetched_at,
    };
  },

  async fetchSymbolSpec(conn, appSymbol) {
    return metaFetchSymbolSpec(conn.api_token, conn.account_id, regionFor(conn), appSymbol);
  },

  async placeMarketOrder(conn, input: MarketOrderInput): Promise<MarketOrderResult> {
    return placeMarketOrder(conn.api_token, conn.account_id, regionFor(conn), {
      symbol: toBrokerSymbol(input.appSymbol),
      volume: input.volume,
      side: input.side,
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit,
      comment: input.comment,
      clientId: input.clientId,
    });
  },

  async closePosition(conn, positionId) {
    return closePosition(conn.api_token, conn.account_id, regionFor(conn), positionId);
  },

  describeError(err) {
    return describeMetaApiError(err);
  },
};
