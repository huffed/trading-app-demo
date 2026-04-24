"use server";

import { analyzeJournalEntry } from "@/lib/ai/analyze";
import { createClient } from "@/lib/supabase/server";
import { journalFormSchema, type JournalFormValues } from "@/lib/validators/journal";
import type { JournalEntry } from "@/types/journal";
import type { Trade } from "@/types/trade";
import type { SupabaseClient } from "@supabase/supabase-js";

type ActionResult<T = unknown> = { success: true; data: T } | { success: false; error: string };

async function triggerAnalysis(
  supabase: SupabaseClient,
  entry: JournalEntry
): Promise<JournalEntry> {
  let linkedTrades: Trade[] = [];
  if (entry.linked_trade_ids?.length > 0) {
    const { data: trades } = await supabase
      .from("trades")
      .select("*")
      .in("id", entry.linked_trade_ids);
    linkedTrades = (trades ?? []) as Trade[];
  }

  const analysis = await analyzeJournalEntry(entry, linkedTrades);
  const analyzedAt = new Date().toISOString();

  await supabase
    .from("journal_entries")
    .update({ ai_analysis: analysis, ai_analyzed_at: analyzedAt })
    .eq("id", entry.id);

  return { ...entry, ai_analysis: analysis, ai_analyzed_at: analyzedAt };
}

export async function createJournalEntry(values: JournalFormValues): Promise<ActionResult> {
  const parsed = journalFormSchema.safeParse(values);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  const { self_rating, ...rest } = parsed.data;

  const { data, error } = await supabase
    .from("journal_entries")
    .insert({
      ...rest,
      self_rating: self_rating === "" ? null : (self_rating ?? null),
      user_id: user.id,
    })
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  // AI analysis is best-effort — entry is saved regardless
  const analyzed = await triggerAnalysis(supabase, data as JournalEntry).catch(() => null);
  return { success: true, data: analyzed ?? data };
}

export async function updateJournalEntry(
  id: string,
  values: Partial<JournalFormValues>
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  const cleaned = Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, v === "" ? null : v])
  );

  const { data, error } = await supabase
    .from("journal_entries")
    .update(cleaned)
    .eq("id", id)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  const analyzed = await triggerAnalysis(supabase, data as JournalEntry).catch(() => null);
  return { success: true, data: analyzed ?? data };
}

export async function deleteJournalEntry(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  const { error } = await supabase
    .from("journal_entries")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) return { success: false, error: error.message };
  return { success: true, data: null };
}

export async function analyzeJournalEntryAction(entryId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  const { data: entry, error } = await supabase
    .from("journal_entries")
    .select("*")
    .eq("id", entryId)
    .eq("user_id", user.id)
    .single();

  if (error || !entry) {
    return { success: false, error: "Entry not found" };
  }

  try {
    const analyzed = await triggerAnalysis(supabase, entry as JournalEntry);
    return { success: true, data: analyzed };
  } catch {
    return { success: false, error: "Analysis unavailable. Please try again later." };
  }
}
