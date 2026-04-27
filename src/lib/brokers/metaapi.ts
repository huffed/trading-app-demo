/**
 * Thin wrapper around MetaApi.cloud's REST endpoints. MetaApi bridges
 * MT4/MT5 brokers (FTMO, ICMarkets, OANDA, etc.) over a clean HTTP API
 * so we don't have to run an MT5 client ourselves.
 *
 * The user signs up at metaapi.cloud, provisions their MT5 account in
 * MetaApi's dashboard (uploading login/password/server there), and pastes
 * the resulting auth-token + account_id into our app. We never see the
 * raw MT5 credentials.
 */

export type MetaApiRegion = "london" | "new-york" | "singapore";

const REGION_HOSTS: Record<MetaApiRegion, string> = {
  london: "https://mt-client-api-v1.london.agiliumtrade.ai",
  "new-york": "https://mt-client-api-v1.new-york.agiliumtrade.ai",
  singapore: "https://mt-client-api-v1.singapore.agiliumtrade.ai",
};

export interface MetaApiAccountInfo {
  broker?: string;
  currency?: string;
  server?: string;
  balance: number;
  equity: number;
  margin?: number;
  freeMargin?: number;
  leverage?: number;
  name?: string;
  login?: number;
  type?: string;
  platform?: string;
}

export interface MetaApiPosition {
  id: string;
  symbol: string;
  type: string; // "POSITION_TYPE_BUY" | "POSITION_TYPE_SELL"
  volume: number; // lots
  openPrice: number;
  currentPrice?: number;
  profit: number;
  swap?: number;
  commission?: number;
  time?: string;
  stopLoss?: number;
  takeProfit?: number;
}

interface MetaApiError extends Error {
  status?: number;
}

function buildHeaders(token: string): HeadersInit {
  return {
    "auth-token": token,
    Accept: "application/json",
  };
}

async function call<T>(
  region: MetaApiRegion,
  token: string,
  accountId: string,
  path: string
): Promise<T> {
  const host = REGION_HOSTS[region] ?? REGION_HOSTS.london;
  const url = `${host}/users/current/accounts/${encodeURIComponent(accountId)}${path}`;
  const res = await fetch(url, { headers: buildHeaders(token) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err: MetaApiError = new Error(
      `MetaApi ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`
    );
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export async function fetchAccountInfo(
  token: string,
  accountId: string,
  region: MetaApiRegion = "london"
): Promise<MetaApiAccountInfo> {
  return call<MetaApiAccountInfo>(region, token, accountId, "/account-information");
}

export async function fetchPositions(
  token: string,
  accountId: string,
  region: MetaApiRegion = "london"
): Promise<MetaApiPosition[]> {
  return call<MetaApiPosition[]>(region, token, accountId, "/positions");
}

export interface MetaApiSnapshot {
  account: MetaApiAccountInfo;
  positions: MetaApiPosition[];
  fetched_at: string;
}

/**
 * Test the connection AND return a full snapshot in one shot. Used by the
 * settings page "Test connection" button and the account-display widget.
 */
export async function fetchSnapshot(
  token: string,
  accountId: string,
  region: MetaApiRegion = "london"
): Promise<MetaApiSnapshot> {
  const [account, positions] = await Promise.all([
    fetchAccountInfo(token, accountId, region),
    fetchPositions(token, accountId, region),
  ]);
  return { account, positions, fetched_at: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Trading endpoints (Phase B)
// ---------------------------------------------------------------------------

/**
 * Most MT5 brokers (FTMO included) use slash-less symbols: "EURUSD" not
 * "EUR/USD", "XAUUSD" not "XAU/USD". Our app stores the slash form for
 * display so we strip it on the way to the broker.
 */
export function toBrokerSymbol(appSymbol: string): string {
  return appSymbol.toUpperCase().replace(/\//g, "");
}

export interface MetaApiSymbolSpec {
  symbol: string;
  contractSize: number;
  volumeStep: number;
  minVolume: number;
  maxVolume: number;
  digits: number;
}

export async function fetchSymbolSpec(
  token: string,
  accountId: string,
  region: MetaApiRegion,
  appSymbol: string
): Promise<MetaApiSymbolSpec> {
  const symbol = toBrokerSymbol(appSymbol);
  return call<MetaApiSymbolSpec>(
    region,
    token,
    accountId,
    `/symbols/${encodeURIComponent(symbol)}/specification`
  );
}

/**
 * Convert a notional dollar amount to a broker lot size, respecting the
 * symbol's contractSize and volumeStep. For forex with contractSize=100k,
 * $1100 notional at price 1.27 = 1100 / (100000 * 1.27) ≈ 0.00866 → rounds
 * to 0.01 (the typical minVolume / volumeStep on MT5 brokers).
 */
export function notionalToLots(
  notionalUsd: number,
  currentPrice: number,
  spec: MetaApiSymbolSpec
): number {
  if (currentPrice <= 0 || spec.contractSize <= 0) return 0;
  const rawLots = notionalUsd / (spec.contractSize * currentPrice);
  const stepped = Math.round(rawLots / spec.volumeStep) * spec.volumeStep;
  const clamped = Math.min(Math.max(stepped, spec.minVolume), spec.maxVolume);
  // Avoid floating-point dust like 0.010000000000001
  return Number(clamped.toFixed(4));
}

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

/**
 * Translate raw provider errors into user-friendly strings. Avoids
 * surfacing the auth-token in any message that bubbles to the UI.
 */
export function describeMetaApiError(err: unknown): string {
  if (!(err instanceof Error)) return "MetaApi request failed.";
  const msg = err.message;
  if (/401|unauthor/i.test(msg)) return "MetaApi token rejected — check the token in your account.";
  if (/404/i.test(msg)) return "Account ID not found in MetaApi. Confirm it's deployed and active.";
  if (/timeout|fetch|ECONNREFUSED|ENOTFOUND/i.test(msg)) {
    return "Network error reaching MetaApi. Try again in a moment.";
  }
  if (/429/i.test(msg)) return "MetaApi rate limit hit. Wait a minute and retry.";
  return msg.replace(/auth-token[^\s]*/gi, "auth-token=***");
}
