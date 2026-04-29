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

/**
 * Fetch a single position by id. Used right after place_market_order to
 * capture the broker's actual fill price (which the trade endpoint doesn't
 * include in its response). Returns null if MetaApi can't find the position
 * — typical race: caller should fall back to "our price" if so.
 */
export async function fetchPosition(
  token: string,
  accountId: string,
  region: MetaApiRegion,
  positionId: string
): Promise<MetaApiPosition | null> {
  try {
    return await call<MetaApiPosition>(
      region,
      token,
      accountId,
      `/positions/${encodeURIComponent(positionId)}`
    );
  } catch {
    return null;
  }
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

export interface MetaApiCurrentPrice {
  symbol: string;
  bid: number;
  ask: number;
  time?: string;
  brokerTime?: string;
}

/**
 * Live bid/ask from MetaApi's current-price endpoint. Returned values are the
 * broker's actual quotes, including the live bid/ask gap — what the pre-trade
 * spread gate compares against the catalog typical to refuse bad-execution
 * moments before they become losing fills.
 */
export async function fetchCurrentPrice(
  token: string,
  accountId: string,
  region: MetaApiRegion,
  appSymbol: string
): Promise<MetaApiCurrentPrice> {
  const symbol = toBrokerSymbol(appSymbol);
  return call<MetaApiCurrentPrice>(
    region,
    token,
    accountId,
    `/symbols/${encodeURIComponent(symbol)}/current-price`
  );
}

// notionalToLots moved to ./sizing.ts so the scan engine can call it
// without importing a provider-specific module. Re-export here for
// backwards compat with any external callers.
export { notionalToLots } from "./sizing";

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
