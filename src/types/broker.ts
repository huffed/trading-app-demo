export type BrokerProvider = "metaapi" | "alpaca" | "oanda" | "ctrader";
export type BrokerStatus = "pending" | "active" | "error" | "disabled";
export type MetaApiRegion = "london" | "new-york" | "singapore";

export interface BrokerConnection {
  id: string;
  user_id: string;
  label: string;
  provider: BrokerProvider;
  /** MetaApi auth-token. NEVER render this back to the UI. */
  api_token: string;
  account_id: string;
  region: MetaApiRegion;
  broker_name: string | null;
  server: string | null;
  account_login: string | null;
  status: BrokerStatus;
  last_error: string | null;
  last_synced_at: string | null;
  account_snapshot: BrokerAccountSnapshot | null;
  created_at: string;
  updated_at: string;
}

/**
 * Public-safe view of a connection — strips the API token. This is what
 * the UI / hooks should consume.
 */
export interface BrokerConnectionView {
  id: string;
  label: string;
  provider: BrokerProvider;
  account_id: string;
  region: MetaApiRegion;
  broker_name: string | null;
  server: string | null;
  account_login: string | null;
  status: BrokerStatus;
  last_error: string | null;
  last_synced_at: string | null;
  account_snapshot: BrokerAccountSnapshot | null;
}

export interface BrokerAccountSnapshot {
  balance: number;
  equity: number;
  currency: string;
  leverage?: number;
  margin?: number;
  free_margin?: number;
  position_count: number;
  positions: BrokerPositionSummary[];
  fetched_at: string;
}

export interface BrokerPositionSummary {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  volume: number;
  open_price: number;
  current_price: number | null;
  profit: number;
  stop_loss: number | null;
  take_profit: number | null;
}

export interface BrokerConnectionInput {
  label: string;
  provider: BrokerProvider;
  api_token: string;
  account_id: string;
  region?: MetaApiRegion;
  broker_name?: string;
  server?: string;
  account_login?: string;
}
