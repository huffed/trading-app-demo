"use server";

import { lookupTickerName } from "@/lib/market-data/finnhub";
import type { WatchlistAddedBy, WatchlistItem } from "@/types/watchlist";
import { getAuthedUser } from "./actions";

type ActionResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string };

export async function addWatchlistItem(
  algorithmId: string,
  ticker: string,
  name = "",
  addedBy: WatchlistAddedBy = "user",
  notes?: string
): Promise<ActionResult<WatchlistItem>> {
  const { supabase, user } = await getAuthedUser();
  const normalized = ticker.trim().toUpperCase();
  if (!normalized) {
    return { success: false, error: "Ticker is required" };
  }

  const resolvedName = name.trim() || await lookupTickerName(normalized);

  const { data, error } = await supabase
    .from("algorithm_watchlist")
    .insert({
      user_id: user.id,
      algorithm_id: algorithmId,
      ticker: normalized,
      name: resolvedName,
      added_by: addedBy,
      notes: notes ?? null,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return { success: false, error: `${normalized} is already in this watchlist` };
    }
    return { success: false, error: error.message };
  }
  return { success: true, data: data as WatchlistItem };
}

export async function bulkAddWatchlistItems(
  algorithmId: string,
  items: { symbol: string; name: string }[],
  addedBy: WatchlistAddedBy
): Promise<ActionResult<{ added: number; skipped: number }>> {
  const { supabase, user } = await getAuthedUser();

  const rows = items
    .filter((item) => item.symbol.trim())
    .map((item) => ({
      user_id: user.id,
      algorithm_id: algorithmId,
      ticker: item.symbol.trim().toUpperCase(),
      name: item.name.trim(),
      added_by: addedBy,
    }));

  if (rows.length === 0) {
    return { success: true, data: { added: 0, skipped: 0 } };
  }

  const { data, error } = await supabase
    .from("algorithm_watchlist")
    .upsert(rows, { onConflict: "algorithm_id,ticker", ignoreDuplicates: true })
    .select();

  if (error) {
    return { success: false, error: error.message };
  }

  const added = data?.length ?? 0;
  return { success: true, data: { added, skipped: rows.length - added } };
}

export async function removeWatchlistItem(
  id: string
): Promise<ActionResult<null>> {
  const { supabase, user } = await getAuthedUser();

  const { error } = await supabase
    .from("algorithm_watchlist")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    return { success: false, error: error.message };
  }
  return { success: true, data: null };
}
