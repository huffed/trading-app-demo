"use server";

import type { TablesInsert } from "@/lib/supabase/database.types";
import { toUpdateRow } from "@/lib/supabase/row-mappers";
import { createClient } from "@/lib/supabase/server";
import { type ActionResult } from "@/lib/types/action-result";
import { tradeFormSchema, type TradeFormValues } from "@/lib/validators/trade";
import type { Trade } from "@/types/trade";

export async function createTrade(values: TradeFormValues): Promise<ActionResult<Trade>> {
  const parsed = tradeFormSchema.safeParse(values);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  const { exit_price, exit_date, strategy, notes, ...rest } = parsed.data;

  const { data, error } = await supabase
    .from("trades")
    .insert({
      ...rest,
      exit_price: exit_price === "" ? null : (exit_price ?? null),
      exit_date: exit_date === "" ? null : (exit_date ?? null),
      strategy: strategy === "" ? null : (strategy ?? null),
      notes: notes === "" ? null : (notes ?? null),
      user_id: user.id,
    })
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as Trade };
}

export async function updateTrade(
  id: string,
  values: Partial<TradeFormValues>
): Promise<ActionResult<Trade>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  // Clean empty strings to null
  const cleaned = Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, v === "" ? null : v])
  );

  const { data, error } = await supabase
    .from("trades")
    .update(toUpdateRow<"trades">(cleaned))
    .eq("id", id)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as Trade };
}

export async function deleteTrade(id: string): Promise<ActionResult<null>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  const { error } = await supabase.from("trades").delete().eq("id", id).eq("user_id", user.id);

  if (error) return { success: false, error: error.message };
  return { success: true, data: null };
}

export async function importTrades(
  rows: TradeFormValues[]
): Promise<ActionResult<{ imported: number; errors: string[] }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { success: false, error: "Not authenticated" };
  }

  const validRows: TablesInsert<"trades">[] = [];
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const parsed = tradeFormSchema.safeParse(rows[i]);
    if (!parsed.success) {
      errors.push(`Row ${i + 1}: ${parsed.error.issues[0].message}`);
      continue;
    }
    const { exit_price, exit_date, strategy, notes, ...rest } = parsed.data;
    validRows.push({
      ...rest,
      exit_price: exit_price === "" ? null : (exit_price ?? null),
      exit_date: exit_date === "" ? null : (exit_date ?? null),
      strategy: strategy === "" ? null : (strategy ?? null),
      notes: notes === "" ? null : (notes ?? null),
      user_id: user.id,
    });
  }

  if (validRows.length === 0) {
    return {
      success: false,
      error: errors.length > 0 ? errors.join("; ") : "No valid rows to import",
    };
  }

  const { error } = await supabase.from("trades").insert(validRows);

  if (error) return { success: false, error: error.message };
  return { success: true, data: { imported: validRows.length, errors } };
}
