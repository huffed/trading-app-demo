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
import { logger } from "@/lib/logger";
// CB.H1 pass 13 (2026-06-22): shared region/host registry extracted to
// `metaapi-base.ts`; order placement+close extracted to `metaapi-orders.ts`.
import { REGION_HOSTS, type MetaApiRegion } from "./metaapi-base";
export { type MetaApiRegion } from "./metaapi-base";

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
  } catch (err) {
    // CB.M7.b (2026-06-20): warn-on-swallow — single-position fetch
    // failure silently treats position as missing; surface in logs so
    // a chain of failures doesn't go unnoticed.
    logger.warn("metaapi", `fetchPosition(${accountId}, ${positionId}) failed`, err);
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

// CB.H1 pass 13 (2026-06-22): order placement + close moved to
// `metaapi-orders.ts`. Re-exported for back-compat.
export { placeMarketOrder, closePosition } from "./metaapi-orders";

export interface MetaApiHistoryDeal {
  id: string;
  positionId: string;
  /** DEAL_TYPE_BUY / DEAL_TYPE_SELL — the side of the deal itself, not the
   *  parent position. A buy that opens a long has type=BUY entry=IN; the
   *  sell that closes that long has type=SELL entry=OUT. */
  type: string;
  /** DEAL_ENTRY_IN / DEAL_ENTRY_OUT — IN opens, OUT closes. */
  entryType: string;
  symbol: string;
  volume: number;
  price: number;
  profit: number;
  swap?: number;
  commission?: number;
  /** ISO timestamp when the deal printed. Use this as the position's
   *  closed_at when entryType=DEAL_ENTRY_OUT. */
  time: string;
}

/**
 * Fetch the deal history for a single broker position. Used to reconcile
 * paper positions when the broker closes a position outside our exit
 * logic — typically: operator manually clicked close in the broker UI.
 * Returns deals chronologically; the DEAL_ENTRY_OUT entry is the close.
 */
export async function fetchHistoryDealsForPosition(
  token: string,
  accountId: string,
  region: MetaApiRegion,
  positionId: string
): Promise<MetaApiHistoryDeal[]> {
  return call<MetaApiHistoryDeal[]>(
    region,
    token,
    accountId,
    `/history-deals/position/${encodeURIComponent(positionId)}`
  );
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
