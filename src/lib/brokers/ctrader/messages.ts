/**
 * Typed wrappers around the cTrader proto messages we actually send.
 *
 * The descriptor.json contains ~150 message types — we only use a
 * handful. These helpers encode the payload, push it through the
 * client, and decode the response, hiding the protobuf-reflection
 * boilerplate from the rest of the adapter.
 *
 * Payload type IDs come from ProtoOAPayloadType in
 * OpenApiModelMessages.proto:
 *   2100 PROTO_OA_APPLICATION_AUTH_REQ
 *   2101 PROTO_OA_APPLICATION_AUTH_RES
 *   2102 PROTO_OA_ACCOUNT_AUTH_REQ
 *   2103 PROTO_OA_ACCOUNT_AUTH_RES
 *   2106 PROTO_OA_NEW_ORDER_REQ
 *   2111 PROTO_OA_CLOSE_POSITION_REQ
 *   2116 PROTO_OA_SYMBOL_BY_ID_REQ
 *   2117 PROTO_OA_SYMBOL_BY_ID_RES
 *   2121 PROTO_OA_TRADER_REQ
 *   2122 PROTO_OA_TRADER_RES
 *   2124 PROTO_OA_RECONCILE_REQ
 *   2125 PROTO_OA_RECONCILE_RES
 *   2126 PROTO_OA_EXECUTION_EVENT
 *   2142 PROTO_OA_ERROR_RES
 */
import { lookupType } from "./proto/loader";
import type { CTraderClient, ProtoMessageDecoded } from "./client";

export const PT = {
  APPLICATION_AUTH_REQ: 2100,
  APPLICATION_AUTH_RES: 2101,
  ACCOUNT_AUTH_REQ: 2102,
  ACCOUNT_AUTH_RES: 2103,
  NEW_ORDER_REQ: 2106,
  CLOSE_POSITION_REQ: 2111,
  SYMBOL_BY_ID_REQ: 2116,
  SYMBOL_BY_ID_RES: 2117,
  TRADER_REQ: 2121,
  TRADER_RES: 2122,
  RECONCILE_REQ: 2124,
  RECONCILE_RES: 2125,
  EXECUTION_EVENT: 2126,
  ERROR_RES: 2142,
} as const;

function encode(typeName: string, body: Record<string, unknown>): Uint8Array {
  const T = lookupType(typeName);
  const err = T.verify(body);
  if (err) throw new Error(`cTrader encode ${typeName}: ${err}`);
  return T.encode(T.create(body)).finish();
}

function decodeAs<T>(typeName: string, raw: Uint8Array): T {
  return lookupType(typeName).decode(raw) as unknown as T;
}

/** Translate a PROTO_OA_ERROR_RES payload into a thrown Error so the
 *  caller doesn't have to special-case it everywhere. */
function throwIfError(decoded: ProtoMessageDecoded): void {
  if (decoded.payloadType !== PT.ERROR_RES) return;
  const err = decodeAs<{ errorCode?: string; description?: string }>(
    "ProtoOAErrorRes",
    decoded.payload
  );
  throw new Error(`cTrader ${err.errorCode ?? "ERROR"}: ${err.description ?? "no description"}`);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function applicationAuth(
  client: CTraderClient,
  clientId: string,
  clientSecret: string
): Promise<void> {
  const payload = encode("ProtoOAApplicationAuthReq", { clientId, clientSecret });
  const res = await client.send(PT.APPLICATION_AUTH_REQ, payload, {
    expectedRes: PT.APPLICATION_AUTH_RES,
  });
  throwIfError(res);
}

export async function accountAuth(
  client: CTraderClient,
  ctidTraderAccountId: number,
  accessToken: string
): Promise<void> {
  const payload = encode("ProtoOAAccountAuthReq", { ctidTraderAccountId, accessToken });
  const res = await client.send(PT.ACCOUNT_AUTH_REQ, payload, {
    expectedRes: PT.ACCOUNT_AUTH_RES,
  });
  throwIfError(res);
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

export interface CTraderPosition {
  positionId: number;
  tradeData: {
    symbolId: number;
    volume: number;
    tradeSide: number; // 1 = BUY, 2 = SELL
    openTimestamp?: number;
  };
  price: number;
  stopLoss?: number;
  takeProfit?: number;
  swap?: number;
  commission?: number;
}

export interface ReconcileResponse {
  ctidTraderAccountId: number;
  position: CTraderPosition[];
}

export async function reconcile(
  client: CTraderClient,
  ctidTraderAccountId: number
): Promise<ReconcileResponse> {
  const payload = encode("ProtoOAReconcileReq", { ctidTraderAccountId });
  const res = await client.send(PT.RECONCILE_REQ, payload, {
    expectedRes: PT.RECONCILE_RES,
  });
  return decodeAs<ReconcileResponse>("ProtoOAReconcileRes", res.payload);
}

export interface TraderResponse {
  ctidTraderAccountId: number;
  trader: {
    balance: number;
    equity?: number;
    leverageInCents?: number;
    depositAssetId?: number;
    swapFree?: boolean;
  };
}

export async function fetchTrader(
  client: CTraderClient,
  ctidTraderAccountId: number
): Promise<TraderResponse> {
  const payload = encode("ProtoOATraderReq", { ctidTraderAccountId });
  const res = await client.send(PT.TRADER_REQ, payload, { expectedRes: PT.TRADER_RES });
  return decodeAs<TraderResponse>("ProtoOATraderRes", res.payload);
}

export interface SymbolDetails {
  symbolId: number;
  digits: number;
  pipPosition: number;
  /** Min / max / step in cents (1/100 of a lot). cTrader uses int64 here
   *  to keep volume math integer-safe; convert to lots by dividing by 100. */
  minVolume: number;
  maxVolume: number;
  stepVolume: number;
  lotSize: number;
}

export interface SymbolByIdResponse {
  ctidTraderAccountId: number;
  symbol: SymbolDetails[];
}

export async function symbolById(
  client: CTraderClient,
  ctidTraderAccountId: number,
  symbolIds: number[]
): Promise<SymbolByIdResponse> {
  const payload = encode("ProtoOASymbolByIdReq", { ctidTraderAccountId, symbolId: symbolIds });
  const res = await client.send(PT.SYMBOL_BY_ID_REQ, payload, {
    expectedRes: PT.SYMBOL_BY_ID_RES,
  });
  return decodeAs<SymbolByIdResponse>("ProtoOASymbolByIdRes", res.payload);
}

// ---------------------------------------------------------------------------
// Trading
// ---------------------------------------------------------------------------

export interface NewOrderInput {
  ctidTraderAccountId: number;
  symbolId: number;
  /** TRADE_SIDE: 1 = BUY, 2 = SELL */
  tradeSide: 1 | 2;
  /** Volume in centi-lots (lots * 100). cTrader returns volumes as int64
   *  so we keep them integer everywhere to avoid float drift. */
  volume: number;
  stopLoss?: number;
  takeProfit?: number;
  comment?: string;
  /** Optional caller-supplied id for correlation in execution events. */
  label?: string;
}

/** Place a market order. The execution result arrives as a separate
 *  PROTO_OA_EXECUTION_EVENT — the caller listens for that in addition to
 *  the immediate response. */
export async function newMarketOrder(
  client: CTraderClient,
  input: NewOrderInput
): Promise<ProtoMessageDecoded> {
  const payload = encode("ProtoOANewOrderReq", {
    ctidTraderAccountId: input.ctidTraderAccountId,
    symbolId: input.symbolId,
    orderType: 1, // MARKET
    tradeSide: input.tradeSide,
    volume: input.volume,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    comment: input.comment,
    label: input.label,
  });
  const res = await client.send(PT.NEW_ORDER_REQ, payload, {
    expectedRes: PT.EXECUTION_EVENT,
  });
  throwIfError(res);
  return res;
}

/** Close (partially or fully) an open position. Volume in centi-lots. */
export async function closePosition(
  client: CTraderClient,
  ctidTraderAccountId: number,
  positionId: number,
  volume: number
): Promise<ProtoMessageDecoded> {
  const payload = encode("ProtoOAClosePositionReq", {
    ctidTraderAccountId,
    positionId,
    volume,
  });
  const res = await client.send(PT.CLOSE_POSITION_REQ, payload, {
    expectedRes: PT.EXECUTION_EVENT,
  });
  throwIfError(res);
  return res;
}
