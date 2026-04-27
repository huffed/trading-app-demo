"use server";

import { z } from "zod";
import { describeMetaApiError, fetchSnapshot } from "@/lib/brokers/metaapi";
import { createClient } from "@/lib/supabase/server";
import type {
  BrokerAccountSnapshot,
  BrokerConnection,
  BrokerConnectionView,
  BrokerPositionSummary,
} from "@/types/broker";

type ActionResult<T = unknown> = { success: true; data: T } | { success: false; error: string };

const inputSchema = z.object({
  label: z.string().trim().min(1).max(80),
  provider: z.enum(["metaapi", "alpaca", "oanda", "ctrader"]),
  api_token: z.string().trim().min(8),
  account_id: z.string().trim().min(8),
  region: z.enum(["london", "new-york", "singapore"]).optional().default("london"),
  broker_name: z.string().trim().max(80).optional(),
  server: z.string().trim().max(80).optional(),
  account_login: z.string().trim().max(40).optional(),
});

export type BrokerInput = z.infer<typeof inputSchema>;

async function getUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");
  return { supabase, user };
}

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
    const { supabase, user } = await getUser();
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

  try {
    const { supabase, user } = await getUser();
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
    const { supabase, user } = await getUser();
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

function summarizePositions(
  positions: import("@/lib/brokers/metaapi").MetaApiPosition[]
): BrokerPositionSummary[] {
  return positions.map((p) => ({
    id: String(p.id ?? ""),
    symbol: String(p.symbol ?? ""),
    side: String(p.type ?? "").toUpperCase().includes("SELL") ? "sell" : "buy",
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
    const { supabase, user } = await getUser();
    const { data: row, error: rowErr } = await supabase
      .from("broker_connections")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();
    if (rowErr || !row) return { success: false, error: "Broker connection not found." };

    const conn = row as BrokerConnection;
    if (conn.provider !== "metaapi") {
      return { success: false, error: `Provider ${conn.provider} is not yet supported.` };
    }

    try {
      const snap = await fetchSnapshot(conn.api_token, conn.account_id, conn.region);
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
        account_snapshot,
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
      const friendly = describeMetaApiError(apiErr);
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
