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

/**
 * Live bid/ask snapshot. Used by the pre-trade spread gate to refuse
 * orders when the broker's spread is wider than the symbol's typical
 * — i.e. illiquid moments where slippage will eat the edge.
 */
export interface BrokerQuote {
  /** Broker-form symbol. */
  symbol: string;
  bid: number;
  ask: number;
  /** ISO timestamp when the quote was sampled, when the adapter has it. */
  time?: string;
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

/**
 * Realised close of a broker position — used by the manage cron to
 * reconcile paper_positions when the broker closed a position outside
 * our exit logic (e.g. operator clicked close in the broker UI).
 */
export interface BrokerClosedDeal {
  /** Filled close price. */
  price: number;
  /** Net realised P&L (profit + swap + commission). */
  realizedPnl: number;
  /** ISO timestamp of the close. */
  closedAt: string;
}

export interface BrokerAdapter {
  /** Provider tag this adapter handles, matches broker_connections.provider. */
  readonly provider: string;
  fetchAccountInfo(conn: BrokerConnection): Promise<BrokerAccountInfo>;
  fetchPositions(conn: BrokerConnection): Promise<BrokerPosition[]>;
  fetchPosition(conn: BrokerConnection, positionId: string): Promise<BrokerPosition | null>;
  fetchSnapshot(conn: BrokerConnection): Promise<BrokerSnapshot>;
  fetchSymbolSpec(conn: BrokerConnection, appSymbol: string): Promise<BrokerSymbolSpec>;
  /**
   * Live bid/ask for the symbol — returns null when the adapter can't
   * surface a one-shot quote (e.g. cTrader exposes spots only as a
   * streaming subscription). Callers must treat null as "spread gate
   * unavailable for this broker" and fall back to non-quote gating.
   */
  fetchQuote(conn: BrokerConnection, appSymbol: string): Promise<BrokerQuote | null>;
  placeMarketOrder(conn: BrokerConnection, input: MarketOrderInput): Promise<MarketOrderResult>;
  closePosition(conn: BrokerConnection, positionId: string): Promise<{ orderId: string }>;
  /**
   * Look up the realised close of a position the broker no longer reports
   * as open. Returns null when the broker can't surface a close (cTrader
   * streams deals, no one-shot history endpoint) or when the position
   * isn't in the broker's history yet (typical lag <60s after manual
   * close). Treat null as "can't reconcile right now" — callers should
   * leave the paper position alone and try again on the next tick.
   */
  fetchClosedDealForPosition?(
    conn: BrokerConnection,
    positionId: string
  ): Promise<BrokerClosedDeal | null>;
  /** Sanitise raw provider errors for surfacing to the user. Must scrub
   *  any credentials before returning. */
  describeError(err: unknown): string;
}
