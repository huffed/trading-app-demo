"use server";

import { z } from "zod";
import { getBrokerAdapter, listSupportedProviders } from "@/lib/brokers/registry";
import type { BrokerPosition } from "@/lib/brokers/types";
import { getAuthedUser } from "@/lib/supabase/get-authed-user";
import { brokerConnectionFromRow, toJson } from "@/lib/supabase/row-mappers";
import { type ActionResult } from "@/types/action-result";
import type {
  BrokerAccountSnapshot,
  BrokerConnection,
  BrokerConnectionView,
  BrokerPositionSummary,
} from "@/types/broker";

// Only providers with a registered adapter can be persisted. The
// BrokerProvider type still tracks aspirational providers (alpaca, oanda)
// so other code can refer to them, but accepting one here would create a
// connection that scan/live-execution silently no-ops on — paper-only
// trades while the user thinks they're live.
const inputSchema = z.object({
  label: z.string().trim().min(1).max(80),
  provider: z.enum(["metaapi", "ctrader"]),
  api_token: z.string().trim().min(8),
  account_id: z.string().trim().min(8),
  region: z.enum(["london", "new-york", "singapore"]).optional().default("london"),
  broker_name: z.string().trim().max(80).optional(),
  server: z.string().trim().max(80).optional(),
  account_login: z.string().trim().max(40).optional(),
});

export type BrokerInput = z.infer<typeof inputSchema>;

// CB.M7.b (2026-06-20): removed duplicate local `getUser()` helper. The
// canonical `getAuthedUser` (lib/supabase/get-authed-user) does the same
// thing and is used by all other actions in (dashboard)/.

/** Strip the api_token before returning rows to the client. */
function toView(row: BrokerConnection): BrokerConnectionView {
  return {
    id: row.id,
    label: row.label,
    provider: row.provider,
    account_id: row.account_id,
    region: row.region,
    broker_name: row.broker_name,
    server: row.server,
    account_login: row.account_login,
    status: row.status,
    last_error: row.last_error,
    last_synced_at: row.last_synced_at,
    account_snapshot: row.account_snapshot,
  };
}

export async function listBrokerConnections(): Promise<ActionResult<BrokerConnectionView[]>> {
  try {
    const { supabase, user } = await getAuthedUser();
    const { data, error } = await supabase
      .from("broker_connections")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    if (error) return { success: false, error: error.message };
    return { success: true, data: (data ?? []).map((r) => toView(r as BrokerConnection)) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to load brokers" };
  }
}

export async function saveBrokerConnection(input: BrokerInput): Promise<ActionResult<BrokerConnectionView>> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message };
  }

  // Defense-in-depth: even if the enum drifts from the registry, refuse to
  // persist a provider that has no live-execution adapter. The user would
  // see "active" status without ever seeing a broker fill.
  if (!getBrokerAdapter(parsed.data.provider)) {
    const supported = listSupportedProviders().join(", ");
    return {
      success: false,
      error: `Broker provider "${parsed.data.provider}" is not implemented. Supported: ${supported}.`,
    };
  }

  try {
    const { supabase, user } = await getAuthedUser();
    const { data, error } = await supabase
      .from("broker_connections")
      .insert({
        user_id: user.id,
        label: parsed.data.label,
        provider: parsed.data.provider,
        api_token: parsed.data.api_token,
        account_id: parsed.data.account_id,
        region: parsed.data.region,
        broker_name: parsed.data.broker_name ?? null,
        server: parsed.data.server ?? null,
        account_login: parsed.data.account_login ?? null,
        status: "pending",
      })
      .select()
      .single();
    if (error) {
      if (error.code === "23505") {
        return { success: false, error: "A connection with that label already exists." };
      }
      return { success: false, error: error.message };
    }
    return { success: true, data: toView(data as BrokerConnection) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to save broker" };
  }
}

export async function deleteBrokerConnection(id: string): Promise<ActionResult<null>> {
  try {
    const { supabase, user } = await getAuthedUser();
    const { error } = await supabase
      .from("broker_connections")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);
    if (error) return { success: false, error: error.message };
    return { success: true, data: null };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Delete failed" };
  }
}

function summarizePositions(positions: BrokerPosition[]): BrokerPositionSummary[] {
  return positions.map((p) => ({
    id: String(p.id ?? ""),
    symbol: String(p.symbol ?? ""),
    side: p.side,
    volume: Number(p.volume ?? 0),
    open_price: Number(p.openPrice ?? 0),
    current_price: p.currentPrice != null ? Number(p.currentPrice) : null,
    profit: Number(p.profit ?? 0),
    stop_loss: p.stopLoss != null ? Number(p.stopLoss) : null,
    take_profit: p.takeProfit != null ? Number(p.takeProfit) : null,
  }));
}

/**
 * Pull a fresh snapshot from the broker and persist it back to the row so
 * the dashboard can show the last-known state without re-hitting the API
 * on every page load.
 */
export async function syncBrokerConnection(
  id: string
): Promise<ActionResult<BrokerConnectionView>> {
  try {
    const { supabase, user } = await getAuthedUser();
    const { data: row, error: rowErr } = await supabase
      .from("broker_connections")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();
    if (rowErr || !row) return { success: false, error: "Broker connection not found." };

    // `conn` is the DB row shape (richer than the adapter's expected
    // BrokerConnection — has `broker_name`, `last_error`, etc.); the
    // adapter call below narrows via `brokerConnectionFromRow` at the
    // boundary. CB.H3.b (2026-06-20) replaced the prior
    // `conn as unknown as AdapterConn` double-cast.
    const conn = row as BrokerConnection;
    const adapter = getBrokerAdapter(conn.provider);
    if (!adapter) {
      return { success: false, error: `Provider ${conn.provider} has no adapter registered yet.` };
    }

    try {
      const snap = await adapter.fetchSnapshot(brokerConnectionFromRow(row));
      const account_snapshot: BrokerAccountSnapshot = {
        balance: Number(snap.account.balance ?? 0),
        equity: Number(snap.account.equity ?? 0),
        currency: snap.account.currency ?? "USD",
        leverage: snap.account.leverage,
        margin: snap.account.margin,
        free_margin: snap.account.freeMargin,
        position_count: snap.positions.length,
        positions: summarizePositions(snap.positions),
        fetched_at: snap.fetched_at,
      };
      const updates = {
        status: "active" as const,
        last_error: null,
        last_synced_at: snap.fetched_at,
        account_snapshot: toJson(account_snapshot),
        broker_name: conn.broker_name ?? snap.account.broker ?? null,
        server: conn.server ?? snap.account.server ?? null,
        account_login: conn.account_login ?? (snap.account.login ? String(snap.account.login) : null),
      };
      const { data: updated, error: upErr } = await supabase
        .from("broker_connections")
        .update(updates)
        .eq("id", id)
        .eq("user_id", user.id)
        .select()
        .single();
      if (upErr) return { success: false, error: upErr.message };
      return { success: true, data: toView(updated as BrokerConnection) };
    } catch (apiErr) {
      const friendly = adapter.describeError(apiErr);
      await supabase
        .from("broker_connections")
        .update({ status: "error", last_error: friendly })
        .eq("id", id)
        .eq("user_id", user.id);
      return { success: false, error: friendly };
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Sync failed",
    };
  }
}
