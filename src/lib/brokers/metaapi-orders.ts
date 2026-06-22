/**
 * MetaApi order placement + close — extracted from `brokers/metaapi.ts`
 * on 2026-06-22 (CB.H1 pass 13) so the order-side code (which is the
 * only path that throws on broker rejection) lives separately from the
 * read-side helpers (fetchPositions, fetchSnapshot, fetchSymbolSpec).
 */
import { REGION_HOSTS, type MetaApiRegion } from "./metaapi-base";

interface MarketOrderInput {
  symbol: string;
  volume: number;
  side: "buy" | "sell";
  stopLoss?: number;
  takeProfit?: number;
  comment?: string;
  /** Client-supplied id so we can correlate our paper position with the real fill. */
  clientId?: string;
}

interface MarketOrderResponse {
  numericCode?: number;
  stringCode?: string;
  message?: string;
  orderId?: string;
  positionId?: string;
  /** MetaApi sometimes nests details here on validation failures. */
  details?: unknown;
  error?: string;
}

/**
 * Place a market order. Returns the broker's order/position id on fill.
 * Throws on rejection so the caller can log + skip the paper position.
 */
export async function placeMarketOrder(
  token: string,
  accountId: string,
  region: MetaApiRegion,
  input: MarketOrderInput
): Promise<{ orderId: string; positionId: string }> {
  const host = REGION_HOSTS[region] ?? REGION_HOSTS.london;
  const url = `${host}/users/current/accounts/${encodeURIComponent(accountId)}/trade`;
  const body = {
    actionType: input.side === "buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
    symbol: input.symbol,
    volume: input.volume,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    comment: input.comment?.slice(0, 28) ?? undefined,
    clientId: input.clientId,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "auth-token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: MarketOrderResponse = {};
  try {
    data = text ? (JSON.parse(text) as MarketOrderResponse) : {};
  } catch {
    /* leave data empty */
  }
  if (!res.ok || (data.stringCode && data.stringCode !== "TRADE_RETCODE_DONE")) {
    const parts = [
      data.message,
      data.stringCode,
      data.error,
      data.details ? JSON.stringify(data.details).slice(0, 300) : null,
      `HTTP ${res.status}`,
    ].filter(Boolean);
    const detail = parts.join(" | ") || text.slice(0, 300) || "no body";
    const sentBody = JSON.stringify({ ...body, _note: "input echoed for diagnosis" }).slice(0, 300);
    throw new Error(`Order rejected: ${detail} :: sent ${sentBody}`);
  }
  if (!data.orderId || !data.positionId) {
    throw new Error("Order placed but broker returned no order/position id.");
  }
  return { orderId: data.orderId, positionId: data.positionId };
}

/**
 * Close an existing position by id (the value returned from placeMarketOrder).
 */
export async function closePosition(
  token: string,
  accountId: string,
  region: MetaApiRegion,
  positionId: string
): Promise<{ orderId: string }> {
  const host = REGION_HOSTS[region] ?? REGION_HOSTS.london;
  const url = `${host}/users/current/accounts/${encodeURIComponent(accountId)}/trade`;
  const body = { actionType: "POSITION_CLOSE_ID", positionId };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "auth-token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: MarketOrderResponse = {};
  try {
    data = text ? (JSON.parse(text) as MarketOrderResponse) : {};
  } catch {
    /* leave data empty */
  }
  if (!res.ok || (data.stringCode && data.stringCode !== "TRADE_RETCODE_DONE")) {
    const detail = data.message ?? data.stringCode ?? `HTTP ${res.status}`;
    throw new Error(`Close rejected: ${detail}`);
  }
  return { orderId: data.orderId ?? "" };
}
