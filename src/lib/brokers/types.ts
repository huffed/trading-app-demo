/**
 * Broker abstraction — provider-agnostic interface for the live execution
 * layer. Each broker (MetaApi MT5, cTrader Open API, Alpaca, etc.) provides
 * an adapter that conforms to BrokerAdapter; the scan engine looks up the
 * right adapter via the registry based on broker_connections.provider.
 *
 * Design notes:
 *  - Symbols flow as APP form ("EUR/USD") — each adapter does its own
 *    broker-form translation internally so the call sites don't have to
 *    know which broker is on the other side.
 *  - Sides flow as "buy" / "sell" — neutral phrasing so neither MT5's
 *    POSITION_TYPE_BUY nor cTrader's directionalised proto enums leak.
 *  - Error description is part of the adapter so each provider can hide
 *    its own auth tokens / surface its own retry hints.
 */

export interface BrokerConnection {
  id: string;
  user_id: string;
  provider: string;
  api_token: string;
  account_id: string;
  region?: string | null;
  refresh_token?: string | null;
  token_expires_at?: string | null;
  account_login?: string | null;
  /** "live" / "demo" for cTrader (drives endpoint selection); MT5 uses
   *  this for the broker server name (e.g. "FTMO-Demo2"). */
  server?: string | null;
}

export interface BrokerAccountInfo {
  broker?: string;
  currency?: string;
  server?: string;
  balance: number;
  equity: number;
  margin?: number;
  freeMargin?: number;
  leverage?: number;
  name?: string;
  login?: string | number;
  type?: string;
  platform?: string;
}

export interface BrokerPosition {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  volume: number;
  openPrice: number;
  currentPrice?: number;
  profit: number;
  swap?: number;
  commission?: number;
  time?: string;
  stopLoss?: number;
  takeProfit?: number;
}

export interface BrokerSymbolSpec {
  /** Broker-form symbol — adapter-defined ("EURUSD" for MT5, etc.) */
  symbol: string;
  contractSize: number;
  volumeStep: number;
  minVolume: number;
  maxVolume: number;
  digits: number;
}

export interface BrokerSnapshot {
  account: BrokerAccountInfo;
  positions: BrokerPosition[];
  fetched_at: string;
}

export interface MarketOrderInput {
  /** App-form symbol, e.g. "EUR/USD". Adapter handles the broker-specific
   *  translation. */
  appSymbol: string;
  volume: number;
  side: "buy" | "sell";
  stopLoss?: number;
  takeProfit?: number;
  comment?: string;
  /** Caller-supplied id used to correlate paper position with broker fill. */
  clientId?: string;
}

export interface MarketOrderResult {
  orderId: string;
  positionId: string;
}

export interface BrokerAdapter {
  /** Provider tag this adapter handles, matches broker_connections.provider. */
  readonly provider: string;
  fetchAccountInfo(conn: BrokerConnection): Promise<BrokerAccountInfo>;
  fetchPositions(conn: BrokerConnection): Promise<BrokerPosition[]>;
  fetchPosition(conn: BrokerConnection, positionId: string): Promise<BrokerPosition | null>;
  fetchSnapshot(conn: BrokerConnection): Promise<BrokerSnapshot>;
  fetchSymbolSpec(conn: BrokerConnection, appSymbol: string): Promise<BrokerSymbolSpec>;
  placeMarketOrder(conn: BrokerConnection, input: MarketOrderInput): Promise<MarketOrderResult>;
  closePosition(conn: BrokerConnection, positionId: string): Promise<{ orderId: string }>;
  /** Sanitise raw provider errors for surfacing to the user. Must scrub
   *  any credentials before returning. */
  describeError(err: unknown): string;
}
