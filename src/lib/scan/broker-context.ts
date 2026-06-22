/**
 * Broker context resolution — looks up the broker_connections row + the
 * registered provider adapter for an algorithm. Returns null when live
 * trading is not configured / connection disabled / provider unregistered.
 *
 * Extracted from `scan/live-execution.ts` on 2026-06-22 (CB.H1 pass 8) so
 * the look-up can sit in a focused module instead of crowding the order-
 * placement file. `BrokerExecutionContext` lives here as it's the shape
 * the resolver produces; downstream callers import it from this module.
 */
import { getBrokerAdapter } from "@/lib/brokers/registry";
import type { BrokerAdapter, BrokerConnection } from "@/lib/brokers/types";
import { logger } from "@/lib/logger";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface BrokerExecutionContext {
  adapter: BrokerAdapter;
  conn: BrokerConnection;
}

/**
 * Resolve the broker context for an algorithm. Returns null if the algo
 * isn't set up for live trading, the connection is disabled, or the
 * provider has no registered adapter.
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
    .select(
      "id, user_id, provider, api_token, account_id, region, status, refresh_token, token_expires_at, account_login"
    )
    .eq("id", algoBrokerId)
    .eq("user_id", userId)
    .single();
  if (!data || data.status === "disabled") return null;
  const adapter = getBrokerAdapter(data.provider as string);
  if (!adapter) {
    // Live trading was requested but the registered provider has no adapter
    // — without a warning here the algorithm silently falls back to paper-
    // only and the operator wouldn't know.
    logger.warn(
      "live-execution",
      `live_trading_enabled but no adapter for provider="${data.provider}" (broker_connection_id=${algoBrokerId}). Falling back to paper-only.`
    );
    return null;
  }
  return { adapter, conn: data as BrokerConnection };
}
