"use server";

import { clampRules } from "@/lib/algorithm/rules-post-process";
import type { SignalResult } from "@/lib/signals/evaluate-live";
import { algorithmFromRow, rulesFromRow, toJson } from "@/lib/supabase/row-mappers";
import { createClient } from "@/lib/supabase/server";
import { type ActionResult } from "@/lib/types/action-result";
import {
  algorithmUpdateSchema,
  type AlgorithmUpdate,
} from "@/lib/validators/algorithm";
import type { Algorithm, AlgorithmStatus } from "@/types/algorithm";

/** Source label for activity-log entries when an algo is updated. */
export type AlgorithmUpdateSource = "ui" | "api";

export async function updateAlgorithm(
  id: string,
  updates: AlgorithmUpdate,
  source: AlgorithmUpdateSource = "ui"
): Promise<ActionResult<Algorithm>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { success: false, error: "Not authenticated" };
  }

  // Recursive validation. Without this an LLM-emitted [EDIT_ALGORITHM]
  // marker could write a malformed rules blob — the type signature is
  // erased at runtime and the DB column is JSONB.
  const parsed = algorithmUpdateSchema.safeParse(updates);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "payload";
    return {
      success: false,
      error: `Invalid update at ${path}: ${issue?.message ?? "unknown"}`,
    };
  }
  const validated: AlgorithmUpdate = { ...parsed.data };

  // Need the prior state to (a) compute the diff for the audit log and
  // (b) supply time_horizon to clampRules when normalizing rule updates.
  const { data: current, error: fetchErr } = await supabase
    .from("algorithms")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();
  if (fetchErr || !current) {
    return { success: false, error: "Algorithm not found" };
  }

  if (validated.rules) {
    validated.rules = clampRules(
      validated.rules,
      (current.time_horizon as string) ?? ""
    );
  }

  const fieldsChanged: string[] = [];
  const before: Record<string, unknown> = {};
  for (const key of Object.keys(validated) as Array<keyof AlgorithmUpdate>) {
    const newVal = validated[key];
    const oldVal = (current as Record<string, unknown>)[key];
    if (JSON.stringify(newVal) !== JSON.stringify(oldVal)) {
      fieldsChanged.push(key);
      before[key] = oldVal ?? null;
    }
  }

  const { data, error } = await supabase
    .from("algorithms")
    .update(validated)
    .eq("id", id)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  if (fieldsChanged.length > 0) {
    const auditInsert = await supabase.from("algorithm_rule_changes").insert({
      user_id: user.id,
      algorithm_id: id,
      source,
      fields_changed: fieldsChanged,
      before: toJson(before),
      after: toJson(validated),
    });
    if (auditInsert.error) {
      // Audit failure is non-fatal — the update already landed. Surface
      // it in the server log so the operator can investigate, but don't
      // roll back the user's change.
      console.error("[updateAlgorithm] audit insert failed", auditInsert.error);
    }
  }

  return { success: true, data: algorithmFromRow(data) };
}

export async function deleteAlgorithm(id: string): Promise<ActionResult<null>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  const { error } = await supabase.from("algorithms").delete().eq("id", id).eq("user_id", user.id);

  if (error) return { success: false, error: error.message };
  return { success: true, data: null };
}

export async function updateAlgorithmStatus(
  id: string,
  status: AlgorithmStatus
): Promise<ActionResult<Algorithm>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  const { data, error } = await supabase
    .from("algorithms")
    .update({ status })
    .eq("id", id)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: algorithmFromRow(data) };
}

export async function runLiveSignal(
  algorithmId: string,
  ticker: string
): Promise<ActionResult<SignalResult>> {
  const { evaluateLiveSignal } = await import("@/lib/signals/evaluate-live");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { success: false, error: "Not authenticated" };
  }

  const { data: algo, error: algoErr } = await supabase
    .from("algorithms")
    .select("*")
    .eq("id", algorithmId)
    .eq("user_id", user.id)
    .single();
  if (algoErr || !algo) {
    return { success: false, error: "Algorithm not found" };
  }

  try {
    const result = await evaluateLiveSignal(rulesFromRow(algo.rules), ticker, algo.description ?? "");
    return { success: true, data: result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Signal evaluation failed";
    return { success: false, error: msg };
  }
}
